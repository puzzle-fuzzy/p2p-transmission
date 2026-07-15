import { expect, test, type Page } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

const sha256File = async (path: string) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

const connectSingleReceiverRoom = async (owner: Page, receiver: Page) => {
  await owner.goto('/')
  await owner.getByRole('button', { name: '创建房间' }).click()
  const roomCode = (await owner.getByRole('button', { name: /复制房间码/ }).textContent())?.trim()
  expect(roomCode).toMatch(/^[A-Z2-9]{6}$/)

  await receiver.goto('/')
  await receiver.getByRole('textbox', { name: '输入 6 位房间码' }).fill(roomCode ?? '')
  await receiver.getByRole('button', { name: '请求加入' }).click()
  const requestDialog = owner.getByRole('dialog', { name: '加入申请' })
  await expect(requestDialog).toBeVisible()
  await requestDialog.getByRole('button', { name: '允许加入' }).click()

  await expect(owner.getByRole('heading', { name: '选择要发送的文件' })).toBeVisible()
  await expect(receiver.getByRole('heading', { name: '等待对方发送' })).toBeVisible()
}

const injectRecoverableWriteFailure = async (
  receiver: Page,
  options: { errorName: 'NotAllowedError' | 'QuotaExceededError'; fileName: string },
) => {
  await receiver.addInitScript(({ errorName, fileName }) => {
    const state = {
      aborts: 0,
      acknowledgements: 0,
      acknowledgementsAtPause: -1,
      failureInjected: false,
      pauseReasons: [] as string[],
      pickerCount: 0,
      resumeBytes: -1,
    }
    Object.defineProperty(window, '__recoverableStorageState', { value: state })
    const originalSend = RTCDataChannel.prototype.send
    Object.defineProperty(RTCDataChannel.prototype, 'send', {
      configurable: true,
      value(this: RTCDataChannel, data: unknown) {
        if (typeof data === 'string') {
          try {
            const message = JSON.parse(data) as {
              reason?: string
              resume?: Array<{ committed_bytes: number }>
              type?: string
            }
            if (message.type === 'segment_ack') {
              state.acknowledgements += 1
            } else if (message.type === 'stream_paused') {
              state.pauseReasons.push(message.reason ?? '')
              state.acknowledgementsAtPause = state.acknowledgements
            } else if (message.type === 'stream_ready' && state.pauseReasons.length > 0) {
              state.resumeBytes = message.resume?.[0]?.committed_bytes ?? -1
            }
          } catch {
            // Binary frames and non-control strings are irrelevant here.
          }
        }
        originalSend.call(this, data as never)
      },
    })
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => {
        state.pickerCount += 1
        const storage = navigator.storage as unknown as {
          getDirectory: () => Promise<{
            getFileHandle: (
              name: string,
              options: { create: boolean },
            ) => Promise<FileSystemFileHandle>
          }>
        }
        const root = await storage.getDirectory()
        const handle = await root.getFileHandle(fileName, { create: true })
        const createWritable = handle.createWritable.bind(handle)
        Object.defineProperty(handle, 'createWritable', {
          configurable: true,
          value: async (writableOptions?: { keepExistingData?: boolean }) => {
            const writable = await createWritable(writableOptions)
            return {
              abort: async () => {
                state.aborts += 1
                await writable.abort()
              },
              close: async () => writable.close(),
              write: async (command: unknown) => {
                if (!state.failureInjected) {
                  state.failureInjected = true
                  throw new DOMException('injected recoverable storage failure', errorName)
                }
                await writable.write(command as never)
              },
            }
          },
        })
        return handle
      },
    })
  }, options)
}

test('a file is transferred over the DataChannel and verified before download', async ({
  browser,
  baseURL,
}) => {
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
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
    await transferDialog.getByRole('button', { name: '接收文件' }).click()

    await expect(owner.getByRole('heading', { name: '文件发送完成' })).toBeVisible()
    await expect(receiver.getByRole('heading', { name: '文件接收完成' })).toBeVisible()

    const ownerVerification = owner.getByText('校验通过')
    const receiverVerification = receiver.getByText('校验通过')
    await expect(ownerVerification).toHaveAttribute('title', /^BLAKE3 [a-f0-9]{64}$/)
    await expect(receiverVerification).toHaveAttribute('title', /^BLAKE3 [a-f0-9]{64}$/)

    if (process.env.CAPTURE_V2_TRANSFER === '1') {
      const outputDirectory = resolve(currentDirectory, '../../../docs/rust-v2/screenshots')
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
    if (process.env.CAPTURE_V2_TRANSFER === '1') {
      const outputDirectory = resolve(currentDirectory, '../../../docs/rust-v2/screenshots')
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
    if (process.env.CAPTURE_V2_TRANSFER === '1') {
      const outputDirectory = resolve(currentDirectory, '../../../docs/rust-v2/screenshots')
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
    if (process.env.CAPTURE_V2_TRANSFER === '1') {
      const outputDirectory = resolve(currentDirectory, '../../../docs/rust-v2/screenshots')
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
    if (process.env.CAPTURE_V2_TRANSFER === '1') {
      const outputDirectory = resolve(currentDirectory, '../../../docs/rust-v2/screenshots')
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
    if (process.env.CAPTURE_V2_TRANSFER === '1') {
      const outputDirectory = resolve(currentDirectory, '../../../docs/rust-v2/screenshots')
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
    await connectSingleReceiverRoom(owner, receiver)
    await owner.getByRole('button', { name: '选择文件' }).click()
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

  try {
    await owner.goto('/')
    await owner.getByRole('button', { name: '创建房间' }).click()
    const roomCode = (await owner.getByRole('button', { name: /复制房间码/ }).textContent())?.trim()
    expect(roomCode).toMatch(/^[A-Z2-9]{6}$/)

    const receiverNames: string[] = []
    for (const [index, receiver] of [firstReceiver, secondReceiver].entries()) {
      await receiver.goto('/')
      await receiver.getByRole('textbox', { name: '输入 6 位房间码' }).fill(roomCode ?? '')
      await receiver.getByRole('button', { name: '请求加入' }).click()
      receiverNames.push((await receiver.locator('.participant-name').textContent())?.trim() ?? '')
      const requestDialog = owner.getByRole('dialog', { name: '加入申请' })
      await expect(requestDialog).toBeVisible()
      await requestDialog.getByRole('button', { name: '允许加入' }).click()
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
    if (process.env.CAPTURE_V2_TRANSFER === '1') {
      await owner.waitForTimeout(250)
      const outputDirectory = resolve(currentDirectory, '../../../docs/rust-v2/screenshots')
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
    if (process.env.CAPTURE_V2_TRANSFER === '1') {
      const outputDirectory = resolve(currentDirectory, '../../../docs/rust-v2/screenshots')
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
