import 'dotenv/config'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Browser, type Cookie, type Page } from 'playwright'
import { waitForChatSearch } from './chat-session'

const LOGIN_TIMEOUT = 5 * 60 * 1000
const COOKIE_FILE = resolve(__dirname, '..', '.douyin-cookie.json')

interface CookieEditorCookie {
  domain: string
  expirationDate?: number
  hostOnly: boolean
  httpOnly: boolean
  name: string
  path: string
  sameSite: 'no_restriction' | 'lax' | 'strict'
  secure: boolean
  session: boolean
  storeId: null
  value: string
}

function toCookieEditorCookie(cookie: Cookie): CookieEditorCookie {
  return {
    domain: cookie.domain,
    ...(cookie.expires > 0 ? { expirationDate: cookie.expires } : {}),
    hostOnly: !cookie.domain.startsWith('.'),
    httpOnly: cookie.httpOnly,
    name: cookie.name,
    path: cookie.path,
    sameSite:
      cookie.sameSite === 'None'
        ? 'no_restriction'
        : cookie.sameSite === 'Strict'
          ? 'strict'
          : 'lax',
    secure: cookie.secure,
    session: cookie.expires <= 0,
    storeId: null,
    value: cookie.value,
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(
      '用法：pnpm exec tsx src/refresh-cookie.ts\n' +
        '打开全新的浏览器，在 5 分钟内手动扫码登录抖音聊天页。\n' +
        '登录成功后将 Cookie-Editor JSON 保存到项目根目录的 .douyin-cookie.json。\n' +
        '可通过 PLAYWRIGHT_BROWSER_PATH 指定 Chromium 浏览器路径。\n' +
        '此工具不会读取现有浏览器资料、搜索联系人或发送消息。',
    )
    return
  }

  if (args.length > 0) {
    throw new Error('不支持这些参数，请使用 --help 查看用法')
  }

  let browser: Browser | undefined
  let page: Page | undefined
  let interruptedError: Error | undefined
  let cleaningUp = false
  let rejectInterrupted: (error: Error) => void = () => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = reject
  })
  // 登录浏览器启动期间也可能收到退出信号，提前处理拒绝以免产生未处理异常。
  void interrupted.catch(() => {})

  const interrupt = (message: string): void => {
    if (cleaningUp || interruptedError) {
      return
    }
    interruptedError = new Error(message)
    rejectInterrupted(interruptedError)
  }
  const onSigint = (): void => interrupt('用户取消了登录，未完成凭据刷新')
  const onSigterm = (): void => interrupt('进程收到退出信号，未完成凭据刷新')
  const onBrowserClosed = (): void => interrupt('浏览器已关闭，未完成凭据刷新')
  const onPageClosed = (): void => interrupt('登录窗口已关闭，未完成凭据刷新')
  const deadline = Date.now() + LOGIN_TIMEOUT
  const remainingTime = (): number => Math.max(1, deadline - Date.now())
  const timeout = setTimeout(() => interrupt('5 分钟内未完成登录，请重新运行工具'), LOGIN_TIMEOUT)
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)

  try {
    console.log('正在打开独立浏览器，请手动扫码登录抖音；请勿关闭登录窗口。')
    const browserPath = process.env.PLAYWRIGHT_BROWSER_PATH?.trim()
    browser = await chromium.launch({
      headless: false,
      timeout: Math.min(30000, remainingTime()),
      ...(browserPath ? { executablePath: browserPath } : {}),
    })

    // 浏览器启动不能被 Promise.race 取消；等它返回后清理，避免遗留后台进程。
    if (interruptedError) {
      throw interruptedError
    }
    browser.on('disconnected', onBrowserClosed)
    const context = await browser.newContext()
    page = await context.newPage()
    page.on('close', onPageClosed)

    await Promise.race([
      page.goto('https://www.douyin.com/chat', {
        waitUntil: 'domcontentloaded',
        timeout: remainingTime(),
      }),
      interrupted,
    ])
    await Promise.race([waitForChatSearch(page, remainingTime(), true), interrupted])

    const cookies = await Promise.race([context.cookies(), interrupted])
    const douyinCookies = cookies.filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, '')
      return domain === 'douyin.com' || domain.endsWith('.douyin.com')
    })

    if (douyinCookies.length === 0) {
      throw new Error('未取得抖音 Cookie，请确认已经完成登录后重试')
    }
    if (interruptedError) {
      throw interruptedError
    }

    await writeFile(COOKIE_FILE, `${JSON.stringify(douyinCookies.map(toCookieEditorCookie))}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    console.log(`登录凭据已保存：${COOKIE_FILE}`)
    console.log('该文件包含登录凭据，请仅用于更新对应账号的 Cookie，勿公开或提交到 Git。')
  } catch (error) {
    if (interruptedError) {
      throw interruptedError
    }
    if (Date.now() >= deadline) {
      throw new Error('5 分钟内未完成登录，请重新运行工具')
    }
    throw error
  } finally {
    cleaningUp = true
    clearTimeout(timeout)
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
    page?.removeListener('close', onPageClosed)
    browser?.removeListener('disconnected', onBrowserClosed)
    await browser?.close().catch(() => {})
  }
}

main().catch((error: unknown) => {
  // 不输出 Cookie、页面内容或 Playwright 对象，只报告失败原因。
  console.error(`凭据刷新失败：${error instanceof Error ? error.message : '发生未知错误'}`)
  process.exitCode = 1
})
