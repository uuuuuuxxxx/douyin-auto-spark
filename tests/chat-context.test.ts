import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { chromium, type Browser } from 'playwright'
import { waitForConversation } from '../src/chat-context'

let browser: Browser
before(async () => {
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  const executablePath =
    process.env.PLAYWRIGHT_BROWSER_PATH || (existsSync(chrome) ? chrome : undefined)
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  })
})
after(async () => {
  await browser?.close()
})

test('an old visible editor cannot authorize sending to the wrong conversation', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent(
      '<div class="RightPanelHeadertitle">旧好友</div><div contenteditable="true">旧草稿</div>',
    )
    await assert.rejects(waitForConversation(page, 'TwT', 100), /RECIPIENT_UNCONFIRMED/)
  } finally {
    await page.close()
  }
})

test('waits until the asynchronous conversation header switches to the intended recipient', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent('<div class="RightPanelHeadertitle">旧好友</div>')
    await page.evaluate(() => {
      setTimeout(() => {
        document.querySelector('.RightPanelHeadertitle')!.textContent = 'TwT'
      }, 150)
    })
    await waitForConversation(page, 'TwT', 2000)
    assert.equal(await page.locator('.RightPanelHeadertitle').innerText(), 'TwT')
  } finally {
    await page.close()
  }
})

test('normalizes spaces preserved by the official title component without changing unicode names', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent('<div class="StackLayoutStackChatHeadertitle">ᖰ•\u00a0֊\u00a0•ᖳ</div>')
    await waitForConversation(page, 'ᖰ• ֊ •ᖳ', 500)
    await assert.rejects(waitForConversation(page, '不同的人', 100), /RECIPIENT_UNCONFIRMED/)
  } finally {
    await page.close()
  }
})

test('ignores a hidden duplicate but rejects two visible conversation titles', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent(
      '<div class="RightPanelHeadertitle" hidden>旧好友</div><div class="RightPanelHeadertitle">TwT</div>',
    )
    await waitForConversation(page, 'TwT', 500)
    await page.locator('[hidden]').evaluate((element) => element.removeAttribute('hidden'))
    await assert.rejects(waitForConversation(page, 'TwT', 100), /RECIPIENT_UNCONFIRMED/)
  } finally {
    await page.close()
  }
})
