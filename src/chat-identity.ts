import type { Page, Request, Response } from 'playwright'
import { normalizeConversationSearchQuery } from './search-query'

const SELF_PATH = '/aweme/v1/web/user/profile/self/'
const USERS_PATH = '/aweme/v1/web/im/user/info/'

type Endpoint = 'self' | 'users'

function endpoint(request: Request): Endpoint | undefined {
  const url = new URL(request.url())
  if (url.origin !== 'https://www.douyin.com') return undefined
  if (url.pathname === SELF_PATH && request.method() === 'GET') return 'self'
  if (url.pathname === USERS_PATH && request.method() === 'POST') return 'users'
  return undefined
}

function identityError(): Error {
  return new Error('[DOUYIN_IDENTITY_INVALID] 无法验证账号或好友身份，未发送消息')
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw identityError()
  return value as Record<string, unknown>
}

function uid(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw identityError()
    return String(value)
  }
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) throw identityError()
  const parsed = BigInt(value)
  if (parsed <= 0n || parsed > (1n << 64n) - 1n) throw identityError()
  return parsed.toString()
}

function displayName(user: Record<string, unknown>): string {
  const remark = user.remark_name
  const nickname = user.nickname
  if (remark !== undefined && remark !== null && typeof remark !== 'string') throw identityError()
  if (nickname !== undefined && nickname !== null && typeof nickname !== 'string')
    throw identityError()
  // The official search and chat title both prefer a remark over the nickname.
  const name =
    (typeof remark === 'string' && remark) || (typeof nickname === 'string' && nickname) || ''
  return normalizeConversationSearchQuery(name)
}

export interface ConversationIdentityTracker {
  expectedConversationId(targetName: string, timeout?: number): Promise<string>
  dispose(): void
}

/** Observe public identity responses before navigation; never read cookies, storage, or SDK state. */
export function attachConversationIdentity(page: Page): ConversationIdentityTracker {
  let selfUid: string | undefined
  let failure: Error | undefined
  let disposed = false
  const users = new Map<string, string>()
  const pending = new Set<Request>()
  const waiters = new Set<() => void>()
  const changed = (): void => {
    for (const waiter of waiters) waiter()
  }
  const fail = (): void => {
    failure = identityError()
    changed()
  }
  const onRequest = (request: Request): void => {
    if (!disposed && endpoint(request)) pending.add(request)
  }
  const onResponse = (response: Response): void => {
    const request = response.request()
    const kind = endpoint(request)
    if (disposed || !kind) return
    pending.add(request)
    void (async () => {
      try {
        if (!response.ok()) throw identityError()
        const data = record(await response.json())
        if (disposed) return
        if (data.status_code !== undefined && data.status_code !== 0) throw identityError()
        if (kind === 'self') {
          const observed = uid(record(data.user).uid)
          if (selfUid !== undefined && observed !== selfUid) throw identityError()
          selfUid = observed
        } else {
          if (!Array.isArray(data.data)) throw identityError()
          const observed = data.data.map((value: unknown) => {
            const user = record(value)
            return [uid(user.uid), displayName(user)] as const
          })
          for (const [id, name] of observed) users.set(id, name)
        }
      } catch {
        if (!disposed) fail()
      } finally {
        pending.delete(request)
        changed()
      }
    })()
  }
  const onRequestFailed = (request: Request): void => {
    if (disposed || !endpoint(request)) return
    pending.delete(request)
    fail()
  }
  page.on('request', onRequest)
  page.on('response', onResponse)
  page.on('requestfailed', onRequestFailed)

  return {
    async expectedConversationId(targetName, timeout = 10000) {
      const expected = normalizeConversationSearchQuery(targetName)
      if (!expected || !Number.isFinite(timeout) || timeout <= 0) throw identityError()
      const deadline = Date.now() + timeout
      for (;;) {
        if (disposed || failure) throw failure ?? identityError()
        const matches = [...users].filter(([, name]) => name === expected)
        if (matches.length > 1) {
          throw new Error('[DOUYIN_IDENTITY_AMBIGUOUS] 好友名称对应多个身份，未发送消息')
        }
        if (selfUid && matches.length === 1 && pending.size === 0) {
          const targetUid = matches[0]![0]
          if (selfUid === targetUid) throw identityError()
          return BigInt(selfUid) < BigInt(targetUid)
            ? `0:1:${selfUid}:${targetUid}`
            : `0:1:${targetUid}:${selfUid}`
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw new Error('[DOUYIN_IDENTITY_UNCONFIRMED] 未获得完整账号和好友身份资料，未发送消息')
        }
        await new Promise<void>((resolve) => {
          const finish = (): void => {
            clearTimeout(timer)
            waiters.delete(finish)
            resolve()
          }
          const timer = setTimeout(finish, remaining)
          waiters.add(finish)
        })
      }
    },
    dispose() {
      disposed = true
      page.off('request', onRequest)
      page.off('response', onResponse)
      page.off('requestfailed', onRequestFailed)
      pending.clear()
      users.clear()
      selfUid = undefined
      changed()
    },
  }
}
