import type { Locator, Page } from 'playwright'

export function resolveDryRun(value = process.env.DRY_RUN): boolean {
  const normalized = value?.trim().toLowerCase()
  if (!normalized || normalized === 'false') return false
  if (normalized === 'true') return true
  throw new Error('DRY_RUN 只能配置为 true 或 false')
}

/** Wait for authenticated chat UI; a visible search box behind a login overlay is insufficient. */
export async function waitForChatSearch(
  page: Page,
  timeout = 30000,
  waitForManualLogin = false,
): Promise<Locator> {
  const search = page
    .locator('input.semi-input[placeholder="搜索"]')
    .filter({ visible: true })
    .first()
  const login = page
    .getByText('登录后免费畅享高清视频', { exact: true })
    .filter({ visible: true })
    .first()
  const qrLogin = page.getByText('扫码登录', { exact: true }).filter({ visible: true }).first()
  const codeLogin = page.getByText('验证码登录', { exact: true }).filter({ visible: true }).first()
  const verification = page
    .getByText(/^(请完成安全验证|请完成下方验证|拖动滑块完成拼图|请拖动滑块完成验证)$/, {
      exact: true,
    })
    .filter({ visible: true })
    .first()
  const deadline = Date.now() + timeout

  do {
    const verificationVisible = await verification.isVisible()
    const loginVisible =
      (await login.isVisible()) || ((await qrLogin.isVisible()) && (await codeLogin.isVisible()))
    if (verificationVisible && !waitForManualLogin) {
      throw new Error(
        '[DOUYIN_VERIFICATION_REQUIRED] 抖音要求安全验证，请在本机完成验证后刷新登录凭据',
      )
    }
    if (loginVisible && !waitForManualLogin) {
      throw new Error(
        '[DOUYIN_LOGIN_REQUIRED] 抖音显示登录弹窗，现有 Cookie 未通过认证。请重新登录 www.douyin.com/chat 并更新 GitHub Actions 的 Cookie Secret',
      )
    }
    if (!verificationVisible && !loginVisible && (await search.isVisible())) return search
    if (Date.now() >= deadline) break
    await page.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())))
  } while (Date.now() <= deadline)

  throw new Error(
    '[DOUYIN_CHAT_NOT_READY] 聊天页未在规定时间内就绪，可能是页面加载、网络或页面结构变化；请查看失败截图',
  )
}

/** Keep the no-send guard at the only keyboard submission entry point. */
export async function submitMessage(
  page: Page,
  editor: Locator,
  message: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return
  await editor.click()
  await page.keyboard.insertText(message)
  await page.keyboard.press('Enter')
}
