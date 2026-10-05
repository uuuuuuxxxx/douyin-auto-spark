import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { chromium, type Browser } from 'playwright'
import { resolveDryRun, submitMessage, waitForChatSearch } from '../src/chat-session'

let browser: Browser

before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_BROWSER_PATH
      ? { executablePath: process.env.PLAYWRIGHT_BROWSER_PATH }
      : {}),
  })
})

after(async () => {
  await browser?.close()
})

test('login overlay is reported even when a search input exists behind it', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent(
      '<input class="semi-input" placeholder="搜索"><h2>登录后免费畅享高清视频</h2>',
    )
    await assert.rejects(waitForChatSearch(page, 500), /DOUYIN_LOGIN_REQUIRED/)
  } finally {
    await page.close()
  }
})

test('QR and code login tabs detect the modal when its title changes', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent('<span>扫码登录</span><span>验证码登录</span>')
    await assert.rejects(waitForChatSearch(page, 500), /DOUYIN_LOGIN_REQUIRED/)
  } finally {
    await page.close()
  }
})

test('visible verification is distinguished from missing authentication', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent('<p>请完成安全验证</p>')
    await assert.rejects(waitForChatSearch(page, 500), /DOUYIN_VERIFICATION_REQUIRED/)
  } finally {
    await page.close()
  }
})

test('loading timeout does not assert that cookies expired', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent('<p>正在加载</p>')
    await assert.rejects(waitForChatSearch(page, 100), /DOUYIN_CHAT_NOT_READY/)
  } finally {
    await page.close()
  }
})

test('waits for delayed chat rendering and ignores hidden login markup', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent('<h2 hidden>登录后免费畅享高清视频</h2>')
    await page.evaluate(() => {
      setTimeout(() => {
        const search = document.createElement('input')
        search.className = 'semi-input'
        search.placeholder = '搜索'
        document.body.append(search)
      }, 100)
    })
    assert.equal(await (await waitForChatSearch(page, 2000)).getAttribute('placeholder'), '搜索')
  } finally {
    await page.close()
  }
})

test('dry run does not focus, modify or submit the message editor', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent('<textarea id="editor">已有草稿</textarea>')
    await page.evaluate(() => {
      document.querySelector('#editor')!.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Enter') document.body.dataset.submitted = 'true'
      })
    })
    await submitMessage(page, page.locator('#editor'), '不应发送', true)
    assert.equal(await page.locator('#editor').inputValue(), '已有草稿')
    assert.equal(await page.evaluate(() => document.activeElement?.id), '')
    assert.equal(await page.locator('body').getAttribute('data-submitted'), null)
  } finally {
    await page.close()
  }
})

test('normal mode retains keyboard submission behavior on a local fixture', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent('<textarea id="editor"></textarea>')
    await page.evaluate(() => {
      document.querySelector('#editor')!.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Enter') document.body.dataset.submitted = 'true'
      })
    })
    await submitMessage(page, page.locator('#editor'), '[猪头]', false)
    assert.match(await page.locator('#editor').inputValue(), /\[猪头\]/)
    assert.equal(await page.locator('body').getAttribute('data-submitted'), 'true')
  } finally {
    await page.close()
  }
})

test('DRY_RUN accepts booleans and rejects ambiguous values before sending', () => {
  assert.equal(resolveDryRun(''), false)
  assert.equal(resolveDryRun('false'), false)
  assert.equal(resolveDryRun(' TRUE '), true)
  assert.throws(() => resolveDryRun('yes'), /DRY_RUN/)
})

test('hidden duplicate login text cannot hide a visible login overlay', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent(
      '<input class="semi-input" placeholder="搜索"><h2 hidden>登录后免费畅享高清视频</h2><h2>登录后免费畅享高清视频</h2>',
    )
    await assert.rejects(waitForChatSearch(page, 500), /DOUYIN_LOGIN_REQUIRED/)
  } finally {
    await page.close()
  }
})

test('navigation search alone is not an authenticated chat page', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent('<input placeholder="搜索">')
    await assert.rejects(waitForChatSearch(page, 100), /DOUYIN_CHAT_NOT_READY/)
  } finally {
    await page.close()
  }
})

test('manual refresh waits for the login overlay to disappear before accepting cookies', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent(
      '<input class="semi-input" placeholder="搜索"><h2>登录后免费畅享高清视频</h2>',
    )
    await assert.rejects(waitForChatSearch(page, 100, true), /DOUYIN_CHAT_NOT_READY/)
    await page.evaluate(() => {
      setTimeout(() => document.querySelector('h2')!.remove(), 100)
    })
    assert.equal(
      await (await waitForChatSearch(page, 2000, true)).getAttribute('placeholder'),
      '搜索',
    )
  } finally {
    await page.close()
  }
})
