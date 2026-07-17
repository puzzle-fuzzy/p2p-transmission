import { expect, test } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { open, readFile } from 'node:fs/promises'

import { connectSingleReceiverRoom } from './room.helper'

test('Firefox and WebKit complete the buffered transfer path', async ({ browser, baseURL }, testInfo) => {
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
  const fileInput = owner.locator('#transfer-file-input')
  for (let index = 0; index < 20; index += 1) {
    if (await fileInput.evaluate(element => element === document.activeElement)) break
    await owner.keyboard.press('Tab')
  }
  await expect(fileInput).toBeFocused()
  const filePickerLabel = owner.locator('label[for="transfer-file-input"]')
  expect(await filePickerLabel.evaluate(element => {
    const style = getComputedStyle(element)
    return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2
  })).toBe(true)

  await fileInput.setInputFiles({
    name: 'compatibility.txt',
    mimeType: 'text/plain',
    buffer: payload,
  })
  const transferDialog = receiver.getByRole('dialog', { name: '接收文件' })
  await expect(transferDialog).toContainText('compatibility.txt')
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

test('Firefox and WebKit explain the streamed-file fallback', async ({ browser, baseURL }, testInfo) => {
  test.skip(
    testInfo.project.name === 'desktop-webkit' && process.platform === 'win32',
    'Playwright WebKit on Windows does not expose RTCPeerConnection',
  )
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  const sourcePath = testInfo.outputPath('compatibility-100-mib-plus-one.bin')
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
