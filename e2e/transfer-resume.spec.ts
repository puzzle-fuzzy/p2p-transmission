import { expect, test } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  connectSingleReceiverRoom,
  currentDirectory,
} from './transfer.helper'

test('a streamed batch resumes the current file without retransmitting completed files', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'folder streaming runs once on desktop')
  test.slow()
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  const first = Buffer.alloc(257 * 1024, 0x31)
  const second = Buffer.alloc(8 * 1024 * 1024 + 137, 0x72)
  const third = Buffer.alloc(0)
  const expectedHashes = [first, third, second].map((payload) =>
    createHash('sha256').update(payload).digest('hex'),
  )

  await receiver.addInitScript(() => {
    type StoredFile = {
      aborted: boolean
      chunks: Uint8Array[]
      closeCount: number
      nextOffset: number
      writes: number
    }
    const state = {
      ackCount: 0,
      directoryPickers: 0,
      disconnectTriggered: false,
      files: {} as Record<string, StoredFile>,
      resume: [] as Array<{ committed_bytes: number; file_id: string }>,
    }
    Object.defineProperty(window, '__batchStreamState', { value: state })
    const originalSend = RTCDataChannel.prototype.send
    Object.defineProperty(RTCDataChannel.prototype, 'send', {
      configurable: true,
      value(this: RTCDataChannel, data: unknown) {
        let message: {
          resume?: Array<{ committed_bytes: number; file_id: string }>
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
        if (message?.type === 'stream_ready' && state.disconnectTriggered) {
          state.resume = message.resume ?? []
        }
        if (message?.type === 'segment_ack') {
          state.ackCount += 1
          if (state.ackCount === 2 && !state.disconnectTriggered) {
            state.disconnectTriggered = true
            this.close()
          }
        }
      },
    })
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => {
        state.directoryPickers += 1
        return {
          getFileHandle: async (name: string) => ({
            createWritable: async () => {
              const file = {
                aborted: false,
                chunks: [],
                closeCount: 0,
                nextOffset: 0,
                writes: 0,
              } satisfies StoredFile
              state.files[name] = file
              return {
                abort: async () => {
                  file.aborted = true
                },
                close: async () => {
                  file.closeCount += 1
                },
                write: async (command: { data: Uint8Array; position: number }) => {
                  if (command.position !== file.nextOffset) {
                    throw new Error(
                      `unexpected batch write offset ${command.position} after ${file.nextOffset}`,
                    )
                  }
                  file.chunks.push(command.data.slice())
                  file.nextOffset += command.data.byteLength
                  file.writes += 1
                },
              }
            },
          }),
        }
      },
    })
  })

  try {
    await connectSingleReceiverRoom(owner, receiver)
    await owner.locator('#transfer-file-input').setInputFiles([
      { name: 'batch-first.bin', mimeType: 'application/octet-stream', buffer: first },
      { name: 'batch-empty.bin', mimeType: 'application/octet-stream', buffer: third },
      { name: 'batch-second.bin', mimeType: 'application/octet-stream', buffer: second },
    ])

    const dialog = receiver.getByRole('dialog', { name: '接收 3 个文件' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('batch-first.bin')
    await expect(dialog).toContainText('batch-second.bin')
    await expect(dialog).toContainText('batch-empty.bin')
    await dialog.getByRole('button', { name: '选择文件夹并接收' }).click()

    await expect(owner.getByRole('heading', { name: '文件发送完成' })).toBeVisible({
      timeout: 45_000,
    })
    await expect(receiver.getByRole('heading', { name: '文件接收完成' })).toBeVisible()
    await expect(owner.getByText('全部校验通过')).toBeVisible()
    await expect(receiver.getByText('全部校验通过')).toBeVisible()

    const result = await receiver.evaluate(async () => {
      const state = (window as unknown as {
        __batchStreamState: {
          ackCount: number
          directoryPickers: number
          disconnectTriggered: boolean
          files: Record<
            string,
            {
              aborted: boolean
              chunks: Uint8Array[]
              closeCount: number
              nextOffset: number
              writes: number
            }
          >
          resume: Array<{ committed_bytes: number; file_id: string }>
        }
      }).__batchStreamState
      const files = await Promise.all(
        Object.entries(state.files).map(async ([name, file]) => {
          const bytes = new Uint8Array(file.nextOffset)
          let offset = 0
          for (const chunk of file.chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
          }
          const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')
          return {
            aborted: file.aborted,
            closeCount: file.closeCount,
            hash,
            name,
            nextOffset: file.nextOffset,
            writes: file.writes,
          }
        }),
      )
      return {
        ackCount: state.ackCount,
        directoryPickers: state.directoryPickers,
        disconnectTriggered: state.disconnectTriggered,
        files,
        resume: state.resume.map((cursor) => cursor.committed_bytes),
      }
    })

    expect(result).toMatchObject({
      ackCount: 3,
      directoryPickers: 1,
      disconnectTriggered: true,
      resume: [first.length, 0, 8 * 1024 * 1024],
    })
    expect(result.files.map((file) => file.name)).toEqual([
      'batch-first.bin',
      'batch-empty.bin',
      'batch-second.bin',
    ])
    expect(result.files.map((file) => file.nextOffset)).toEqual([
      first.length,
      third.length,
      second.length,
    ])
    expect(result.files.map((file) => file.hash)).toEqual(expectedHashes)
    for (const file of result.files) {
      expect(file).toMatchObject({ aborted: false, closeCount: 1 })
    }
    expect(result.files[0]?.writes).toBe(1)
    expect(result.files[1]?.writes).toBe(0)
    expect(result.files[2]?.writes).toBe(2)
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})

test('a file above 100 MiB resumes from its disk checkpoint after DataChannel interruption', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'streaming transfer runs once on desktop')
  test.slow()
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  const sourceSize = 100 * 1024 * 1024 + 1
  const sourcePath = testInfo.outputPath('m7-streamed-100-mib-plus-one.bin')
  const source = await open(sourcePath, 'w')
  await source.truncate(sourceSize)
  await source.close()

  await receiver.addInitScript(() => {
    const state = {
      aborted: false,
      acknowledgedBytes: 0,
      channelInterrupted: false,
      closed: false,
      disconnectTriggered: false,
      firstAcknowledgedBytes: 0,
      lifecycleTriggered: false,
      nextOffset: 0,
      recoveryAckBytes: 0,
      resumeCursorBytes: 0,
      writes: 0,
    }
    Object.defineProperty(window, '__streamWriteState', { value: state })
    const channels: RTCDataChannel[] = []
    const originalSend = RTCDataChannel.prototype.send
    Object.defineProperty(RTCDataChannel.prototype, 'send', {
      configurable: true,
      value(this: RTCDataChannel, data: unknown) {
        if (channels.at(-1) !== this) channels.push(this)
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
        if (
          message?.type === 'stream_ready'
          && state.lifecycleTriggered
          && state.resumeCursorBytes === 0
        ) {
          state.recoveryAckBytes = state.acknowledgedBytes
          state.resumeCursorBytes = message.resume?.[0]?.committed_bytes ?? 0
        }
        if (message?.type === 'segment_ack') {
          state.acknowledgedBytes = message.committed_bytes ?? 0
          if (!state.disconnectTriggered) {
            state.firstAcknowledgedBytes = state.acknowledgedBytes
            state.disconnectTriggered = true
          }
        }
      },
    })
    Object.defineProperty(window, '__interruptStreamChannel', {
      value: () => {
        const activeChannel = channels.at(-1)
        if (!activeChannel) throw new Error('stream DataChannel is unavailable')
        state.channelInterrupted = true
        activeChannel.close()
      },
    })
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({
        createWritable: async () => ({
          abort: async () => {
            state.aborted = true
          },
          close: async () => {
            state.closed = true
          },
          write: async (command: { data: Uint8Array; position: number }) => {
            if (command.position !== state.nextOffset) {
              throw new Error(`unexpected write offset ${command.position}`)
            }
            state.nextOffset += command.data.byteLength
            state.writes += 1
          },
        }),
      }),
    })
  })

  try {
    await connectSingleReceiverRoom(owner, receiver)
    await owner.evaluate(() => {
      const state = { waitingSeen: false }
      Object.defineProperty(window, '__streamRecoveryUiState', { value: state })
      const inspect = () => {
        if (document.body.textContent?.includes('等待对端恢复')) {
          state.waitingSeen = true
        }
      }
      new MutationObserver(inspect).observe(document.body, {
        characterData: true,
        childList: true,
        subtree: true,
      })
      inspect()
    })
    await owner.locator('#transfer-file-input').setInputFiles(sourcePath)
    const transferDialog = receiver.getByRole('dialog', { name: '接收文件' })
    await expect(transferDialog).toContainText('m7-streamed-100-mib-plus-one.bin')
    await expect(transferDialog).toContainText('数据会直接写入磁盘')
    if (process.env.CAPTURE_TRANSFER === '1') {
      const outputDirectory = resolve(currentDirectory, '../docs/release/screenshots')
      await mkdir(outputDirectory, { recursive: true })
      await receiver.screenshot({
        path: resolve(outputDirectory, `m7-stream-storage-dialog-${test.info().project.name}.png`),
        fullPage: true,
      })
    }
    await transferDialog.getByRole('button', { name: '选择位置并接收' }).click()

    await expect.poll(async () => receiver.evaluate(() =>
      (window as unknown as {
        __streamWriteState: { firstAcknowledgedBytes: number }
      }).__streamWriteState.firstAcknowledgedBytes,
    )).toBe(8 * 1024 * 1024)
    await receiver.evaluate(() => {
      (window as unknown as {
        __streamWriteState: { lifecycleTriggered: boolean }
      }).__streamWriteState.lifecycleTriggered = true
      window.dispatchEvent(new Event('offline'))
      const interrupt = (window as unknown as {
        __interruptStreamChannel: () => void
      }).__interruptStreamChannel
      interrupt()
    })
    await expect(receiver.getByText('网络已断开，恢复后将从最后检查点继续传输')).toBeVisible()
    await receiverContext.setOffline(true)
    await receiver.waitForTimeout(750)
    await receiverContext.setOffline(false)

    await expect(owner.getByRole('heading', { name: '文件发送完成' })).toBeVisible({
      timeout: 45_000,
    })
    await expect(receiver.getByRole('heading', { name: '文件接收完成' })).toBeVisible()
    await expect(receiver.getByText(/文件已保存到所选位置/)).toBeVisible()
    await expect(receiver.getByRole('link', { name: '保存文件' })).toHaveCount(0)
    if (process.env.CAPTURE_TRANSFER === '1') {
      const outputDirectory = resolve(currentDirectory, '../docs/release/screenshots')
      await receiver.screenshot({
        path: resolve(outputDirectory, `m7-stream-storage-complete-${test.info().project.name}.png`),
        fullPage: true,
      })
    }
    const streamState = await receiver.evaluate(() =>
      (window as unknown as {
        __streamWriteState: {
          aborted: boolean
          acknowledgedBytes: number
          channelInterrupted: boolean
          closed: boolean
          disconnectTriggered: boolean
          firstAcknowledgedBytes: number
          lifecycleTriggered: boolean
          nextOffset: number
          recoveryAckBytes: number
          resumeCursorBytes: number
          writes: number
        }
      }).__streamWriteState,
    )
    expect(streamState).toMatchObject({
      aborted: false,
      channelInterrupted: true,
      closed: true,
      disconnectTriggered: true,
      lifecycleTriggered: true,
      nextOffset: sourceSize,
    })
    expect(streamState.firstAcknowledgedBytes).toBe(8 * 1024 * 1024)
    expect(streamState.recoveryAckBytes).toBeGreaterThanOrEqual(streamState.firstAcknowledgedBytes)
    expect(streamState.resumeCursorBytes).toBe(streamState.recoveryAckBytes)
    expect(streamState.writes).toBeGreaterThan(1)
    expect(
      await owner.evaluate(
        () =>
          (window as unknown as {
            __streamRecoveryUiState: { waitingSeen: boolean }
          }).__streamRecoveryUiState.waitingSeen,
      ),
    ).toBe(true)
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})
