import { expect, test } from '@playwright/test'
import { mkdir, open } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  connectSingleReceiverRoom,
  currentDirectory,
} from './transfer.helper'
import { injectRecoverableWriteFailure } from './transfer-storage.helper'

test('a denied save permission keeps the incoming offer and shows a specific action', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'file system picker runs once on desktop')
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  const sourcePath = testInfo.outputPath('permission-denied-stream.bin')
  const source = await open(sourcePath, 'w')
  await source.truncate(100 * 1024 * 1024 + 1)
  await source.close()

  await receiver.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => {
        throw new DOMException('permission denied by test', 'NotAllowedError')
      },
    })
  })

  try {
    await connectSingleReceiverRoom(owner, receiver)
    await owner.locator('#transfer-file-input').setInputFiles(sourcePath)
    const transferDialog = receiver.getByRole('dialog', { name: '接收文件' })
    await expect(transferDialog).toBeVisible()
    await transferDialog.getByRole('button', { name: '选择位置并接收' }).click()

    await expect(receiver.getByText('文件访问权限已失效，请重新授权')).toBeVisible()
    await expect(transferDialog).toBeVisible()
    if (process.env.CAPTURE_TRANSFER === '1') {
      const outputDirectory = resolve(currentDirectory, '../docs/release/screenshots')
      await mkdir(outputDirectory, { recursive: true })
      await receiver.screenshot({
        path: resolve(
          outputDirectory,
          `m8-storage-permission-error-${test.info().project.name}.png`,
        ),
        fullPage: true,
      })
    }
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})

test('cancelling a pending disk write awaits abort and never acknowledges the segment', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'stream cancellation runs once on desktop')
  test.slow()
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  const sourcePath = testInfo.outputPath('cancel-pending-write.bin')
  const source = await open(sourcePath, 'w')
  await source.truncate(100 * 1024 * 1024 + 1)
  await source.close()

  await receiver.addInitScript(() => {
    const state = {
      abortFinished: false,
      abortStarted: false,
      acknowledgements: 0,
      writeStarted: false,
    }
    let rejectWrite: ((reason?: unknown) => void) | undefined
    Object.defineProperty(window, '__cancelWriteState', { value: state })
    const originalSend = RTCDataChannel.prototype.send
    Object.defineProperty(RTCDataChannel.prototype, 'send', {
      configurable: true,
      value(this: RTCDataChannel, data: unknown) {
        if (typeof data === 'string') {
          try {
            const message = JSON.parse(data) as { type?: string }
            if (message.type === 'segment_ack') {
              state.acknowledgements += 1
            }
          } catch {
            // Binary frames and non-control strings are irrelevant to this assertion.
          }
        }
        originalSend.call(this, data as never)
      },
    })
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({
        createWritable: async () => ({
          abort: async () => {
            state.abortStarted = true
            rejectWrite?.(new DOMException('write aborted by test', 'AbortError'))
            await Promise.resolve()
            state.abortFinished = true
          },
          close: async () => {},
          write: async () => {
            state.writeStarted = true
            await new Promise<never>((_resolve, reject) => {
              rejectWrite = reject
            })
          },
        }),
      }),
    })
  })

  try {
    await connectSingleReceiverRoom(owner, receiver)
    await owner.locator('#transfer-file-input').setInputFiles(sourcePath)
    const transferDialog = receiver.getByRole('dialog', { name: '接收文件' })
    await transferDialog.getByRole('button', { name: '选择位置并接收' }).click()
    await expect
      .poll(() =>
        receiver.evaluate(
          () =>
            (window as unknown as {
              __cancelWriteState: { writeStarted: boolean }
            }).__cancelWriteState.writeStarted,
        ),
      )
      .toBe(true)

    await receiver.getByRole('button', { name: '取消传输' }).click()
    await expect(receiver.getByRole('heading', { name: '传输已取消' })).toBeVisible()
    await expect(owner.getByRole('heading', { name: '传输已取消' })).toBeVisible()
    if (process.env.CAPTURE_TRANSFER === '1') {
      const outputDirectory = resolve(currentDirectory, '../docs/release/screenshots')
      await mkdir(outputDirectory, { recursive: true })
      await receiver.screenshot({
        path: resolve(outputDirectory, `m8-pending-write-cancelled-${test.info().project.name}.png`),
        fullPage: true,
      })
    }
    const state = await receiver.evaluate(
      () =>
        (window as unknown as {
          __cancelWriteState: {
            abortFinished: boolean
            abortStarted: boolean
            acknowledgements: number
          }
        }).__cancelWriteState,
    )
    expect(state).toEqual({
      abortFinished: true,
      abortStarted: true,
      acknowledgements: 0,
      writeStarted: true,
    })
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})

test('a quota failure pauses at the durable checkpoint and resumes without another picker', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'storage recovery runs once on desktop')
  test.slow()
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  const sourceSize = 100 * 1024 * 1024 + 1
  const fileName = 'quota-pause-resume.bin'
  const sourcePath = testInfo.outputPath(fileName)
  const source = await open(sourcePath, 'w')
  await source.truncate(sourceSize)
  await source.close()
  await injectRecoverableWriteFailure(receiver, {
    errorName: 'QuotaExceededError',
    fileName,
  })

  try {
    await connectSingleReceiverRoom(owner, receiver)
    await owner.locator('#transfer-file-input').setInputFiles(sourcePath)
    const transferDialog = receiver.getByRole('dialog', { name: '接收文件' })
    await transferDialog.getByRole('button', { name: '选择位置并接收' }).click()

    await expect(receiver.getByRole('heading', { name: '存储空间不足' })).toBeVisible()
    await expect(owner.getByRole('heading', { name: '接收方存储空间不足' })).toBeVisible()
    await expect(receiver.getByRole('button', { name: '释放空间后继续接收' })).toBeVisible()
    await expect(receiver.getByText('0 B / 100.00 MiB')).toBeVisible()
    if (process.env.CAPTURE_TRANSFER === '1') {
      const outputDirectory = resolve(currentDirectory, '../docs/release/screenshots')
      await mkdir(outputDirectory, { recursive: true })
      await receiver.screenshot({
        path: resolve(outputDirectory, `m8-storage-quota-paused-${test.info().project.name}.png`),
        fullPage: true,
      })
    }

    await receiver.getByRole('button', { name: '释放空间后继续接收' }).click()
    await expect(owner.getByRole('heading', { name: '文件发送完成' })).toBeVisible({
      timeout: 60_000,
    })
    await expect(receiver.getByRole('heading', { name: '文件接收完成' })).toBeVisible()

    const result = await receiver.evaluate(async ({ expectedName }) => {
      const state = (window as unknown as {
        __recoverableStorageState: {
          aborts: number
          acknowledgements: number
          acknowledgementsAtPause: number
          failureInjected: boolean
          pauseReasons: string[]
          pickerCount: number
          resumeBytes: number
        }
      }).__recoverableStorageState
      const storage = navigator.storage as unknown as {
        getDirectory: () => Promise<{
          getFileHandle: (name: string) => Promise<FileSystemFileHandle>
        }>
      }
      const root = await storage.getDirectory()
      const handle = await root.getFileHandle(expectedName)
      return { ...state, fileSize: (await handle.getFile()).size }
    }, { expectedName: fileName })
    expect(result).toMatchObject({
      aborts: 1,
      acknowledgementsAtPause: 0,
      failureInjected: true,
      fileSize: sourceSize,
      pauseReasons: ['destination_quota_exceeded'],
      pickerCount: 1,
      resumeBytes: 0,
    })
    expect(result.acknowledgements).toBeGreaterThan(0)
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})

test('a revoked write permission pauses with reauthorization and remains cancellable', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'storage recovery runs once on desktop')
  test.slow()
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  const fileName = 'permission-pause.bin'
  const sourcePath = testInfo.outputPath(fileName)
  const source = await open(sourcePath, 'w')
  await source.truncate(100 * 1024 * 1024 + 1)
  await source.close()
  await injectRecoverableWriteFailure(receiver, {
    errorName: 'NotAllowedError',
    fileName,
  })

  try {
    await connectSingleReceiverRoom(owner, receiver)
    await owner.locator('#transfer-file-input').setInputFiles(sourcePath)
    const transferDialog = receiver.getByRole('dialog', { name: '接收文件' })
    await transferDialog.getByRole('button', { name: '选择位置并接收' }).click()

    await expect(receiver.getByRole('heading', { name: '保存权限已失效' })).toBeVisible()
    await expect(owner.getByRole('heading', { name: '接收方保存权限已失效' })).toBeVisible()
    await expect(receiver.getByRole('button', { name: '重新授权' })).toBeVisible()
    const state = await receiver.evaluate(
      () =>
        (window as unknown as {
          __recoverableStorageState: {
            acknowledgementsAtPause: number
            pauseReasons: string[]
          }
        }).__recoverableStorageState,
    )
    expect(state).toMatchObject({
      acknowledgementsAtPause: 0,
      pauseReasons: ['destination_permission_denied'],
    })

    await receiver.getByRole('button', { name: '取消传输' }).click()
    await expect(receiver.getByRole('heading', { name: '传输已取消' })).toBeVisible()
    await expect(owner.getByRole('heading', { name: '传输已取消' })).toBeVisible()
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})
