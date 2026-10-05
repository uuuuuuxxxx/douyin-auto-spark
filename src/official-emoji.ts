import type { Page } from 'playwright'
import { selectDailySparkMessage } from './daily-message'

export const OFFICIAL_EMOJI_CATALOG = ['续火花', '比心', '嗨', '开心', '爱心'] as const
export type OfficialEmojiName = (typeof OFFICIAL_EMOJI_CATALOG)[number]

const OPENER_SELECTOR = '.messageMsgInputinputAction > svg.messageMsgInputiconAction'
const PANEL_SELECTOR = '.componentsemojiim-saas-modal .componentsemojiemojiPanel'
const TAB_SELECTOR = '.emojiEmojisModalTabsubTab'
const ITEM_SELECTOR = '.emojiEmojiItememojiItem'
const LABEL_SELECTOR = '.emojiEmojiItememojiItemDesc'
const IMAGE_SELECTOR = '.emojiEmojiItemimgBox'

export function selectDailyOfficialEmoji(now = new Date()): OfficialEmojiName {
  return selectDailySparkMessage(OFFICIAL_EMOJI_CATALOG, now) as OfficialEmojiName
}

/** Official image boxes submit directly on click. Dry runs only open and inspect the panel. */
export async function prepareOrSubmitOfficialEmoji(
  page: Page,
  name: OfficialEmojiName,
  dryRun: boolean,
  timeout = 10000,
): Promise<'verified' | 'submitted'> {
  if (!OFFICIAL_EMOJI_CATALOG.includes(name)) {
    throw new Error('不支持的官方表情名称')
  }

  const opener = page.locator(OPENER_SELECTOR).filter({ visible: true })
  const panel = page.locator(PANEL_SELECTOR).filter({ visible: true })
  if ((await panel.count()) === 0) {
    if ((await opener.count()) !== 1 || !(await opener.isEnabled())) {
      throw new Error('官方表情面板入口缺失、重复或不可用；未提交表情')
    }
    await opener.click({ timeout })
    await panel.first().waitFor({ state: 'visible', timeout })
  }

  if ((await panel.count()) !== 1) {
    throw new Error('官方表情面板不唯一；未提交表情')
  }

  const officialTab = panel.locator(TAB_SELECTOR).nth(0)
  await officialTab.waitFor({ state: 'visible', timeout })
  if (!(await officialTab.isEnabled())) {
    throw new Error('官方推荐表情页签不可用；未提交表情')
  }
  await officialTab.click({ timeout })

  const label = page.locator(LABEL_SELECTOR).filter({ hasText: new RegExp(`^${name}$`) })
  const matches = panel.locator(ITEM_SELECTOR).filter({ has: label }).filter({ visible: true })
  await matches
    .first()
    .waitFor({ state: 'visible', timeout })
    .catch(() => {
      throw new Error(`官方表情「${name}」未找到；未提交表情`)
    })

  if ((await matches.count()) !== 1) {
    throw new Error(`官方表情「${name}」有多个匹配项；未提交表情`)
  }

  await matches.scrollIntoViewIfNeeded({ timeout })
  if (
    (await matches.count()) !== 1 ||
    !(await matches.isEnabled()) ||
    (await matches.getAttribute('disabled')) !== null ||
    /disabled/i.test((await matches.getAttribute('class')) ?? '')
  ) {
    throw new Error(`官方表情「${name}」不可用；未提交表情`)
  }

  const imageBox = matches.locator(IMAGE_SELECTOR)
  if ((await imageBox.count()) !== 1) {
    throw new Error(`官方表情「${name}」图像控件缺失或不唯一；未提交表情`)
  }
  if (!(await imageBox.isVisible())) {
    throw new Error(`官方表情「${name}」图像控件不可见；未提交表情`)
  }
  await imageBox.scrollIntoViewIfNeeded({ timeout })
  if (
    (await imageBox.count()) !== 1 ||
    !(await imageBox.isEnabled()) ||
    (await imageBox.getAttribute('disabled')) !== null ||
    /disabled/i.test((await imageBox.getAttribute('class')) ?? '')
  ) {
    throw new Error(`官方表情「${name}」图像控件不可用；未提交表情`)
  }

  if (dryRun) {
    if ((await opener.count()) !== 1 || !(await opener.isEnabled())) {
      throw new Error('官方表情面板入口不可用，无法收起验证面板；未提交表情')
    }
    await opener.click({ timeout })
    await panel.waitFor({ state: 'hidden', timeout })
    return 'verified'
  }

  // The label is a sibling without a send handler. Submit only via the verified image box.
  await imageBox.click({ timeout })
  return 'submitted'
}
