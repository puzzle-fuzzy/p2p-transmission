import { expect, test } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { open, readFile } from 'node:fs/promises'

import { connectSingleReceiverRoom } from './room.helper'

test('file rows remain contained and links stay undecorated across browsers', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const fixture = document.createElement('div')
    fixture.id = 'cross-browser-layout-fixture'
    fixture.style.cssText = 'position:fixed;left:-10000px;top:0;width:280px;'
    fixture.innerHTML = `
      <div class="file-list" id="cross-browser-file-list">
        <div class="transfer-file-list">
          <div class="transfer-file-row">
            <div class="transfer-file-meta">
              <strong>${'very-long-file-name-'.repeat(18)}.zip</strong>
              <div class="transfer-file-secondary"><span>1.2 GB</span><span>传输中 87%</span></div>
            </div>
          </div>
        </div>
      </div>
      <div class="request-file-list" id="cross-browser-request-file-list">
        <div class="request-file-summary"><strong>${'another-extremely-long-file-name-'.repeat(16)}.bin</strong><span>4 GB</span></div>
      </div>
      <a class="transfer-download" href="/download">保存文件</a>
    `
    document.body.append(fixture)
  })

  const metrics = await page.locator('#cross-browser-layout-fixture').evaluate(element => {
    const fileList = element.querySelector<HTMLElement>('#cross-browser-file-list')
    const requestFileList = element.querySelector<HTMLElement>('#cross-browser-request-file-list')
    const download = element.querySelector<HTMLElement>('.transfer-download')
    return {
      fileList: fileList ? { clientWidth: fileList.clientWidth, scrollWidth: fileList.scrollWidth } : null,
      requestFileList: requestFileList
        ? { clientWidth: requestFileList.clientWidth, scrollWidth: requestFileList.scrollWidth }
        : null,
      textDecoration: download ? getComputedStyle(download).textDecorationLine : null,
    }
  })

  expect(metrics.fileList).not.toBeNull()
  expect(metrics.requestFileList).not.toBeNull()
  expect(metrics.fileList?.scrollWidth).toBeLessThanOrEqual(metrics.fileList?.clientWidth ?? 0)
  expect(metrics.requestFileList?.scrollWidth).toBeLessThanOrEqual(metrics.requestFileList?.clientWidth ?? 0)
  expect(metrics.textDecoration).toBe('none')
})

test('Firefox and WebKit establish a peer connection', { tag: '@interop-smoke' }, async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(
    testInfo.project.name === 'desktop-webkit' && process.platform === 'win32',
    'Playwright WebKit on Windows does not expose RTCPeerConnection',
  )
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()

  await connectSingleReceiverRoom(owner, receiver, { readyTimeout: 20_000 })
})

test('Firefox and WebKit complete the buffered transfer path', {
  tag: '@interop-smoke',
}, async ({ browser, baseURL }, testInfo) => {
  test.skip(
    testInfo.project.name === 'desktop-webkit' && process.platform === 'win32',
    'Playwright WebKit on Windows does not expose RTCPeerConnection',
  )
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL, acceptDownloads: true })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  const payload = Buffer.from('cross-browser buffered transfer\n'.repeat(4096))

  await connectSingleReceiverRoom(owner, receiver, { readyTimeout: 20_000 })
  const filePickerButton = owner.locator('label[for="transfer-file-input"]')
  await owner.getByRole('button', { name: /选择接收者/u }).focus()
  await owner.keyboard.press('Tab')
  await expect(filePickerButton).toBeFocused()
  expect(await filePickerButton.evaluate(element => {
    const style = getComputedStyle(element)
    return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2
  })).toBe(true)

  const [fileChooser] = await Promise.all([
    owner.waitForEvent('filechooser'),
    owner.keyboard.press('Enter'),
  ])
  await fileChooser.setFiles({
    name: 'cross-browser.txt',
    mimeType: 'text/plain',
    buffer: payload,
  })
  const transferDialog = receiver.getByRole('dialog', { name: '接收文件' })
  await expect(transferDialog).toContainText('cross-browser.txt')
  await transferDialog.getByRole('button', { name: '接收文件' }).click()

  await expect(owner.getByRole('heading', { name: '文件发送完成' })).toBeVisible()
  await expect(receiver.getByRole('heading', { name: '文件接收完成' })).toBeVisible()
  const [download] = await Promise.all([
    receiver.waitForEvent('download'),
    receiver.getByRole('link', { name: '保存文件' }).click(),
  ])
  const downloadPath = await download.path()
  expect(downloadPath).not.toBeNull()
  expect(await readFile(downloadPath ?? '')).toEqual(payload)
})

test('Firefox and WebKit explain the streamed-file fallback', {
  tag: '@interop-smoke',
}, async ({ browser, baseURL }, testInfo) => {
  test.skip(
    testInfo.project.name === 'desktop-webkit' && process.platform === 'win32',
    'Playwright WebKit on Windows does not expose RTCPeerConnection',
  )
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  const sourcePath = testInfo.outputPath('cross-browser-100-mib-plus-one.bin')
  const source = await open(sourcePath, 'w')
  await source.truncate(100 * 1024 * 1024 + 1)
  await source.close()

  await connectSingleReceiverRoom(owner, receiver, { readyTimeout: 20_000 })
  await owner.locator('#transfer-file-input').setInputFiles(sourcePath)
  const transferDialog = receiver.getByRole('dialog', { name: '接收文件' })
  await expect(transferDialog.getByRole('alert')).toHaveText(
    '当前浏览器不支持大文件直接保存，请使用桌面版 Chrome 或 Edge。',
  )
  await expect(transferDialog.getByRole('button', { name: '选择位置并接收' })).toBeDisabled()
  await expect(transferDialog.getByRole('button', { name: '拒绝接收' })).toBeEnabled()
})
