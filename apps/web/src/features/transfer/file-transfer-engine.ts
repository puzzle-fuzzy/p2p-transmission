import {
  DEFAULT_FILE_CHUNK_BYTES,
  FILE_CHUNK_HEADER_BYTES,
  encodeFileChunkFrame,
  type FileDescriptor,
} from '@p2p/contracts'

export const DATA_CHANNEL_HIGH_WATER_BYTES = 1024 * 1024
export const DATA_CHANNEL_LOW_WATER_BYTES = 64 * 1024
export const CONSERVATIVE_MAX_MESSAGE_BYTES = 64 * 1024
export const MIN_FILE_CHUNK_BYTES = 1024

export type BinaryChannel = {
  readyState: RTCDataChannelState
  bufferedAmount: number
  bufferedAmountLowThreshold: number
  onbufferedamountlow: (() => void) | null
  send(data: string | ArrayBuffer): void
}

export type FileChunkSizeResult =
  | { ok: true; chunkSize: number }
  | { ok: false; code: 'FILE_TRANSFER_UNSUPPORTED' }

export type FileTransferEngine = {
  sendFile(options: {
    channel: BinaryChannel
    descriptor: FileDescriptor
    file: Blob
    signal: AbortSignal
    onProgress(bytesQueued: number): void
  }): Promise<void>
  waitForDrain(channel: BinaryChannel, signal: AbortSignal): Promise<void>
  close(): void
}

export type StreamTombstones = {
  add(streamId: number): void
  has(streamId: number): boolean
  clear(): void
}

type TimerHandle = ReturnType<typeof setTimeout>

type TombstoneOptions = {
  capacity?: number
  ttlMs?: number
  setTimer?: (handler: () => void, delay: number) => TimerHandle
  clearTimer?: (timer: TimerHandle) => void
}

const transferError = (message: string) => new Error(message)

const assertOpen = (channel: BinaryChannel, signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason ?? transferError('文件传输已取消')
  if (channel.readyState !== 'open') throw transferError('数据通道已关闭')
}

const isUint32 = (value: number, nonZero = false) =>
  Number.isInteger(value)
  && value >= (nonZero ? 1 : 0)
  && value <= 0xffff_ffff

export const resolveFileChunkSize = (
  maxMessageSize?: number,
): FileChunkSizeResult => {
  const transportMaximum = maxMessageSize === undefined
    ? CONSERVATIVE_MAX_MESSAGE_BYTES
    : Math.floor(maxMessageSize)
  const available = transportMaximum - FILE_CHUNK_HEADER_BYTES

  if (!Number.isSafeInteger(transportMaximum) || available < MIN_FILE_CHUNK_BYTES) {
    return { ok: false, code: 'FILE_TRANSFER_UNSUPPORTED' }
  }

  return {
    ok: true,
    chunkSize: Math.min(DEFAULT_FILE_CHUNK_BYTES, available),
  }
}

export const createStreamTombstones = ({
  capacity = 32,
  ttlMs = 30_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: TombstoneOptions = {}): StreamTombstones => {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError('Tombstone capacity must be a positive safe integer')
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new RangeError('Tombstone TTL must be a positive safe integer')
  }

  const entries = new Map<number, TimerHandle>()

  const remove = (streamId: number) => {
    const timer = entries.get(streamId)
    if (timer === undefined) return
    clearTimer(timer)
    entries.delete(streamId)
  }

  return {
    add(streamId) {
      if (!isUint32(streamId, true)) throw new RangeError('Invalid stream ID')
      remove(streamId)

      while (entries.size >= capacity) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        remove(oldest)
      }

      const timer = setTimer(() => {
        if (entries.get(streamId) === timer) entries.delete(streamId)
      }, ttlMs)
      entries.set(streamId, timer)
    },
    has(streamId) {
      return entries.has(streamId)
    },
    clear() {
      for (const timer of entries.values()) clearTimer(timer)
      entries.clear()
    },
  }
}

export const createFileTransferEngine = (): FileTransferEngine => {
  const activeChannels = new WeakSet<object>()
  const rejectWaiters = new Set<(reason: unknown) => void>()
  let closed = false

  const assertActive = (channel: BinaryChannel, signal: AbortSignal) => {
    if (closed) throw transferError('文件传输引擎已关闭')
    assertOpen(channel, signal)
  }

  const waitForThreshold = (
    channel: BinaryChannel,
    signal: AbortSignal,
    threshold: number,
    isReady: () => boolean,
    restoreThreshold: number,
  ) => new Promise<void>((resolve, reject) => {
    assertActive(channel, signal)
    const previousHandler = channel.onbufferedamountlow
    let settled = false

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
      rejectWaiters.delete(onEngineClose)
      if (channel.onbufferedamountlow === onLow) {
        channel.onbufferedamountlow = previousHandler
      }
      channel.bufferedAmountLowThreshold = restoreThreshold
    }
    const settle = (reason?: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      if (reason === undefined) resolve()
      else reject(reason)
    }
    const onAbort = () => settle(signal.reason ?? transferError('文件传输已取消'))
    const onEngineClose = (reason: unknown) => settle(reason)
    const onLow = () => {
      try {
        previousHandler?.()
      } catch {
        // A pre-existing observer must not strand the transfer waiter.
      }
      if (!isReady()) return
      try {
        assertActive(channel, signal)
        settle()
      } catch (error) {
        settle(error)
      }
    }

    signal.addEventListener('abort', onAbort, { once: true })
    rejectWaiters.add(onEngineClose)
    channel.bufferedAmountLowThreshold = threshold
    channel.onbufferedamountlow = onLow

    if (isReady()) {
      try {
        assertActive(channel, signal)
        settle()
      } catch (error) {
        settle(error)
      }
    }
  })

  const waitForCapacity = async (
    channel: BinaryChannel,
    nextFrameBytes: number,
    signal: AbortSignal,
  ) => {
    if (channel.bufferedAmount + nextFrameBytes <= DATA_CHANNEL_HIGH_WATER_BYTES) {
      assertActive(channel, signal)
      return
    }

    await waitForThreshold(
      channel,
      signal,
      DATA_CHANNEL_LOW_WATER_BYTES,
      () => channel.bufferedAmount <= DATA_CHANNEL_LOW_WATER_BYTES,
      DATA_CHANNEL_LOW_WATER_BYTES,
    )
    assertActive(channel, signal)
  }

  const engine: FileTransferEngine = {
    async sendFile({ channel, descriptor, file, signal, onProgress }) {
      assertActive(channel, signal)
      if (activeChannels.has(channel)) throw transferError('同一通道已有文件正在发送')
      if (file.size !== descriptor.byteLength) throw transferError('文件大小与描述不一致')
      if (!isUint32(descriptor.streamId, true)) throw transferError('文件流标识无效')
      if (!Number.isSafeInteger(descriptor.chunkSize) || descriptor.chunkSize < MIN_FILE_CHUNK_BYTES) {
        throw transferError('文件分片大小无效')
      }

      activeChannels.add(channel)
      try {
        let offset = 0
        let chunkIndex = 0
        onProgress(0)

        while (offset < descriptor.byteLength) {
          const payloadBytes = Math.min(
            descriptor.chunkSize,
            descriptor.byteLength - offset,
          )
          await waitForCapacity(
            channel,
            FILE_CHUNK_HEADER_BYTES + payloadBytes,
            signal,
          )
          assertActive(channel, signal)

          const chunk = file.slice(offset, offset + payloadBytes)
          const payload = new Uint8Array(await chunk.arrayBuffer())
          assertActive(channel, signal)
          if (payload.byteLength !== payloadBytes) {
            throw transferError('读取的文件分片长度不一致')
          }

          channel.send(encodeFileChunkFrame({
            streamId: descriptor.streamId,
            chunkIndex,
            payload,
          }, descriptor.chunkSize))
          offset += payload.byteLength
          chunkIndex += 1
          onProgress(offset)
        }
      } finally {
        activeChannels.delete(channel)
      }
    },
    async waitForDrain(channel, signal) {
      assertActive(channel, signal)
      await waitForThreshold(
        channel,
        signal,
        0,
        () => channel.bufferedAmount === 0,
        DATA_CHANNEL_LOW_WATER_BYTES,
      )
      assertActive(channel, signal)
    },
    close() {
      if (closed) return
      closed = true
      const error = transferError('文件传输引擎已关闭')
      for (const reject of Array.from(rejectWaiters)) reject(error)
      rejectWaiters.clear()
    },
  }

  return engine
}
