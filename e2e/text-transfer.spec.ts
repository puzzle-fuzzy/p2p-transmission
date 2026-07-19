import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { connectSingleReceiverRoom } from './room.helper'
import { currentDirectory } from './transfer.helper'

test('text is withheld until consent and delivered exactly over the DataChannel', { tag: '@smoke' }, async ({
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

    const firstRequest = receiver.getByRole('dialog', { name: '接收文本' })
    await expect(firstRequest).toBeVisible()
    await expect(firstRequest).toContainText(`${[...payload].length}`)
    await expect(firstRequest).not.toContainText(payload)
    await expect(receiver.getByText(payload, { exact: true })).toHaveCount(0)
    await firstRequest.getByRole('button', { name: '拒绝接收' }).click()

    await expect(owner.getByLabel('文本发送状态').getByText('已拒绝')).toBeVisible()
    await expect(receiver.getByRole('heading', { name: '已拒绝文本' })).toBeVisible()
    await receiver.getByRole('button', { name: '返回等待' }).click()

    await composer.fill(payload)
    await owner.getByRole('button', { name: '发送文本' }).click()
    const secondRequest = receiver.getByRole('dialog', { name: '接收文本' })
    await expect(secondRequest).toBeVisible()
    await expect(secondRequest).not.toContainText(payload)
    await secondRequest.getByRole('button', { name: '接收文本' }).click()

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
