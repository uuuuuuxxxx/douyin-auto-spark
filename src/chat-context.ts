import type { Page } from 'playwright'
import { normalizeConversationSearchQuery } from './search-query'

const TITLE_SELECTOR = '.RightPanelHeadertitle, .StackLayoutStackChatHeadertitle'

/** Opening a search result is asynchronous; an old visible editor is not proof of the recipient. */
export async function waitForConversation(
  page: Page,
  targetName: string,
  timeout = 10000,
): Promise<void> {
  try {
    await page.waitForFunction(
      ({ selector, expected }) => {
        const titles = [...document.querySelectorAll<HTMLElement>(selector)].filter(
          (title) =>
            title.getClientRects().length > 0 && getComputedStyle(title).visibility !== 'hidden',
        )
        return (
          titles.length === 1 && titles[0].textContent?.replace(/\s+/g, ' ').trim() === expected
        )
      },
      { selector: TITLE_SELECTOR, expected: normalizeConversationSearchQuery(targetName) },
      { timeout },
    )
  } catch {
    throw new Error(`[DOUYIN_RECIPIENT_UNCONFIRMED] 未确认聊天标题为「${targetName}」，未发送消息`)
  }
}
