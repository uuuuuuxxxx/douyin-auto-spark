import assert from 'node:assert/strict'
import type { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright'
import { confirmMessageSend, type SendConfirmationOptions } from '../src/send-confirmation'

const endpoint = 'https://imapi.douyin.com/v1/message/send'
const sequenceId = 9007199254740997n
const serverMessageId = 9223372036854775000n
const clientId = 'fixture-client-id'
const conversationId = 'fixture-conversation-id'
const expectedText = '[猪头]'
let browser: Browser
let page: Page
let actionCalls = 0

before(async () => {
  const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  const executablePath =
    process.env.PLAYWRIGHT_BROWSER_PATH || (existsSync(localChrome) ? localChrome : undefined)
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  })
})

beforeEach(async () => {
  page = await browser.newPage()
  actionCalls = 0
})

afterEach(async () => {
  assert.ok(actionCalls <= 1, 'the confirmation helper must never repeat the action')
  const emitter = page as unknown as EventEmitter
  assert.equal(emitter.listenerCount('request'), 0)
  assert.equal(emitter.listenerCount('response'), 0)
  assert.equal(emitter.listenerCount('requestfailed'), 0)
  await page.close()
})

after(async () => {
  await browser?.close()
})

// Independent fixture encoder. All traffic is intercepted; no real site or credentials are used.
function varint(value: bigint): Buffer {
  const bytes: number[] = []
  do {
    const part = Number(value & 127n)
    value >>= 7n
    bytes.push(part | (value > 0n ? 128 : 0))
  } while (value > 0n)
  return Buffer.from(bytes)
}

function integer(field: number, value: bigint): Buffer {
  return Buffer.concat([varint(BigInt(field * 8)), varint(value)])
}

function bytes(field: number, value: Buffer | string): Buffer {
  const data = typeof value === 'string' ? Buffer.from(value) : value
  return Buffer.concat([varint(BigInt(field * 8 + 2)), varint(BigInt(data.length)), data])
}

function requestBody(
  overrides: {
    command?: bigint
    sequence?: bigint
    conversation?: string
    client?: string
    content?: string
    messageType?: bigint
  } = {},
): Buffer {
  const message = Buffer.concat([
    bytes(1, overrides.conversation ?? conversationId),
    bytes(4, overrides.content ?? JSON.stringify({ aweType: 700, type: 0, text: expectedText })),
    integer(6, overrides.messageType ?? 7n),
    bytes(7, 'synthetic-ticket-never-log'),
    bytes(8, overrides.client ?? clientId),
  ])
  return Buffer.concat([
    integer(1, overrides.command ?? 100n),
    integer(2, overrides.sequence ?? sequenceId),
    bytes(4, 'synthetic-token-never-log'),
    bytes(8, bytes(100, message)),
  ])
}

function acknowledgement(
  overrides: {
    command?: bigint
    sequence?: bigint
    outerStatus?: bigint
    innerStatus?: bigint
    serverId?: bigint
    client?: string
    async?: boolean
    omitZeroStatuses?: boolean
    omitBody?: boolean
  } = {},
): Buffer {
  const message = Buffer.concat([
    integer(1, overrides.serverId ?? serverMessageId),
    ...(overrides.omitZeroStatuses ? [] : [integer(3, overrides.innerStatus ?? 0n)]),
    bytes(4, overrides.client ?? clientId),
    ...(overrides.async ? [integer(8, 1n)] : []),
  ])
  return Buffer.concat([
    integer(1, overrides.command ?? 100n),
    integer(2, overrides.sequence ?? sequenceId),
    ...(overrides.omitZeroStatuses ? [] : [integer(3, overrides.outerStatus ?? 0n)]),
    ...(overrides.omitBody ? [] : [bytes(6, bytes(100, message))]),
  ])
}

async function fixture(
  response = acknowledgement(),
  options: { delay?: number; status?: number; abort?: boolean } = {},
): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request()
    if (request.url() === 'http://send-fixture.test/') {
      await route.fulfill({ contentType: 'text/html', body: '<main>Local protocol fixture</main>' })
      return
    }
    if (request.url() !== endpoint) {
      await route.abort()
      return
    }
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'content-type': 'application/x-protobuf',
    }
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers })
      return
    }
    if (options.abort) {
      await route.abort()
      return
    }
    if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay))
    await route.fulfill({ status: options.status ?? 200, headers, body: response })
  })
  await page.goto('http://send-fixture.test/')
}

async function post(payload: Buffer): Promise<void> {
  await page.evaluate(
    async ({ endpoint, payload }) => {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-protobuf' },
        body: new Uint8Array(payload),
      })
        .then((response) => response.arrayBuffer())
        .catch(() => {})
    },
    { endpoint, payload: [...payload] },
  )
}

function submit(payload = requestBody()): () => Promise<void> {
  return async () => {
    actionCalls += 1
    await post(payload)
  }
}

const options = { expectedText, expectedConversationId: conversationId, timeout: 1000 }

test('matching acknowledgement preserves int64 IDs beyond Number precision', async () => {
  await fixture()
  assert.deepEqual(await confirmMessageSend(page, submit(), options), {
    serverMessageId: serverMessageId.toString(),
  })
  assert.equal(actionCalls, 1)
})

test('protobuf default zero statuses are accepted only with matching IDs and a server message', async () => {
  await fixture(acknowledgement({ omitZeroStatuses: true }))
  assert.equal(
    (await confirmMessageSend(page, submit(), options)).serverMessageId,
    serverMessageId.toString(),
  )
})

test('a delayed acknowledgement is awaited after the UI action completes', async () => {
  await fixture(acknowledgement(), { delay: 120 })
  const start = Date.now()
  await confirmMessageSend(
    page,
    async () => {
      actionCalls += 1
      void post(requestBody()).catch(() => {})
    },
    options,
  )
  assert.ok(Date.now() - start >= 100)
  assert.equal(actionCalls, 1)
})

for (const [name, response, expectedError] of [
  ['outer rejection', acknowledgement({ outerStatus: 7n }), /DOUYIN_SEND_REJECTED/],
  ['message rejection', acknowledgement({ innerStatus: 3n }), /DOUYIN_SEND_REJECTED/],
  ['only visible to self', acknowledgement({ innerStatus: 4n }), /DOUYIN_SEND_SELF_VISIBLE/],
  ['asynchronous pending', acknowledgement({ async: true }), /DOUYIN_SEND_ASYNC_PENDING/],
  ['wrong response command', acknowledgement({ command: 500n }), /DOUYIN_SEND_ACK_MISMATCH/],
  ['wrong sequence', acknowledgement({ sequence: sequenceId + 1n }), /DOUYIN_SEND_ACK_MISMATCH/],
  ['wrong client ID', acknowledgement({ client: 'another-client' }), /DOUYIN_SEND_ACK_MISMATCH/],
  ['zero server ID', acknowledgement({ serverId: 0n }), /DOUYIN_SEND_PROTOCOL_ERROR/],
  ['missing response body', acknowledgement({ omitBody: true }), /DOUYIN_SEND_PROTOCOL_ERROR/],
  ['truncated protobuf', acknowledgement().subarray(0, -1), /DOUYIN_SEND_PROTOCOL_ERROR/],
] as const) {
  test(`${name} cannot become a successful send or trigger a retry`, async () => {
    await fixture(response)
    await assert.rejects(confirmMessageSend(page, submit(), options), expectedError)
    assert.equal(actionCalls, 1)
  })
}

for (const [name, payload] of [
  ['different text', requestBody({ content: JSON.stringify({ text: 'unrelated' }) })],
  [
    'text on a nested JSON path',
    requestBody({ content: JSON.stringify({ content: { text: expectedText } }) }),
  ],
  ['different conversation', requestBody({ conversation: 'another-conversation' })],
  ['different message type', requestBody({ messageType: 5n })],
  ['different command', requestBody({ command: 200n })],
] as const) {
  test(`${name} is ignored and cannot satisfy confirmation`, async () => {
    await fixture()
    await assert.rejects(
      confirmMessageSend(page, submit(payload), { ...options, timeout: 100 }),
      /DOUYIN_SEND_UNCONFIRMED/,
    )
    assert.equal(actionCalls, 1)
  })
}

test('unrelated traffic followed by the intended request does not steal its acknowledgement', async () => {
  await fixture()
  assert.equal(
    (
      await confirmMessageSend(
        page,
        async () => {
          actionCalls += 1
          await post(requestBody({ content: JSON.stringify({ text: 'unrelated' }) }))
          await post(requestBody())
        },
        options,
      )
    ).serverMessageId,
    serverMessageId.toString(),
  )
})

test('another conversation with identical text and a successful ACK cannot confirm the target send', async () => {
  await fixture(acknowledgement())
  await assert.rejects(
    confirmMessageSend(page, submit(), {
      ...options,
      expectedConversationId: 'intended-other-conversation',
      timeout: 100,
    }),
    /DOUYIN_SEND_UNCONFIRMED/,
  )
  assert.equal(actionCalls, 1)
})

test('a UI action with no network acknowledgement times out without retrying', async () => {
  await fixture()
  await assert.rejects(
    confirmMessageSend(
      page,
      async () => {
        actionCalls += 1
      },
      { ...options, timeout: 50 },
    ),
    /DOUYIN_SEND_UNCONFIRMED/,
  )
})

test('an acknowledgement arriving after the deadline cannot turn the timeout into success', async () => {
  await fixture(acknowledgement(), { delay: 150 })
  await assert.rejects(
    confirmMessageSend(page, submit(), { ...options, timeout: 50 }),
    /DOUYIN_SEND_UNCONFIRMED/,
  )
  assert.equal(actionCalls, 1)
})

test('HTTP failure cannot be mistaken for a successful protobuf body', async () => {
  await fixture(acknowledgement(), { status: 503 })
  await assert.rejects(confirmMessageSend(page, submit(), options), /DOUYIN_SEND_NETWORK_FAILED/)
})

test('network failure is reported without resending', async () => {
  await fixture(acknowledgement(), { abort: true })
  await assert.rejects(confirmMessageSend(page, submit(), options), /DOUYIN_SEND_NETWORK_FAILED/)
})

for (const [name, payload] of [
  ['truncated request', requestBody().subarray(0, -1)],
  ['invalid content JSON', requestBody({ content: 'synthetic-token-never-log{' })],
  ['overflowing varint', Buffer.from([8, 255, 255, 255, 255, 255, 255, 255, 255, 255, 2])],
  ['unterminated varint', Buffer.from([8, 128])],
  ['out-of-bounds length', Buffer.from([66, 255, 127])],
  ['invalid field zero', Buffer.from([0, 0])],
  ['unsupported wire group', Buffer.from([11])],
  ['duplicate command', Buffer.concat([requestBody(), integer(1, 100n)])],
  [
    'wrong command wire type',
    Buffer.concat([bytes(1, '100'), bytes(8, bytes(100, Buffer.alloc(0)))]),
  ],
  ['truncated fixed64', Buffer.from([9, 1, 2, 3])],
] as const) {
  test(`${name} fails safely and never includes payload or credentials in its error`, async () => {
    await fixture()
    await assert.rejects(confirmMessageSend(page, submit(payload), options), (error: Error) => {
      assert.match(error.message, /DOUYIN_SEND_PROTOCOL_ERROR/)
      assert.doesNotMatch(error.message, /synthetic|fixture-client|fixture-conversation/)
      return true
    })
  })
}

test('a status field with the wrong wire type cannot default to success', async () => {
  const invalidStatus = Buffer.concat([
    integer(1, 100n),
    integer(2, sequenceId),
    Buffer.from([29, 0, 0, 0, 0]), // Field 3 has fixed32 wire type instead of int32 varint.
    bytes(6, bytes(100, Buffer.concat([integer(1, serverMessageId), bytes(4, clientId)]))),
  ])
  await fixture(invalidStatus)
  await assert.rejects(confirmMessageSend(page, submit(), options), /DOUYIN_SEND_PROTOCOL_ERROR/)
})

test('action errors clean up listeners without causing a second submission', async () => {
  await fixture()
  await assert.rejects(
    confirmMessageSend(
      page,
      async () => {
        actionCalls += 1
        throw new Error('fixture UI failed')
      },
      options,
    ),
    /fixture UI failed/,
  )
})

test('invalid options fail before performing the UI action', async () => {
  await assert.rejects(
    confirmMessageSend(page, submit(), { ...options, timeout: Number.NaN }),
    /DOUYIN_SEND_INVALID_OPTIONS/,
  )
  assert.equal(actionCalls, 0)
})

for (const [name, invalidOptions] of [
  ['omitted conversation ID', { expectedText, timeout: 100 }],
  ['empty conversation ID', { ...options, expectedConversationId: '' }],
  ['whitespace conversation ID', { ...options, expectedConversationId: '   ' }],
  ['numeric conversation ID', { ...options, expectedConversationId: 123 }],
] as const) {
  test(`${name} is rejected before calling the action`, async () => {
    await assert.rejects(
      confirmMessageSend(page, submit(), invalidOptions as SendConfirmationOptions),
      /DOUYIN_SEND_INVALID_OPTIONS/,
    )
    assert.equal(actionCalls, 0)
  })
}
