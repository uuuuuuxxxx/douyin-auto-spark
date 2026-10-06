import type { Page, Request, Response } from 'playwright'

const SEND_ENDPOINT = 'https://imapi.douyin.com/v1/message/send'
const SEND_COMMAND = 100n
const TEXT_MESSAGE_TYPE = 7n
const MAX_PACKET_BYTES = 2 * 1024 * 1024
const MAX_SIGNED_INT64 = (1n << 63n) - 1n
const utf8 = new TextDecoder('utf-8', { fatal: true })

type WireValue = bigint | Uint8Array

function protocolError(): Error {
  return new Error('[DOUYIN_SEND_PROTOCOL_ERROR] 无法验证发送协议，请勿自动重发')
}

/** Decode only the public protocol fields needed for acknowledgement; never decode credentials. */
function fields(
  bytes: Uint8Array,
  visit: (field: number, value: WireValue, wire: number) => void,
): void {
  if (bytes.length > MAX_PACKET_BYTES) throw protocolError()
  let position = 0
  const varint = (): bigint => {
    let value = 0n
    for (let index = 0; index < 10; index += 1) {
      if (position >= bytes.length) throw protocolError()
      const byte = bytes[position++]!
      if (index === 9 && byte > 1) throw protocolError()
      value |= BigInt(byte & 127) << BigInt(index * 7)
      if (byte < 128) return value
    }
    throw protocolError()
  }
  while (position < bytes.length) {
    const tag = varint()
    const field = tag >> 3n
    if (field === 0n || field > 536870911n) throw protocolError()
    const wire = Number(tag & 7n)
    if (wire === 0) {
      visit(Number(field), varint(), wire)
    } else if (wire === 2) {
      const length = varint()
      if (length > BigInt(bytes.length - position)) throw protocolError()
      const end = position + Number(length)
      visit(Number(field), bytes.subarray(position, end), wire)
      position = end
    } else if (wire === 1 || wire === 5) {
      const end = position + (wire === 1 ? 8 : 4)
      if (end > bytes.length) throw protocolError()
      visit(Number(field), bytes.subarray(position, end), wire)
      position = end
    } else {
      throw protocolError()
    }
  }
}

function select(
  bytes: Uint8Array,
  wanted: readonly number[],
  integers: readonly number[] = [],
): Map<number, WireValue> {
  const selected = new Map<number, WireValue>()
  fields(bytes, (field, value, wire) => {
    if (!wanted.includes(field)) return
    if (wire !== (integers.includes(field) ? 0 : 2) || selected.has(field)) throw protocolError()
    selected.set(field, value)
  })
  return selected
}

function integer(value: WireValue | undefined, defaultValue?: bigint): bigint {
  if (value === undefined && defaultValue !== undefined) return defaultValue
  if (typeof value !== 'bigint') throw protocolError()
  return value
}

function buffer(value: WireValue | undefined): Uint8Array {
  if (!(value instanceof Uint8Array)) throw protocolError()
  return value
}

function string(value: WireValue | undefined): string {
  return utf8.decode(buffer(value))
}

interface SendRequest {
  sequenceId: bigint
  conversationId: string
  clientId: string
  messageType: bigint
  text: unknown
}

function decodeRequest(bytes: Uint8Array): SendRequest | undefined {
  // Request: cmd=1, sequence_id=2, body=8. RequestBody: send_message_body=100.
  const envelope = select(bytes, [1, 2, 8], [1, 2])
  if (integer(envelope.get(1)) !== SEND_COMMAND) return undefined
  const sequenceId = integer(envelope.get(2))
  if (sequenceId <= 0n || sequenceId > MAX_SIGNED_INT64) throw protocolError()
  const body = select(buffer(envelope.get(8)), [100])
  const message = select(buffer(body.get(100)), [1, 4, 6, 8], [6])
  const conversationId = string(message.get(1))
  const clientId = string(message.get(8))
  if (!conversationId || !clientId) throw protocolError()
  const content: unknown = JSON.parse(string(message.get(4)))
  return {
    sequenceId,
    conversationId,
    clientId,
    messageType: integer(message.get(6)),
    text:
      typeof content === 'object' && content !== null && 'text' in content
        ? content.text
        : undefined,
  }
}

function decodeAcknowledgement(bytes: Uint8Array, request: SendRequest): string {
  // Response: cmd=1, sequence_id=2, status_code=3, body=6.
  const envelope = select(bytes, [1, 2, 3, 6], [1, 2, 3])
  if (
    integer(envelope.get(1)) !== SEND_COMMAND ||
    integer(envelope.get(2)) !== request.sequenceId
  ) {
    throw new Error('[DOUYIN_SEND_ACK_MISMATCH] 发送确认与请求不匹配，请勿自动重发')
  }
  if (integer(envelope.get(3), 0n) !== 0n) {
    throw new Error('[DOUYIN_SEND_REJECTED] 服务器拒绝发送请求，请勿自动重发')
  }
  const body = select(buffer(envelope.get(6)), [100])
  // SendMessageResponseBody: server_message_id=1, status=3, client_message_id=4,
  // is_async_send=8. Zero-valued protobuf scalars may legally be absent.
  const message = select(buffer(body.get(100)), [1, 3, 4, 8], [1, 3, 8])
  if (string(message.get(4)) !== request.clientId) {
    throw new Error('[DOUYIN_SEND_ACK_MISMATCH] 发送确认与请求不匹配，请勿自动重发')
  }
  const status = integer(message.get(3), 0n)
  if (status === 4n) {
    throw new Error('[DOUYIN_SEND_SELF_VISIBLE] 消息仅自己可见，不能确认发送成功，请勿自动重发')
  }
  if (status !== 0n) {
    throw new Error('[DOUYIN_SEND_REJECTED] 服务器未确认消息发送成功，请勿自动重发')
  }
  if (integer(message.get(8), 0n) !== 0n) {
    throw new Error('[DOUYIN_SEND_ASYNC_PENDING] 消息仍在异步处理，尚未确认发送成功，请勿自动重发')
  }
  const serverId = integer(message.get(1), 0n)
  if (serverId <= 0n || serverId > MAX_SIGNED_INT64) throw protocolError()
  return serverId.toString()
}

export interface SendConfirmationOptions {
  expectedText: string
  expectedConversationId: string
  timeout?: number
}

/** Observe one UI submission and require its matching server acknowledgement. Never resubmit. */
export async function confirmMessageSend(
  page: Page,
  action: () => Promise<unknown>,
  options: SendConfirmationOptions,
): Promise<{ serverMessageId: string }> {
  const timeout = options.timeout ?? 30000
  if (
    !options.expectedText ||
    typeof options.expectedConversationId !== 'string' ||
    !options.expectedConversationId.trim() ||
    !Number.isFinite(timeout) ||
    timeout <= 0
  ) {
    throw new Error('[DOUYIN_SEND_INVALID_OPTIONS] 发送确认参数无效')
  }
  const requests = new Map<Request, SendRequest>()
  let candidate: SendRequest | undefined
  let settled = false
  let resolve!: (value: { serverMessageId: string }) => void
  let reject!: (reason: Error) => void
  const confirmation = new Promise<{ serverMessageId: string }>((yes, no) => {
    resolve = yes
    reject = no
  })
  // A fast rejection can precede action completion. Keep it handled until the final await.
  void confirmation.catch(() => {})
  const fail = (error: Error): void => {
    if (settled) return
    settled = true
    reject(error)
  }
  const onRequest = (request: Request): void => {
    if (settled || request.method() !== 'POST') return
    const url = new URL(request.url())
    if (`${url.origin}${url.pathname}` !== SEND_ENDPOINT) return
    try {
      const bytes = request.postDataBuffer()
      if (!bytes) throw protocolError()
      const decoded = decodeRequest(bytes)
      if (
        !decoded ||
        decoded.messageType !== TEXT_MESSAGE_TYPE ||
        decoded.text !== options.expectedText ||
        decoded.conversationId !== options.expectedConversationId
      ) {
        return
      }
      if (
        candidate &&
        (candidate.clientId !== decoded.clientId ||
          candidate.conversationId !== decoded.conversationId ||
          candidate.sequenceId !== decoded.sequenceId)
      ) {
        throw new Error('[DOUYIN_SEND_AMBIGUOUS] 发现多个匹配发送请求，无法唯一确认，请勿自动重发')
      }
      candidate = decoded
      requests.set(request, decoded)
    } catch (error) {
      fail(error instanceof Error && error.message.startsWith('[DOUYIN_') ? error : protocolError())
    }
  }
  const onResponse = (response: Response): void => {
    const request = requests.get(response.request())
    if (settled || !request) return
    void (async () => {
      if (!response.ok()) {
        fail(new Error('[DOUYIN_SEND_NETWORK_FAILED] 发送请求未获得正常响应，请勿自动重发'))
        return
      }
      let bytes: Buffer
      try {
        bytes = await response.body()
      } catch {
        fail(new Error('[DOUYIN_SEND_NETWORK_FAILED] 未能读取发送确认，请勿自动重发'))
        return
      }
      if (settled) return
      const serverMessageId = decodeAcknowledgement(bytes, request)
      settled = true
      resolve({ serverMessageId })
    })().catch((error: unknown) => {
      fail(error instanceof Error && error.message.startsWith('[DOUYIN_') ? error : protocolError())
    })
  }
  const onRequestFailed = (request: Request): void => {
    if (requests.has(request)) {
      fail(new Error('[DOUYIN_SEND_NETWORK_FAILED] 发送网络请求失败，请勿自动重发'))
    }
  }
  const timer = setTimeout(
    () => fail(new Error('[DOUYIN_SEND_UNCONFIRMED] 未收到匹配的服务器发送确认，请勿自动重发')),
    timeout,
  )
  page.on('request', onRequest)
  page.on('response', onResponse)
  page.on('requestfailed', onRequestFailed)
  try {
    await action()
    return await confirmation
  } finally {
    settled = true
    clearTimeout(timer)
    page.off('request', onRequest)
    page.off('response', onResponse)
    page.off('requestfailed', onRequestFailed)
  }
}
