import { expect, test } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { stat, writeFile } from 'node:fs/promises'

import {
  connectSingleReceiverRoom,
  sha256File,
} from './transfer.helper'

test('the 100 MiB transfer limit completes with matching downloaded bytes', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'large transfer runs once on desktop')
  test.slow()
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  const block = Buffer.allocUnsafe(4096)
  for (let index = 0; index < block.length; index += 1) {
    block[index] = (index * 13 + 29) % 256
  }
  let payload = Buffer.alloc(100 * 1024 * 1024)
  for (let offset = 0; offset < payload.length; offset += block.length) {
    block.copy(payload, offset)
  }
  const sourcePath = testInfo.outputPath('m6-100-mib.bin')
  const expectedHash = createHash('sha256').update(payload).digest('hex')
  await writeFile(sourcePath, payload)
  payload = Buffer.alloc(0)

  try {
    await connectSingleReceiverRoom(owner, receiver)
    await owner.locator('#transfer-file-input').setInputFiles(sourcePath)
    const transferDialog = receiver.getByRole('dialog', { name: '接收文件' })
    await expect(transferDialog).toContainText('100.00 MiB')
    await transferDialog.getByRole('button', { name: '接收文件' }).click()

    await expect(owner.getByRole('heading', { name: '文件发送完成' })).toBeVisible({
      timeout: 45_000,
    })
    await expect(receiver.getByRole('heading', { name: '文件接收完成' })).toBeVisible({
      timeout: 45_000,
    })
    const download = receiver.getByRole('link', { name: '保存文件' })
    const [browserDownload] = await Promise.all([
      receiver.waitForEvent('download'),
      download.click(),
    ])
    const downloadPath = await browserDownload.path()
    if (!downloadPath) {
      throw new Error('Playwright did not expose the large downloaded file path')
    }
    expect((await stat(downloadPath)).size).toBe(100 * 1024 * 1024)
    expect(await sha256File(downloadPath)).toBe(expectedHash)
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})
