import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright'
import {
  OFFICIAL_EMOJI_CATALOG,
  prepareOrSubmitOfficialEmoji,
  selectDailyOfficialEmoji,
  type OfficialEmojiName,
} from '../src/official-emoji'

let browser: Browser
let page: Page
let keyboardCalls: { insertText: number; press: number }

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
  await page.route('**/*', (route) => route.abort())
  keyboardCalls = { insertText: 0, press: 0 }
  page.keyboard.insertText = async () => {
    keyboardCalls.insertText += 1
  }
  page.keyboard.press = async () => {
    keyboardCalls.press += 1
  }
})

afterEach(async () => {
  await page?.close()
})

after(async () => {
  await browser?.close()
})

async function installFixture(
  labels: readonly string[] = OFFICIAL_EMOJI_CATALOG,
  disabledAttribute = '',
  extraClass = '',
): Promise<void> {
  await page.setContent(`
    <div class="messageMsgInputinputAction">
      <svg class="messageMsgInputiconAction" width="32" height="32">
        <circle cx="16" cy="16" r="15"></circle>
      </svg>
    </div>
    <div class="componentsemojiim-saas-modal" style="width: 0; height: 0; position: relative">
    <div class="semi-modal-wrap" style="position: fixed; inset: 0; z-index: 100" hidden>
    <div class="fixture-resize-handler" style="position: fixed; left: 0; top: 0; width: 24px; height: 24px"></div>
      <div class="componentsemojiemojiPanel" style="position: absolute; left: calc(100vw - 380px); top: calc(100vh - 320px); width: 350px; background: white">
      <div id="official-list" style="max-height: 220px; overflow: auto" hidden>
        ${labels
          .map(
            (
              label,
            ) => `<div class="emojiEmojiItememojiItem ${extraClass}" role="button" ${disabledAttribute}>
              <div class="emojiEmojiItemimgBox" style="width: 55px; height: 55px" role="button">表情图</div>
              <div class="emojiEmojiItememojiItemDesc" style="height: 90px">${label}</div>
            </div>`,
          )
          .join('')}
      </div>
      <div id="other-list"><div class="emojiEmojiItememojiItem" role="button">
        <div class="emojiEmojiItemimgBox" style="width: 55px; height: 55px" role="button">表情图</div>
        <div class="emojiEmojiItememojiItemDesc">嗨</div>
      </div></div>
      <button class="emojiEmojisModalTabsubTab" id="official-tab">官方推荐</button>
      <button class="emojiEmojisModalTabsubTab">其他表情</button>
      </div>
    </div>
    </div>
    <div contenteditable="true" id="editor">原有草稿</div>
  `)
  await page.evaluate(() => {
    document.body.dataset.itemClicks = '0'
    document.body.dataset.imageClicks = '0'
    document.body.dataset.descClicks = '0'
    document.body.dataset.openerClicks = '0'
    document.body.dataset.backdropClicks = '0'
    document.body.dataset.cornerClicks = '0'
    document.body.dataset.enters = '0'
    document.body.dataset.inputs = '0'
    const initialPortal = document.querySelector<HTMLElement>('.componentsemojiim-saas-modal')!
    const template = initialPortal.cloneNode(true) as HTMLElement
    const fixture = {
      bindPortal(portal: HTMLElement): void {
        const modal = portal.querySelector<HTMLElement>('.semi-modal-wrap')!
        modal.addEventListener('click', (event) => {
          if (event.target === modal) {
            document.body.dataset.backdropClicks = String(
              Number(document.body.dataset.backdropClicks) + 1,
            )
            portal.remove()
          }
        })
        // Match the real handler topology: only the image box submits and closes the modal.
        modal.querySelectorAll('.emojiEmojiItemimgBox').forEach((imageBox) => {
          imageBox.addEventListener('click', () => {
            document.body.dataset.imageClicks = String(
              Number(document.body.dataset.imageClicks) + 1,
            )
            portal.remove()
          })
        })
      },
    }
    fixture.bindPortal(initialPortal)
    document.addEventListener('click', (event) => {
      const target = event.target as Element
      if (target.closest('.messageMsgInputiconAction')) {
        let portal = document.querySelector<HTMLElement>('.componentsemojiim-saas-modal')
        if (!portal) {
          portal = template.cloneNode(true) as HTMLElement
          fixture.bindPortal(portal)
          document.body.appendChild(portal)
        }
        portal.querySelector<HTMLElement>('.semi-modal-wrap')!.hidden = false
        document.body.dataset.openerClicks = String(Number(document.body.dataset.openerClicks) + 1)
      }
      if (target.closest('#official-tab')) {
        document.querySelector<HTMLElement>('#official-list')!.hidden = false
        document.querySelector<HTMLElement>('#other-list')!.hidden = true
      }
      if (target.closest('.emojiEmojiItememojiItem')) {
        document.body.dataset.itemClicks = String(Number(document.body.dataset.itemClicks) + 1)
      }
      if (target.closest('.emojiEmojiItememojiItemDesc')) {
        document.body.dataset.descClicks = String(Number(document.body.dataset.descClicks) + 1)
      }
      if (target.closest('.fixture-resize-handler')) {
        document.body.dataset.cornerClicks = String(Number(document.body.dataset.cornerClicks) + 1)
      }
    })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        document.body.dataset.enters = String(Number(document.body.dataset.enters) + 1)
      }
    })
    document.addEventListener('input', () => {
      document.body.dataset.inputs = String(Number(document.body.dataset.inputs) + 1)
    })
  })
}

async function assertNoTextInput(): Promise<void> {
  assert.deepEqual(keyboardCalls, { insertText: 0, press: 0 })
  assert.equal(await page.getAttribute('body', 'data-enters'), '0')
  assert.equal(await page.getAttribute('body', 'data-inputs'), '0')
  assert.equal(await page.locator('#editor').innerText(), '原有草稿')
}

test('dry-run uses the visible panel inside a zero-sized portal, then closes without any submission', async () => {
  await installFixture()
  await page.locator('.messageMsgInputinputAction > svg.messageMsgInputiconAction').click()
  assert.equal(await page.locator('.componentsemojiim-saas-modal').isVisible(), false)
  assert.equal(await page.locator('.componentsemojiemojiPanel').isVisible(), true)
  assert.equal(await page.locator('.componentsemojiim-saas-modal .semi-modal-wrap').count(), 1)
  assert.equal(await page.locator('.semi-modal-wrap .componentsemojiim-saas-modal').count(), 0)
  assert.equal(
    await page.evaluate(() => document.elementFromPoint(1, 1)?.className),
    'fixture-resize-handler',
  )
  assert.equal(await prepareOrSubmitOfficialEmoji(page, '嗨', true, 500), 'verified')
  assert.equal(await page.getAttribute('body', 'data-item-clicks'), '0')
  assert.equal(await page.getAttribute('body', 'data-image-clicks'), '0')
  assert.equal(await page.getAttribute('body', 'data-opener-clicks'), '1')
  assert.equal(await page.getAttribute('body', 'data-backdrop-clicks'), '1')
  assert.equal(await page.getAttribute('body', 'data-corner-clicks'), '0')
  assert.equal(await page.locator('.componentsemojiemojiPanel').isVisible(), false)
  assert.equal(await page.locator('.semi-modal-wrap').count(), 0)
  assert.equal(await page.locator('.componentsemojiim-saas-modal').count(), 0)
  await assertNoTextInput()
})

test('official live mode clicks the exact image box once without clicking its label or typing', async () => {
  await installFixture()
  assert.equal(await prepareOrSubmitOfficialEmoji(page, '嗨', false, 500), 'submitted')
  assert.equal(await page.getAttribute('body', 'data-item-clicks'), '1')
  assert.equal(await page.getAttribute('body', 'data-image-clicks'), '1')
  assert.equal(await page.getAttribute('body', 'data-desc-clicks'), '0')
  assert.equal(await page.getAttribute('body', 'data-opener-clicks'), '1')
  assert.equal(await page.getAttribute('body', 'data-backdrop-clicks'), '0')
  assert.equal(await page.locator('.semi-modal-wrap').count(), 0)
  assert.equal(await page.locator('.componentsemojiim-saas-modal').count(), 0)
  await assertNoTextInput()
})

test('a missing exact label fails without clicking a similar label or sending text', async () => {
  await installFixture(['嗨一下'])
  await assert.rejects(prepareOrSubmitOfficialEmoji(page, '嗨', false, 50), /未找到/)
  assert.equal(await page.getAttribute('body', 'data-item-clicks'), '0')
  await assertNoTextInput()
})

test('duplicate official labels fail without choosing either item or sending text', async () => {
  await installFixture(['比心', '比心'])
  await assert.rejects(prepareOrSubmitOfficialEmoji(page, '比心', false, 500), /多个匹配项/)
  assert.equal(await page.getAttribute('body', 'data-item-clicks'), '0')
  await assertNoTextInput()
})

test('an aria-disabled item fails without any submission', async () => {
  await installFixture(['开心'], 'aria-disabled="true"')
  await assert.rejects(prepareOrSubmitOfficialEmoji(page, '开心', false, 500), /不可用/)
  assert.equal(await page.getAttribute('body', 'data-item-clicks'), '0')
  await assertNoTextInput()
})

test('a disabled attribute on a non-native item fails without any submission', async () => {
  await installFixture(['爱心'], 'disabled')
  await assert.rejects(prepareOrSubmitOfficialEmoji(page, '爱心', false, 500), /不可用/)
  assert.equal(await page.getAttribute('body', 'data-item-clicks'), '0')
  await assertNoTextInput()
})

test('a class-disabled single item fails without any submission', async () => {
  await installFixture(['续火花'], '', 'emojiEmojiItemdisabled')
  await assert.rejects(prepareOrSubmitOfficialEmoji(page, '续火花', false, 500), /不可用/)
  assert.equal(await page.getAttribute('body', 'data-item-clicks'), '0')
  await assertNoTextInput()
})

test('a missing image box fails without sending from the label sibling', async () => {
  await installFixture(['嗨'])
  await page.locator('#official-list .emojiEmojiItemimgBox').evaluate((box) => box.remove())
  await assert.rejects(prepareOrSubmitOfficialEmoji(page, '嗨', false, 500), /图像控件缺失或不唯一/)
  assert.equal(await page.getAttribute('body', 'data-item-clicks'), '0')
  assert.equal(await page.getAttribute('body', 'data-image-clicks'), '0')
  await assertNoTextInput()
})

test('duplicate image boxes fail without choosing either sending control', async () => {
  await installFixture(['嗨'])
  await page.locator('#official-list .emojiEmojiItemimgBox').evaluate((box) => {
    box.parentElement!.appendChild(box.cloneNode(true))
  })
  await assert.rejects(prepareOrSubmitOfficialEmoji(page, '嗨', false, 500), /图像控件缺失或不唯一/)
  assert.equal(await page.getAttribute('body', 'data-item-clicks'), '0')
  assert.equal(await page.getAttribute('body', 'data-image-clicks'), '0')
  await assertNoTextInput()
})

test('a hidden image box cannot pass dry-run validation', async () => {
  await installFixture(['嗨'])
  await page.locator('#official-list .emojiEmojiItemimgBox').evaluate((box) => {
    box.setAttribute('hidden', '')
  })
  await assert.rejects(prepareOrSubmitOfficialEmoji(page, '嗨', true, 500), /图像控件不可见/)
  assert.equal(await page.getAttribute('body', 'data-image-clicks'), '0')
  await assertNoTextInput()
})

test('an aria-disabled image box fails without clicking its enabled parent item', async () => {
  await installFixture(['嗨'])
  await page.locator('#official-list .emojiEmojiItemimgBox').evaluate((box) => {
    box.setAttribute('aria-disabled', 'true')
  })
  await assert.rejects(prepareOrSubmitOfficialEmoji(page, '嗨', false, 500), /图像控件不可用/)
  assert.equal(await page.getAttribute('body', 'data-item-clicks'), '0')
  assert.equal(await page.getAttribute('body', 'data-image-clicks'), '0')
  await assertNoTextInput()
})

test('a disabled attribute on the image box fails without submission', async () => {
  await installFixture(['嗨'])
  await page.locator('#official-list .emojiEmojiItemimgBox').evaluate((box) => {
    box.setAttribute('disabled', '')
  })
  await assert.rejects(prepareOrSubmitOfficialEmoji(page, '嗨', false, 500), /图像控件不可用/)
  assert.equal(await page.getAttribute('body', 'data-image-clicks'), '0')
  await assertNoTextInput()
})

test('a class-disabled image box fails without submission', async () => {
  await installFixture(['嗨'])
  await page.locator('#official-list .emojiEmojiItemimgBox').evaluate((box) => {
    box.classList.add('emojiEmojiItemdisabled')
  })
  await assert.rejects(prepareOrSubmitOfficialEmoji(page, '嗨', false, 500), /图像控件不可用/)
  assert.equal(await page.getAttribute('body', 'data-image-clicks'), '0')
  await assertNoTextInput()
})

test('unsupported labels fail before even opening the panel', async () => {
  await installFixture()
  await assert.rejects(
    prepareOrSubmitOfficialEmoji(page, '打招呼' as OfficialEmojiName, false, 500),
    /不支持/,
  )
  assert.equal(await page.getAttribute('body', 'data-opener-clicks'), '0')
  assert.equal(await page.getAttribute('body', 'data-item-clicks'), '0')
  await assertNoTextInput()
})

test('two dry-runs reopen and close the panel without sending to either recipient', async () => {
  await installFixture()
  await prepareOrSubmitOfficialEmoji(page, '续火花', true, 500)
  await prepareOrSubmitOfficialEmoji(page, '比心', true, 500)
  assert.equal(await page.getAttribute('body', 'data-opener-clicks'), '2')
  assert.equal(await page.getAttribute('body', 'data-backdrop-clicks'), '2')
  assert.equal(await page.getAttribute('body', 'data-item-clicks'), '0')
  assert.equal(await page.locator('.componentsemojiemojiPanel').isVisible(), false)
  assert.equal(await page.locator('.componentsemojiim-saas-modal').count(), 0)
  await assertNoTextInput()
})

test('a background covered by other elements fails without any click or keyboard fallback', async () => {
  await installFixture(['嗨'])
  await page.locator('.semi-modal-wrap').evaluate((wrapper) => {
    const blocker = document.createElement('div')
    blocker.style.cssText = 'position: absolute; inset: 0; z-index: 1'
    wrapper.appendChild(blocker)
    const panel = wrapper.querySelector<HTMLElement>('.componentsemojiemojiPanel')!
    panel.style.zIndex = '2'
  })
  await assert.rejects(prepareOrSubmitOfficialEmoji(page, '嗨', true, 500), /未找到安全/)
  assert.equal(await page.getAttribute('body', 'data-item-clicks'), '0')
  assert.equal(await page.getAttribute('body', 'data-image-clicks'), '0')
  assert.equal(await page.getAttribute('body', 'data-backdrop-clicks'), '0')
  assert.equal(await page.getAttribute('body', 'data-opener-clicks'), '1')
  await assertNoTextInput()
})

test('official daily selection switches at Beijing midnight and keeps same-day reruns fixed', () => {
  const before = selectDailyOfficialEmoji(new Date('2026-10-05T15:59:59.999Z'))
  const after = selectDailyOfficialEmoji(new Date('2026-10-05T16:00:00.000Z'))
  assert.notEqual(before, after)
  assert.equal(after, selectDailyOfficialEmoji(new Date('2026-10-06T15:59:59.999Z')))
})

test('official rotation contains five official names and changes across every cycle boundary', () => {
  const start = Date.parse('2026-10-05T17:00:00Z')
  const selection = Array.from({ length: 11 }, (_, day) =>
    selectDailyOfficialEmoji(new Date(start + day * 24 * 60 * 60 * 1000)),
  )
  assert.deepEqual(new Set(selection.slice(0, 5)), new Set(OFFICIAL_EMOJI_CATALOG))
  for (let index = 1; index < selection.length; index += 1) {
    assert.notEqual(selection[index - 1], selection[index])
  }
  assert.equal(selection[0], selection[5])
})
