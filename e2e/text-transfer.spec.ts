import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { connectSingleReceiverRoom } from './room.helper'
import { currentDirectory } from './transfer.helper'

test('text is delivered automatically and exactly over the DataChannel', { tag: '@smoke' }, async ({
  browser,
  baseURL,
}) => {
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({
    baseURL,
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  const payload = '第一行：你好 👋\n第二行保留  空格与符号 <>&'

  try {
    await connectSingleReceiverRoom(owner, receiver)
    await owner.getByRole('tab', { name: '文本' }).click()
    const composer = owner.getByRole('textbox', { name: '文本内容' })
    await composer.fill(payload)
    await expect(owner.getByText(`${[...payload].length} / 500`)).toBeVisible()
    await owner.getByRole('button', { name: '发送文本' }).click()

    await expect(receiver.getByRole('dialog', { name: '接收文本' })).toHaveCount(0)
    await expect(receiver.getByRole('heading', { name: '文本接收完成' })).toBeVisible()
    await expect(receiver.locator('.received-text-card pre')).toHaveText(payload)
    await expect(owner.getByLabel('文本发送状态').getByText('已送达')).toBeVisible()

    if (process.env.CAPTURE_TRANSFER === '1') {
      const outputDirectory = resolve(currentDirectory, '../docs/release/screenshots')
      await mkdir(outputDirectory, { recursive: true })
      await owner.screenshot({
        path: resolve(outputDirectory, `m9-text-owner-${test.info().project.name}.png`),
        fullPage: true,
      })
      await receiver.screenshot({
        path: resolve(outputDirectory, `m9-text-receiver-${test.info().project.name}.png`),
        fullPage: true,
      })
    }

    await receiver.getByRole('button', { name: '复制文本' }).click()
    await expect(receiver.getByRole('status').filter({ hasText: '文本已复制' })).toBeVisible()
    await receiver.getByRole('button', { name: '完成' }).click()
    await expect(receiver.getByRole('heading', { name: '等待对方发送' })).toBeVisible()
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})
