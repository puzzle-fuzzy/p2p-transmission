import { expect, test, type Page } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { open, rm, writeFile } from 'node:fs/promises'

const GIB = 1024 ** 3
const MIB = 1024 ** 2
const SEGMENT_BYTES = 8 * MIB
const stressEnabled = process.env.P2P_STRESS_GIB !== undefined
const sizeGiB = Number(process.env.P2P_STRESS_GIB ?? 1)
const delayMs = Number(process.env.P2P_STRESS_DELAY_MS ?? 0)
const disconnectCount = Number(process.env.P2P_STRESS_DISCONNECTS ?? 0)
const sinkMode = process.env.P2P_STRESS_SINK ?? 'opfs'
const sinkUrl = process.env.P2P_STRESS_SINK_URL ?? ''

if (stressEnabled && ![1, 5].includes(sizeGiB)) {
  throw new Error('P2P_STRESS_GIB must be 1 or 5; use scripts/test_large_file.py')
}
if (!Number.isInteger(delayMs) || delayMs < 0) {
  throw new Error('P2P_STRESS_DELAY_MS must be a non-negative integer')
}
if (!Number.isInteger(disconnectCount) || disconnectCount < 0 || disconnectCount > 8) {
  throw new Error('P2P_STRESS_DISCONNECTS must be an integer between 0 and 8')
}
if (!['native', 'opfs'].includes(sinkMode) || (sinkMode === 'native' && !sinkUrl)) {
  throw new Error('P2P_STRESS_SINK must be opfs or native with P2P_STRESS_SINK_URL')
}

const connectSingleReceiverRoom = async (owner: Page, receiver: Page) => {
  await owner.goto('/app')
  await owner.getByRole('button', { name: '创建房间' }).click()
  const roomCode = (await owner.getByRole('button', { name: /复制房间码/ }).textContent())?.trim()
  expect(roomCode).toMatch(/^[A-Z2-9]{6}$/)

  await receiver.goto('/app')
  await receiver.getByRole('textbox', { name: '输入 6 位房间码' }).fill(roomCode ?? '')
  await receiver.getByRole('button', { name: '请求加入' }).click()
  const requestDialog = owner.getByRole('dialog', { name: '加入申请' })
  await expect(requestDialog).toBeVisible()
  await requestDialog.getByRole('button', { name: '允许加入' }).click()
  await expect(owner.getByRole('heading', { name: '选择要发送的文件' })).toBeVisible()
}

const installSenderThrottle = async (page: Page, frameDelayMs: number) => {
  if (frameDelayMs === 0) return
  await page.addInitScript(({ frameDelayMs }) => {
    type Frame = { bytes: number; data: string | ArrayBuffer }
    type ChannelQueue = { bytes: number; flushing: boolean; frames: Frame[] }
    const queues = new WeakMap<RTCDataChannel, ChannelQueue>()
    const metrics = { drainEvents: 0, frames: 0, maxQueuedBytes: 0 }
    Object.defineProperty(window, '__networkStressState', { value: metrics })
    const originalSend = RTCDataChannel.prototype.send

    const copyFrame = (data: unknown): Frame => {
      if (typeof data === 'string') {
        return { bytes: new TextEncoder().encode(data).byteLength, data }
      }
      if (data instanceof ArrayBuffer) {
        return { bytes: data.byteLength, data: data.slice(0) }
      }
      if (ArrayBuffer.isView(data)) {
        const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        return { bytes: data.byteLength, data: copy }
      }
      throw new TypeError('unsupported stress DataChannel frame')
    }

    const flush = (channel: RTCDataChannel, queue: ChannelQueue) => {
      const frame = queue.frames.shift()
      if (!frame) {
        queue.flushing = false
        return
      }
      const previousBytes = queue.bytes
      queue.bytes -= frame.bytes
      originalSend.call(channel, frame.data as never)
      metrics.frames += 1
      if (
        previousBytes > channel.bufferedAmountLowThreshold &&
        queue.bytes <= channel.bufferedAmountLowThreshold
      ) {
        metrics.drainEvents += 1
        channel.dispatchEvent(new Event('bufferedamountlow'))
      }
      window.setTimeout(() => flush(channel, queue), frameDelayMs)
    }

    Object.defineProperty(RTCDataChannel.prototype, 'send', {
      configurable: true,
      value(this: RTCDataChannel, data: unknown) {
        let queue = queues.get(this)
        if (!queue) {
          queue = { bytes: 0, flushing: false, frames: [] }
          queues.set(this, queue)
          Object.defineProperty(this, 'bufferedAmount', {
            configurable: true,
            get: () => queue?.bytes ?? 0,
          })
        }
        const frame = copyFrame(data)
        queue.frames.push(frame)
        queue.bytes += frame.bytes
        metrics.maxQueuedBytes = Math.max(metrics.maxQueuedBytes, queue.bytes)
        if (!queue.flushing) {
          queue.flushing = true
          window.setTimeout(() => flush(this, queue), frameDelayMs)
        }
      },
    })
  }, { frameDelayMs })
}

const installReceiverDisk = async (
  page: Page,
  outputName: string,
  disconnectSegments: number[],
  nativeSinkUrl: string,
) => {
  await page.addInitScript(({ disconnectSegments, nativeSinkUrl, outputName }) => {
    const state = {
      aborted: false,
      closeCount: 0,
      disconnects: 0,
      handle: null as FileSystemFileHandle | null,
      maxWriteBytes: 0,
      nextOffset: 0,
      outputName,
      resumeCursors: [] as number[],
      writes: 0,
    }
    Object.defineProperty(window, '__diskStressState', { value: state })

    const originalSend = RTCDataChannel.prototype.send
    Object.defineProperty(RTCDataChannel.prototype, 'send', {
      configurable: true,
      value(this: RTCDataChannel, data: unknown) {
        let message: {
          committed_bytes?: number
          resume?: Array<{ committed_bytes: number }>
          segment_index?: number
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
        if (message?.type === 'stream_ready' && state.disconnects > 0) {
          state.resumeCursors.push(message.resume?.[0]?.committed_bytes ?? 0)
        }
        if (
          message?.type === 'segment_ack' &&
          disconnectSegments.includes(message.segment_index ?? -1)
        ) {
          state.disconnects += 1
          window.setTimeout(() => this.close(), 0)
        }
      },
    })

    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => {
        if (nativeSinkUrl) {
          const request = async (path: string, body?: ArrayBuffer) => {
            const response = await fetch(`${nativeSinkUrl}${path}`, {
              body,
              method: 'POST',
            })
            if (!response.ok) throw new Error(await response.text())
          }
          return {
            createWritable: async () => ({
              abort: async () => {
                state.aborted = true
                await request('/abort')
              },
              close: async () => {
                await request('/close')
                state.closeCount += 1
              },
              write: async (command: { data: Uint8Array; position: number }) => {
                if (command.position !== state.nextOffset) {
                  throw new Error(
                    `non-contiguous disk write: ${command.position} after ${state.nextOffset}`,
                  )
                }
                const data = command.data.slice().buffer
                await request(`/write?offset=${command.position}`, data)
                state.nextOffset += command.data.byteLength
                state.maxWriteBytes = Math.max(state.maxWriteBytes, command.data.byteLength)
                state.writes += 1
              },
            }),
          }
        }
        const root = await navigator.storage.getDirectory()
        const handle = await root.getFileHandle(outputName, { create: true })
        state.handle = handle
        return {
          createWritable: async () => {
            const writable = await handle.createWritable({ keepExistingData: false })
            return {
              abort: async () => {
                state.aborted = true
                await writable.abort()
              },
              close: async () => {
                await writable.close()
                state.closeCount += 1
              },
              write: async (command: { data: Uint8Array; position: number }) => {
                if (command.position !== state.nextOffset) {
                  throw new Error(
                    `non-contiguous disk write: ${command.position} after ${state.nextOffset}`,
                  )
                }
                await writable.write(command)
                state.nextOffset += command.data.byteLength
                state.maxWriteBytes = Math.max(state.maxWriteBytes, command.data.byteLength)
                state.writes += 1
              },
            }
          },
        }
      },
    })
  }, { disconnectSegments, nativeSinkUrl, outputName })
}

test(`${sizeGiB} GiB streamed transfer writes to ${sinkMode} under the selected stress profile`, async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(!stressEnabled, 'Run large-file stress tests through scripts/test_large_file.py')
  test.setTimeout(sizeGiB === 5 ? 30 * 60 * 1000 : 12 * 60 * 1000)
  const sizeBytes = sizeGiB * GIB
  const segmentCount = sizeBytes / SEGMENT_BYTES
  const disconnectSegments = Array.from({ length: disconnectCount }, (_, index) =>
    index === 0 ? 0 : Math.floor((segmentCount * index) / disconnectCount),
  )
  const sourcePath = testInfo.outputPath(`m7-${sizeGiB}-gib-stress.bin`)
  const outputName = `m7-${sizeGiB}-gib-stress-output.bin`
  const markerBytes = 4096
  const markerPositions = [0, SEGMENT_BYTES - markerBytes, Math.floor(sizeBytes / 2), sizeBytes - markerBytes]
  const markers = markerPositions.map((_, markerIndex) => {
    const marker = Buffer.alloc(markerBytes)
    for (let index = 0; index < marker.length; index += 1) {
      marker[index] = (index * 31 + markerIndex * 47 + 17) % 256
    }
    return marker
  })
  const source = await open(sourcePath, 'w')
  await source.truncate(sizeBytes)
  for (const [index, position] of markerPositions.entries()) {
    await source.write(markers[index], 0, markerBytes, position)
  }
  await source.close()

  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  await installSenderThrottle(owner, delayMs)
  await installReceiverDisk(receiver, outputName, disconnectSegments, sinkUrl)

  try {
    await connectSingleReceiverRoom(owner, receiver)
    if (sinkMode === 'opfs') {
      const storage = await receiver.evaluate(async () => navigator.storage.estimate())
      expect((storage.quota ?? 0) - (storage.usage ?? 0)).toBeGreaterThan(sizeBytes + 64 * MIB)
    }

    const startedAt = Date.now()
    await owner.locator('#transfer-file-input').setInputFiles(sourcePath)
    const dialog = receiver.getByRole('dialog', { name: '接收文件' })
    await expect(dialog).toContainText(`${sizeGiB}.00 GiB`)
    await dialog.getByRole('button', { name: '选择位置并接收' }).click()
    const completed = owner.getByRole('heading', { name: '文件发送完成' })
    const failed = owner.getByRole('heading', { name: '传输失败' })
    await expect(completed.or(failed)).toBeVisible({
      timeout: sizeGiB === 5 ? 25 * 60 * 1000 : 10 * 60 * 1000,
    })
    if (await failed.isVisible()) {
      throw new Error((await failed.locator('xpath=..').textContent()) ?? 'large-file transfer failed')
    }
    await expect(receiver.getByRole('heading', { name: '文件接收完成' })).toBeVisible()

    const result = await receiver.evaluate(async ({ markerPositions, markerBytes, sinkUrl }) => {
      const state = (window as unknown as {
        __diskStressState: {
          aborted: boolean
          closeCount: number
          disconnects: number
          handle: FileSystemFileHandle | null
          maxWriteBytes: number
          nextOffset: number
          resumeCursors: number[]
          writes: number
        }
      }).__diskStressState
      const samples = []
      let fileSize = 0
      if (sinkUrl) {
        const sinkState = (await (await fetch(`${sinkUrl}/state`)).json()) as { size: number }
        fileSize = sinkState.size
        for (const position of markerPositions) {
          const response = await fetch(
            `${sinkUrl}/sample?position=${position}&length=${markerBytes}`,
          )
          if (!response.ok) throw new Error(await response.text())
          samples.push(Array.from(new Uint8Array(await response.arrayBuffer())))
        }
      } else {
        if (!state.handle) throw new Error('OPFS file handle is unavailable')
        const file = await state.handle.getFile()
        fileSize = file.size
        for (const position of markerPositions) {
          const bytes = new Uint8Array(
            await file.slice(position, position + markerBytes).arrayBuffer(),
          )
          samples.push(Array.from(bytes))
        }
      }
      return {
        aborted: state.aborted,
        closeCount: state.closeCount,
        disconnects: state.disconnects,
        fileSize,
        maxWriteBytes: state.maxWriteBytes,
        nextOffset: state.nextOffset,
        resumeCursors: state.resumeCursors,
        samples,
        writes: state.writes,
      }
    }, { markerBytes, markerPositions, sinkUrl })
    const elapsedSeconds = (Date.now() - startedAt) / 1000
    const mibPerSecond = sizeBytes / MIB / elapsedSeconds

    expect(result).toMatchObject({
      aborted: false,
      closeCount: 1,
      disconnects: disconnectCount,
      fileSize: sizeBytes,
      maxWriteBytes: SEGMENT_BYTES,
      nextOffset: sizeBytes,
    })
    expect(result.writes).toBe(segmentCount)
    expect(result.resumeCursors).toHaveLength(disconnectCount)
    for (const cursor of result.resumeCursors) expect(cursor).toBeGreaterThan(0)
    for (const [index, sample] of result.samples.entries()) {
      expect(Buffer.from(sample)).toEqual(markers[index])
    }

    const networkMetrics = await owner.evaluate(() =>
      (window as unknown as {
        __networkStressState?: { drainEvents: number; frames: number; maxQueuedBytes: number }
      }).__networkStressState,
    )
    if (delayMs > 0) {
      expect(networkMetrics?.drainEvents).toBeGreaterThan(0)
      expect(networkMetrics?.maxQueuedBytes).toBeLessThanOrEqual(4 * MIB + 64 * 1024)
    }
    const metrics = {
      delayMs,
      disconnects: disconnectCount,
      elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
      mibPerSecond: Number(mibPerSecond.toFixed(3)),
      network: networkMetrics ?? null,
      sink: sinkMode,
      sizeBytes,
      sizeGiB,
      writes: result.writes,
    }
    await writeFile(
      testInfo.outputPath('stress-result.json'),
      `${JSON.stringify(metrics, null, 2)}\n`,
      'utf8',
    )
    console.log(`STRESS_RESULT ${JSON.stringify(metrics)}`)
    testInfo.annotations.push({
      type: 'stress-result',
      description: `${sizeGiB} GiB in ${elapsedSeconds.toFixed(1)}s (${mibPerSecond.toFixed(1)} MiB/s), ${disconnectCount} reconnects`,
    })
  } finally {
    try {
      await receiverContext.close()
      await ownerContext.close()
    } finally {
      await rm(sourcePath, { force: true })
    }
  }
})
