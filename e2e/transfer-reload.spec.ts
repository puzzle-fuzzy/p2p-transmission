import { expect, test } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

import {
  connectSingleReceiverRoom,
  sha256File,
} from './transfer.helper'

test('a streamed receiver reloads and resumes from its persisted disk checkpoint', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'refresh recovery runs once on desktop')
  test.slow()
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  const sourceSize = 100 * 1024 * 1024 + 1
  const sourcePath = testInfo.outputPath('m7-refresh-recovery.bin')
  const source = await open(sourcePath, 'w')
  await source.truncate(sourceSize)
  await source.close()
  const expectedHash = await sha256File(sourcePath)

  await receiver.addInitScript(() => {
    type RecoveryState = {
      acknowledgedBytes: number
      pickerCount: number
      readyAfterReload: number
      reloadTriggered: boolean
      resumedBytes: number
    }
    const key = '__refreshRecoveryState'
    const state: RecoveryState = JSON.parse(
      sessionStorage.getItem(key) ??
        JSON.stringify({
          acknowledgedBytes: 0,
          pickerCount: 0,
          readyAfterReload: 0,
          reloadTriggered: false,
          resumedBytes: 0,
        }),
    )
    const persist = () => sessionStorage.setItem(key, JSON.stringify(state))
    Object.defineProperty(window, '__refreshRecoveryState', { value: state })

    const originalSend = RTCDataChannel.prototype.send
    Object.defineProperty(RTCDataChannel.prototype, 'send', {
      configurable: true,
      value(this: RTCDataChannel, data: unknown) {
        let message: {
          committed_bytes?: number
          resume?: Array<{ committed_bytes: number }>
          type?: string
        } | null = null
        if (typeof data === 'string') {
          try {
            message = JSON.parse(data)
          } catch {
            message = null
          }
        }
        originalSend.call(this, data as never)
        if (message?.type === 'stream_ready' && state.reloadTriggered) {
          state.readyAfterReload += 1
          state.resumedBytes = message.resume?.[0]?.committed_bytes ?? 0
          persist()
        }
        if (message?.type === 'segment_ack' && !state.reloadTriggered) {
          state.acknowledgedBytes = message.committed_bytes ?? 0
          state.reloadTriggered = true
          persist()
          window.setTimeout(() => window.location.reload(), 0)
        }
      },
    })

    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => {
        state.pickerCount += 1
        persist()
        const storage = navigator.storage as unknown as {
          getDirectory: () => Promise<{
            getFileHandle: (
              name: string,
              options: { create: boolean },
            ) => Promise<FileSystemFileHandle>
          }>
        }
        const root = await storage.getDirectory()
        return root.getFileHandle('m7-refresh-recovery.bin', { create: true })
      },
    })
  })

  try {
    await connectSingleReceiverRoom(owner, receiver)
    await owner.locator('#transfer-file-input').setInputFiles(sourcePath)
    const transferDialog = receiver.getByRole('dialog', { name: '接收文件' })
    await expect(transferDialog).toContainText('m7-refresh-recovery.bin')
    await transferDialog.getByRole('button', { name: '选择位置并接收' }).click()

    await expect
      .poll(
        () =>
          receiver.evaluate(() =>
            JSON.parse(sessionStorage.getItem('__refreshRecoveryState') ?? '{}'),
          ),
        { timeout: 30_000 },
      )
      .toMatchObject({ reloadTriggered: true })
    await expect(owner.getByRole('heading', { name: '文件发送完成' })).toBeVisible({
      timeout: 60_000,
    })
    await expect(receiver.getByRole('heading', { name: '文件接收完成' })).toBeVisible()

    const result = await receiver.evaluate(async () => {
      const state = JSON.parse(
        sessionStorage.getItem('__refreshRecoveryState') ?? '{}',
      ) as {
        acknowledgedBytes: number
        pickerCount: number
        readyAfterReload: number
        reloadTriggered: boolean
        resumedBytes: number
      }
      const storage = navigator.storage as unknown as {
        getDirectory: () => Promise<{
          getFileHandle: (name: string) => Promise<FileSystemFileHandle>
        }>
      }
      const root = await storage.getDirectory()
      const handle = await root.getFileHandle('m7-refresh-recovery.bin')
      const file = await handle.getFile()
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
      )
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
      return { ...state, fileSize: file.size, hash }
    })
    expect(result).toMatchObject({
      acknowledgedBytes: 8 * 1024 * 1024,
      fileSize: sourceSize,
      hash: expectedHash,
      pickerCount: 1,
      readyAfterReload: 1,
      resumedBytes: 8 * 1024 * 1024,
    })
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})

test('a streamed sender reloads and resumes from its persisted source checkpoint', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'sender refresh recovery runs once on desktop')
  test.slow()
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  const sourceSize = 100 * 1024 * 1024 + 1
  const expected = createHash('sha256')
  const zeroChunk = Buffer.alloc(1024 * 1024)
  for (let remaining = sourceSize; remaining > 0; remaining -= zeroChunk.length) {
    expected.update(zeroChunk.subarray(0, Math.min(remaining, zeroChunk.length)))
  }
  const expectedHash = expected.digest('hex')

  await owner.addInitScript((size) => {
    type SenderRecoveryState = {
      pickerCount: number
    }
    const key = '__senderRefreshRecoveryState'
    const state: SenderRecoveryState = JSON.parse(
      sessionStorage.getItem(key) ?? JSON.stringify({ pickerCount: 0 }),
    )
    const persist = () => sessionStorage.setItem(key, JSON.stringify(state))
    Object.defineProperty(window, '__senderRefreshRecoveryState', { value: state })
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: async () => {
        state.pickerCount += 1
        persist()
        const storage = navigator.storage as unknown as {
          getDirectory: () => Promise<{
            getFileHandle: (
              name: string,
              options: { create: boolean },
            ) => Promise<FileSystemFileHandle>
          }>
        }
        const root = await storage.getDirectory()
        const handle = await root.getFileHandle('m7-sender-refresh-recovery.bin', { create: true })
        const file = await handle.getFile()
        if (file.size !== size) {
          const writable = await handle.createWritable()
          await writable.truncate(size)
          await writable.close()
        }
        return [handle]
      },
    })
  }, sourceSize)

  await receiver.exposeFunction('__reloadOwnerAfterFirstAck', async () => {
    await owner.reload()
  })
  await receiver.addInitScript(() => {
    const state = {
      acknowledgedBytes: 0,
      readyAfterReload: 0,
      reloadTriggered: false,
      resumedBytes: 0,
    }
    Object.defineProperty(window, '__senderRecoveryReceiverState', { value: state })
    const originalSend = RTCDataChannel.prototype.send
    Object.defineProperty(RTCDataChannel.prototype, 'send', {
      configurable: true,
      value(this: RTCDataChannel, data: unknown) {
        let message: {
          committed_bytes?: number
          resume?: Array<{ committed_bytes: number }>
          type?: string
        } | null = null
        if (typeof data === 'string') {
          try {
            message = JSON.parse(data)
          } catch {
            message = null
          }
        }
        originalSend.call(this, data as never)
        if (message?.type === 'stream_ready' && state.reloadTriggered) {
          state.readyAfterReload += 1
          state.resumedBytes = message.resume?.[0]?.committed_bytes ?? 0
        }
        if (message?.type === 'segment_ack' && !state.reloadTriggered) {
          state.acknowledgedBytes = message.committed_bytes ?? 0
          state.reloadTriggered = true
          void (window as unknown as {
            __reloadOwnerAfterFirstAck: () => Promise<void>
          }).__reloadOwnerAfterFirstAck()
          window.setTimeout(() => this.close(), 0)
        }
      },
    })
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => {
        const storage = navigator.storage as unknown as {
          getDirectory: () => Promise<{
            getFileHandle: (
              name: string,
              options: { create: boolean },
            ) => Promise<FileSystemFileHandle>
          }>
        }
        const root = await storage.getDirectory()
        return root.getFileHandle('m7-sender-refresh-output.bin', { create: true })
      },
    })
  })

  try {
    await connectSingleReceiverRoom(owner, receiver, { persistentSource: true })
    await expect(owner.locator('#transfer-file-input')).toHaveCount(0)
    const persistentFilePicker = owner.getByRole('button', { name: '选择文件' })
    await expect(persistentFilePicker).toHaveCount(1)
    await persistentFilePicker.click()
    const transferDialog = receiver.getByRole('dialog', { name: '接收文件' })
    await expect(transferDialog).toContainText('m7-sender-refresh-recovery.bin')
    await transferDialog.getByRole('button', { name: '选择位置并接收' }).click()

    await expect
      .poll(
        () =>
          receiver.evaluate(() =>
            (window as unknown as {
              __senderRecoveryReceiverState: { reloadTriggered: boolean }
            }).__senderRecoveryReceiverState,
          ),
        { timeout: 30_000 },
      )
      .toMatchObject({ reloadTriggered: true })
    await expect(owner.getByRole('heading', { name: '文件发送完成' })).toBeVisible({
      timeout: 60_000,
    })
    await expect(receiver.getByRole('heading', { name: '文件接收完成' })).toBeVisible()

    const ownerState = await owner.evaluate(() =>
      JSON.parse(sessionStorage.getItem('__senderRefreshRecoveryState') ?? '{}'),
    )
    expect(ownerState).toMatchObject({ pickerCount: 1 })
    const result = await receiver.evaluate(async () => {
      const state = (window as unknown as {
        __senderRecoveryReceiverState: {
          acknowledgedBytes: number
          readyAfterReload: number
          resumedBytes: number
        }
      }).__senderRecoveryReceiverState
      const storage = navigator.storage as unknown as {
        getDirectory: () => Promise<{
          getFileHandle: (name: string) => Promise<FileSystemFileHandle>
        }>
      }
      const root = await storage.getDirectory()
      const handle = await root.getFileHandle('m7-sender-refresh-output.bin')
      const file = await handle.getFile()
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
      )
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
      return { ...state, fileSize: file.size, hash }
    })
    expect(result).toMatchObject({
      acknowledgedBytes: 8 * 1024 * 1024,
      fileSize: sourceSize,
      hash: expectedHash,
      readyAfterReload: 1,
      resumedBytes: 8 * 1024 * 1024,
    })
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})
