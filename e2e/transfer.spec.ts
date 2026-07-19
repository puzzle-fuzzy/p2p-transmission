import { expect, test } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { approveRoomJoin, createRoom, requestRoomJoin } from './room.helper'
import {
  connectSingleReceiverRoom,
  currentDirectory,
  useFileInputFallback,
} from './transfer.helper'

test('a file is transferred over the DataChannel and verified before download', { tag: '@smoke' }, async ({
  browser,
  baseURL,
}) => {
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  await receiver.addInitScript(() => {
    const notifications: Array<{ body: string; tag: string; title: string }> = []
    class TestNotification {
      static permission: NotificationPermission = 'granted'

      constructor(title: string, options?: NotificationOptions) {
        notifications.push({
          body: options?.body ?? '',
          tag: options?.tag ?? '',
          title,
        })
      }
    }
    Object.defineProperty(window, '__testNotifications', { value: notifications })
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: TestNotification,
    })
  })
  const payload = Buffer.alloc(128 * 1024 + 37)
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (index * 31 + 17) % 256
  }

  try {
    await connectSingleReceiverRoom(owner, receiver)
    await owner.locator('#transfer-file-input').setInputFiles({
      name: 'm6-transfer.bin',
      mimeType: 'application/octet-stream',
      buffer: payload,
    })

    const transferDialog = receiver.getByRole('dialog', { name: '接收文件' })
    await expect(transferDialog).toBeVisible()
    await expect(transferDialog).toContainText('m6-transfer.bin')
    await expect(transferDialog).toContainText('128.0 KiB')
    await expect.poll(() => receiver.evaluate(() => (
      window as unknown as {
        __testNotifications: Array<{ body: string; title: string }>
      }
    ).__testNotifications)).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: '收到文件：m6-transfer.bin', title: '收到文件请求' }),
    ]))
    await transferDialog.getByRole('button', { name: '接收文件' }).click()

    await expect(owner.getByRole('heading', { name: '文件发送完成' })).toBeVisible()
    await expect(receiver.getByRole('heading', { name: '文件接收完成' })).toBeVisible()
    const ownerFileProgress = owner.getByRole('progressbar', {
      name: 'm6-transfer.bin 传输进度',
    })
    await expect(ownerFileProgress).toHaveAttribute('aria-valuenow', '100')
    const ownerFilePresentation = await ownerFileProgress.evaluate(element => {
      const progressStyle = getComputedStyle(element)
      const rowStyle = getComputedStyle(element.parentElement as HTMLElement)
      return {
        accentFaint: getComputedStyle(document.documentElement)
          .getPropertyValue('--accent-faint')
          .trim(),
        borderBottomWidth: rowStyle.borderBottomWidth,
        borderTopWidth: rowStyle.borderTopWidth,
        progressBackground: progressStyle.backgroundColor,
      }
    })
    expect(ownerFilePresentation).toMatchObject({
      borderBottomWidth: '1px',
      borderTopWidth: '1px',
    })
    expect(ownerFilePresentation.progressBackground).toBe(ownerFilePresentation.accentFaint)
    await expect.poll(() => ownerFileProgress.evaluate(element => (
      getComputedStyle(element).transform
    ))).toBe('matrix(1, 0, 0, 1, 0, 0)')
    await expect(owner.locator('.transfer-progress')).toHaveCount(0)
    await expect.poll(() => receiver.evaluate(() => (
      window as unknown as {
        __testNotifications: Array<{ body: string; title: string }>
      }
    ).__testNotifications)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        body: 'm6-transfer.bin 已通过完整性校验',
        title: '文件接收完成',
      }),
    ]))

    const ownerVerification = owner.getByText('校验通过')
    const receiverVerification = receiver.getByText('校验通过')
    await expect(ownerVerification).toHaveAttribute('title', /^BLAKE3 [a-f0-9]{64}$/)
    await expect(receiverVerification).toHaveAttribute('title', /^BLAKE3 [a-f0-9]{64}$/)

    if (process.env.CAPTURE_TRANSFER === '1') {
      const outputDirectory = resolve(currentDirectory, '../docs/release/screenshots')
      await mkdir(outputDirectory, { recursive: true })
      await owner.screenshot({
        path: resolve(outputDirectory, `m6-transfer-owner-${test.info().project.name}.png`),
        fullPage: true,
      })
      await receiver.screenshot({
        path: resolve(outputDirectory, `m6-transfer-receiver-${test.info().project.name}.png`),
        fullPage: true,
      })
    }

    const download = receiver.getByRole('link', { name: '保存文件' })
    await expect(download).toHaveAttribute('download', 'm6-transfer.bin')
    const [browserDownload] = await Promise.all([
      receiver.waitForEvent('download'),
      download.click(),
    ])
    const downloadPath = await browserDownload.path()
    if (!downloadPath) {
      throw new Error('Playwright did not expose the downloaded file path')
    }
    expect(await readFile(downloadPath)).toEqual(payload)

    await owner.locator('#transfer-file-input').setInputFiles({
      name: '空文件-未知类型.dat',
      mimeType: 'application/x-unknown',
      buffer: Buffer.alloc(0),
    })
    const emptyTransferDialog = receiver.getByRole('dialog', { name: '接收文件' })
    await expect(emptyTransferDialog).toContainText('空文件-未知类型.dat')
    await expect(emptyTransferDialog).toContainText('0 B')
    await emptyTransferDialog.getByRole('button', { name: '接收文件' }).click()
    await expect(owner.getByRole('heading', { name: '文件发送完成' })).toBeVisible()
    await expect(receiver.getByRole('heading', { name: '文件接收完成' })).toBeVisible()
    await expect(receiver.getByRole('link', { name: '保存文件' })).toHaveAttribute(
      'download',
      '空文件-未知类型.dat',
    )
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})

test('the sender can cancel an offered file before acceptance', async ({ browser, baseURL }) => {
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()

  try {
    await connectSingleReceiverRoom(owner, receiver)
    await owner.locator('#transfer-file-input').setInputFiles({
      name: 'cancelled.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(1024, 7),
    })
    await expect(receiver.getByRole('dialog', { name: '接收文件' })).toBeVisible()
    await owner.getByRole('button', { name: '取消传输' }).click()

    await expect(receiver.getByRole('dialog', { name: '接收文件' })).toBeHidden()
    await expect(owner.getByRole('heading', { name: '传输已取消' })).toBeVisible()
    await expect(receiver.getByRole('heading', { name: '传输已取消' })).toBeVisible()
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})

test('the receiver can reject a file without leaving the room', async ({ browser, baseURL }) => {
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()

  try {
    await connectSingleReceiverRoom(owner, receiver)
    await owner.locator('#transfer-file-input').setInputFiles({
      name: 'declined.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not accepted'),
    })

    const transferDialog = receiver.getByRole('dialog', { name: '接收文件' })
    await expect(transferDialog).toBeVisible()
    await transferDialog.getByRole('button', { name: '拒绝接收' }).click()

    await expect(owner.getByRole('heading', { name: '接收者已拒绝' })).toBeVisible()
    await expect(receiver.getByRole('heading', { name: '已拒绝接收' })).toBeVisible()
    await expect(owner.locator('#transfer-file-input')).toHaveCount(1)
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})

test('the sender can target one receiver and then send independently to both', async ({
  browser,
  baseURL,
}) => {
  const ownerContext = await browser.newContext({ baseURL })
  const firstReceiverContext = await browser.newContext({ baseURL })
  const secondReceiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const firstReceiver = await firstReceiverContext.newPage()
  const secondReceiver = await secondReceiverContext.newPage()
  await useFileInputFallback(owner)

  try {
    const roomCode = await createRoom(owner)

    const receiverNames: string[] = []
    for (const [index, receiver] of [firstReceiver, secondReceiver].entries()) {
      await requestRoomJoin(receiver, roomCode)
      receiverNames.push((await receiver.locator('.participant-name').textContent())?.trim() ?? '')
      const requestDialog = await approveRoomJoin(owner)
      await expect(requestDialog).toBeHidden()
      await expect(owner.getByRole('status', {
        name: `${String(index + 1)} 位接收者已连接`,
      })).toBeVisible()
    }

    await expect(owner.getByRole('status', { name: '2 位接收者已连接' })).toBeVisible()
    await expect(owner.getByRole('heading', { name: '选择要发送的文件' })).toBeVisible({
      timeout: 30_000,
    })

    await owner.getByRole('button', { name: '选择接收者，已选择 2 位' }).click()
    const firstPicker = owner.getByRole('dialog', { name: '选择接收者' })
    await expect(firstPicker).toBeVisible()
    if (process.env.CAPTURE_TRANSFER === '1') {
      await owner.waitForTimeout(250)
      const outputDirectory = resolve(currentDirectory, '../docs/release/screenshots')
      await mkdir(outputDirectory, { recursive: true })
      await owner.screenshot({
        path: resolve(outputDirectory, `m7-recipient-picker-${test.info().project.name}.png`),
        fullPage: true,
      })
    }
    await firstPicker.getByRole('checkbox', { name: receiverNames[1] }).uncheck()
    await firstPicker.getByRole('button', { name: '确定' }).click()

    await owner.locator('#transfer-file-input').setInputFiles({
      name: 'targeted.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('only the first receiver'),
    })
    const targetedDialog = firstReceiver.getByRole('dialog', { name: '接收文件' })
    await expect(targetedDialog).toContainText('targeted.txt')
    await expect(secondReceiver.getByRole('dialog', { name: '接收文件' })).toHaveCount(0)
    await targetedDialog.getByRole('button', { name: '接收文件' }).click()
    await expect(owner.getByRole('heading', { name: '文件发送完成' })).toBeVisible()

    await owner.getByRole('button', { name: '选择接收者，已选择 1 位' }).click()
    const secondPicker = owner.getByRole('dialog', { name: '选择接收者' })
    await secondPicker.getByRole('checkbox', { name: receiverNames[1] }).check()
    await secondPicker.getByRole('button', { name: '确定' }).click()

    await owner.locator('#transfer-file-input').setInputFiles({
      name: 'broadcast.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('both receivers decide independently'),
    })
    const firstBroadcastDialog = firstReceiver.getByRole('dialog', { name: '接收文件' })
    const secondBroadcastDialog = secondReceiver.getByRole('dialog', { name: '接收文件' })
    await expect(firstBroadcastDialog).toContainText('broadcast.txt')
    await expect(secondBroadcastDialog).toContainText('broadcast.txt')
    await firstBroadcastDialog.getByRole('button', { name: '接收文件' }).click()
    await secondBroadcastDialog.getByRole('button', { name: '拒绝接收' }).click()

    await expect(owner.getByRole('heading', { name: '本次发送已结束' })).toBeVisible()
    await expect(owner.getByLabel('接收者传输结果').getByText('已完成')).toBeVisible()
    await expect(owner.getByLabel('接收者传输结果').getByText('已拒绝')).toBeVisible()
    await expect(firstReceiver.getByRole('heading', { name: '文件接收完成' })).toBeVisible()
    await expect(secondReceiver.getByRole('heading', { name: '已拒绝接收' })).toBeVisible()
    if (process.env.CAPTURE_TRANSFER === '1') {
      const outputDirectory = resolve(currentDirectory, '../docs/release/screenshots')
      await owner.screenshot({
        path: resolve(outputDirectory, `m7-multi-result-${test.info().project.name}.png`),
        fullPage: true,
      })
    }
  } finally {
    await secondReceiverContext.close()
    await firstReceiverContext.close()
    await ownerContext.close()
  }
})
