import assert from 'node:assert/strict'
import type { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright'
import { attachConversationIdentity, type ConversationIdentityTracker } from '../src/chat-identity'

const selfUrl = 'https://www.douyin.com/aweme/v1/web/user/profile/self/'
const usersUrl = 'https://www.douyin.com/aweme/v1/web/im/user/info/?version_code=170400'
let browser: Browser
let page: Page
let tracker: ConversationIdentityTracker

before(async () => {
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  const executablePath =
    process.env.PLAYWRIGHT_BROWSER_PATH || (existsSync(chrome) ? chrome : undefined)
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
})

beforeEach(async () => {
  page = await browser.newPage()
  tracker = attachConversationIdentity(page)
})

afterEach(async () => {
  tracker.dispose()
  const emitter = page as unknown as EventEmitter
  for (const event of ['request', 'response', 'requestfailed'])
    assert.equal(emitter.listenerCount(event), 0)
  await page.close()
})

after(async () => {
  await browser?.close()
})

interface FixtureOptions {
  self?: unknown
  users?: unknown
  delay?: number
  status?: number
  abort?: boolean
  malformed?: boolean
}

// Every URL is intercepted, including the official-looking fixture paths. No real traffic is sent.
async function fixture(options: FixtureOptions = {}): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request()
    if (request.url() === 'http://identity-fixture.test/') {
      await route.fulfill({ contentType: 'text/html', body: '<main>Local identity fixture</main>' })
      return
    }
    if (!request.url().includes('/aweme/v1/web/')) {
      await route.abort()
      return
    }
    if (options.abort) {
      await route.abort()
      return
    }
    if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay))
    const body = request.url().includes('/profile/self/')
      ? { status_code: 0, user: options.self ?? { uid: '100' } }
      : { status_code: 0, data: options.users ?? [{ uid: '200', nickname: 'TwT' }] }
    await route.fulfill({
      status: options.status ?? 200,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST',
        'content-type': 'application/json',
      },
      body: options.malformed ? 'synthetic-private-body{' : JSON.stringify(body),
    })
  })
  await page.goto('http://identity-fixture.test/')
}

async function get(url = selfUrl): Promise<void> {
  await page.evaluate(async (url) => {
    await fetch(url).catch(() => {})
  }, url)
}

async function post(url = usersUrl): Promise<void> {
  await page.evaluate(async (url) => {
    await fetch(url, { method: 'POST' }).catch(() => {})
  }, url)
}

async function identities(): Promise<void> {
  await get()
  await post()
}

test('derives the official sorted private CID from public profile responses', async () => {
  await fixture()
  await identities()
  assert.equal(await tracker.expectedConversationId('TwT'), '0:1:100:200')
})

test('waits for identity responses already in progress', async () => {
  await fixture({ delay: 120 })
  const pending = identities()
  assert.equal(await tracker.expectedConversationId('TwT', 2000), '0:1:100:200')
  await pending
})

test('missing own identity fails closed', async () => {
  await fixture()
  await post()
  await assert.rejects(tracker.expectedConversationId('TwT', 80), /IDENTITY_UNCONFIRMED/)
})

test('missing target identity fails closed', async () => {
  await fixture()
  await identities()
  await assert.rejects(tracker.expectedConversationId('不存在', 80), /IDENTITY_UNCONFIRMED/)
})

test('two distinct UIDs with the same visible name are ambiguous', async () => {
  await fixture({
    users: [
      { uid: '200', nickname: 'TwT' },
      { uid: '300', nickname: 'TwT' },
    ],
  })
  await identities()
  await assert.rejects(tracker.expectedConversationId('TwT'), /IDENTITY_AMBIGUOUS/)
})

test('repeated profile observations for one UID do not create a second identity', async () => {
  await fixture()
  await identities()
  await post()
  assert.equal(await tracker.expectedConversationId('TwT'), '0:1:100:200')
})

test('NBSP is normalized while unicode nickname characters are preserved', async () => {
  await fixture({ users: [{ uid: '200', nickname: 'ᖰ•\u00a0֊\u00a0•ᖳ' }] })
  await identities()
  assert.equal(await tracker.expectedConversationId('ᖰ• ֊ •ᖳ'), '0:1:100:200')
})

test('a remark replaces the nickname exactly as the official search does', async () => {
  await fixture({ users: [{ uid: '200', nickname: 'TwT', remark_name: '好友备注' }] })
  await identities()
  assert.equal(await tracker.expectedConversationId('好友备注'), '0:1:100:200')
  await assert.rejects(tracker.expectedConversationId('TwT', 80), /IDENTITY_UNCONFIRMED/)
})

test('large string UIDs keep their precision and sort numerically', async () => {
  await fixture({
    self: { uid: '9007199254740997' },
    users: [{ uid: '9007199254740995', nickname: 'TwT' }],
  })
  await identities()
  assert.equal(await tracker.expectedConversationId('TwT'), '0:1:9007199254740995:9007199254740997')
})

for (const value of [Number.MAX_SAFE_INTEGER + 2, 1.5, 0, -1, 'not-a-uid']) {
  test(`invalid or unsafe UID ${typeof value} cannot authorize sending`, async () => {
    await fixture({ users: [{ uid: value, nickname: 'TwT' }] })
    await identities()
    await assert.rejects(tracker.expectedConversationId('TwT'), /IDENTITY_INVALID/)
  })
}

test('an unsafe own UID also fails closed', async () => {
  await fixture({ self: { uid: Number.MAX_SAFE_INTEGER + 2 } })
  await identities()
  await assert.rejects(tracker.expectedConversationId('TwT'), /IDENTITY_INVALID/)
})

test('does not authorize a partial name index while a duplicate profile response is pending', async () => {
  await fixture()
  await identities()
  await page.route(usersUrl, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 120))
    await route.fulfill({
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ status_code: 0, data: [{ uid: '300', nickname: 'TwT' }] }),
    })
  })
  const requestStarted = page.waitForEvent('request', (request) => request.url() === usersUrl)
  const pending = post()
  await requestStarted
  await assert.rejects(tracker.expectedConversationId('TwT', 2000), /IDENTITY_AMBIGUOUS/)
  await pending
})

test('self chat cannot be mistaken for the target friend', async () => {
  await fixture({ users: [{ uid: '100', nickname: 'TwT' }] })
  await identities()
  await assert.rejects(tracker.expectedConversationId('TwT'), /IDENTITY_INVALID/)
})

test('lookalike or other official origins cannot supply identities', async () => {
  await fixture()
  await get(selfUrl.replace('www.douyin.com', 'www.douyin.com.invalid'))
  await post(usersUrl.replace('www.douyin.com', 'imapi.douyin.com'))
  await assert.rejects(tracker.expectedConversationId('TwT', 80), /IDENTITY_UNCONFIRMED/)
})

for (const options of [{ status: 503 }, { abort: true }, { malformed: true }]) {
  test('failed public identity responses fail closed without including their bodies', async () => {
    await fixture(options)
    await identities()
    await assert.rejects(tracker.expectedConversationId('TwT'), (error: Error) => {
      assert.match(error.message, /IDENTITY_INVALID/)
      assert.doesNotMatch(error.message, /synthetic|900719|TwT/)
      return true
    })
  })
}

test('disposing the tracker rejects a pending wait and removes its listeners', async () => {
  await fixture()
  const pending = tracker.expectedConversationId('TwT', 2000)
  tracker.dispose()
  await assert.rejects(pending, /IDENTITY_INVALID/)
})
