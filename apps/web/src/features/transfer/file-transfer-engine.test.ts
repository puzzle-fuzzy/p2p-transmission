import { describe, expect, test, vi } from 'vitest'
import { parseFileChunkFrame, type FileDescriptor } from '@p2p/contracts'
import {
  CONSERVATIVE_MAX_MESSAGE_BYTES,
  DATA_CHANNEL_HIGH_WATER_BYTES,
  DATA_CHANNEL_LOW_WATER_BYTES,
  createFileTransferEngine,
  createStreamTombstones,
  resolveFileChunkSize,
  type BinaryChannel,
} from './file-transfer-engine'

class FakeChannel implements BinaryChannel {
  readyState: RTCDataChannelState = 'open'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onbufferedamountlow: (() => void) | null = null
  sent: (string | ArrayBuffer)[] = []

  send(data: string | ArrayBuffer) {
    this.sent.push(data)
    this.bufferedAmount += typeof data === 'string'
      ? new TextEncoder().encode(data).byteLength
      : data.byteLength
  }

  drainTo(amount: number) {
    const previous = this.bufferedAmount
    this.bufferedAmount = amount
    if (previous > this.bufferedAmountLowThreshold && amount <= this.bufferedAmountLowThreshold) {
      this.onbufferedamountlow?.()
    }
  }
}

const descriptor = (overrides: Partial<FileDescriptor> = {}): FileDescriptor => ({
  fileId: 'file_1',
  streamId: 7,
  name: 'sample.bin',
  mimeType: 'application/octet-stream',
  byteLength: 1,
  lastModified: 1,
  chunkSize: 1024,
  chunkCount: 1,
  ...overrides,
})

const fakeBlob = (bytes: number[], ranges: [number, number][] = []): Blob => ({
  size: bytes.length,
  type: 'application/octet-stream',
  slice(start = 0, end = bytes.length) {
    ranges.push([start, end])
    const part = Uint8Array.from(bytes.slice(start, end))
    return {
      arrayBuffer: async () => part.buffer,
    } as Blob
  },
  arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  bytes: async () => Uint8Array.from(bytes),
  stream: () => new ReadableStream(),
  text: async () => '',
} as Blob)

describe('file transfer engine', () => {
  test('resolves negotiated and conservative chunk sizes', () => {
    expect(resolveFileChunkSize()).toEqual({ ok: true, chunkSize: 16 * 1024 })
    expect(resolveFileChunkSize(CONSERVATIVE_MAX_MESSAGE_BYTES)).toEqual({
      ok: true,
      chunkSize: 16 * 1024,
    })
    expect(resolveFileChunkSize(4_112)).toEqual({ ok: true, chunkSize: 4_096 })
    expect(resolveFileChunkSize(1_039)).toEqual({
      ok: false,
      code: 'FILE_TRANSFER_UNSUPPORTED',
    })
  })

  test('sends exact indexed frames and monotonic progress', async () => {
    const channel = new FakeChannel()
    const progress: number[] = []
    const engine = createFileTransferEngine()
    const bytes = Array.from({ length: 1025 }, (_, index) => index % 251)

    await engine.sendFile({
      channel,
      descriptor: descriptor({ byteLength: 1025, chunkSize: 1024, chunkCount: 2 }),
      file: fakeBlob(bytes),
      signal: new AbortController().signal,
      onProgress: value => progress.push(value),
    })

    expect(progress).toEqual([0, 1024, 1025])
    expect(channel.sent).toHaveLength(2)
    const frames = channel.sent.map(frame => {
      if (!(frame instanceof ArrayBuffer)) throw new Error('expected binary')
      const parsed = parseFileChunkFrame(frame, 1024)
      if (!parsed.ok) throw new Error(parsed.error.message)
      return parsed.frame
    })
    expect(frames.map(frame => ({
      streamId: frame.streamId,
      chunkIndex: frame.chunkIndex,
      payloadBytes: frame.payload.byteLength,
    }))).toEqual([
      { streamId: 7, chunkIndex: 0, payloadBytes: 1024 },
      { streamId: 7, chunkIndex: 1, payloadBytes: 1 },
    ])
    expect(Array.from(frames[1]?.payload ?? [])).toEqual([bytes[1024]])
  })

  test('waits for low water before reading the next slice', async () => {
    const channel = new FakeChannel()
    channel.bufferedAmount = DATA_CHANNEL_HIGH_WATER_BYTES
    const ranges: [number, number][] = []
    const promise = createFileTransferEngine().sendFile({
      channel,
      descriptor: descriptor({ byteLength: 1, chunkSize: 1024, chunkCount: 1 }),
      file: fakeBlob([9], ranges),
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    })

    await Promise.resolve()
    expect(ranges).toEqual([])
    expect(channel.bufferedAmountLowThreshold).toBe(DATA_CHANNEL_LOW_WATER_BYTES)
    channel.drainTo(DATA_CHANNEL_LOW_WATER_BYTES)
    await promise
    expect(ranges).toEqual([[0, 1]])
  })

  test('uses a distinct zero threshold drain and restores low water', async () => {
    const channel = new FakeChannel()
    channel.bufferedAmount = DATA_CHANNEL_LOW_WATER_BYTES
    channel.bufferedAmountLowThreshold = DATA_CHANNEL_LOW_WATER_BYTES
    const promise = createFileTransferEngine().waitForDrain(
      channel,
      new AbortController().signal,
    )

    expect(channel.bufferedAmountLowThreshold).toBe(0)
    channel.drainTo(1)
    await Promise.resolve()
    expect(channel.bufferedAmountLowThreshold).toBe(0)
    channel.drainTo(0)
    await promise
    expect(channel.bufferedAmountLowThreshold).toBe(DATA_CHANNEL_LOW_WATER_BYTES)
  })

  test('aborts stalled waiters and rejects reuse after close', async () => {
    const channel = new FakeChannel()
    channel.bufferedAmount = DATA_CHANNEL_HIGH_WATER_BYTES
    const controller = new AbortController()
    const engine = createFileTransferEngine()
    const promise = engine.sendFile({
      channel,
      descriptor: descriptor({ byteLength: 1, chunkSize: 1024, chunkCount: 1 }),
      file: fakeBlob([1]),
      signal: controller.signal,
      onProgress: vi.fn(),
    })

    controller.abort(new Error('cancelled'))
    await expect(promise).rejects.toThrow('cancelled')
    engine.close()
    await expect(engine.waitForDrain(channel, new AbortController().signal))
      .rejects.toThrow('已关闭')
  })
})

describe('stream tombstones', () => {
  test('expires entries, evicts the oldest, and clears timers', () => {
    vi.useFakeTimers()
    const tombstones = createStreamTombstones({ capacity: 2, ttlMs: 30_000 })
    tombstones.add(1)
    tombstones.add(2)
    tombstones.add(3)
    expect(tombstones.has(1)).toBe(false)
    expect(tombstones.has(2)).toBe(true)
    expect(tombstones.has(3)).toBe(true)

    vi.advanceTimersByTime(30_000)
    expect(tombstones.has(2)).toBe(false)
    expect(tombstones.has(3)).toBe(false)
    tombstones.clear()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})
