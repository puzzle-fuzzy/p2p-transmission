import {
  FILE_CHUNK_HEADER_BYTES,
  TRANSFER_PROTOCOL_VERSION,
} from './transfer'

const FILE_CHUNK_MAGIC = 0x50325032
const FILE_CHUNK_FRAME_TYPE = 1
const UINT32_MAX = 0xffff_ffff

export type FileChunkFrame = {
  streamId: number
  chunkIndex: number
  payload: Uint8Array
}

export type FileChunkParseResult =
  | { ok: true; frame: FileChunkFrame }
  | { ok: false; error: { code: 'PROTOCOL_ERROR'; message: string } }

const chunkError = (message: string): FileChunkParseResult => ({
  ok: false,
  error: {
    code: 'PROTOCOL_ERROR',
    message,
  },
})

const isUint32 = (value: unknown, nonZero = false): value is number =>
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value >= (nonZero ? 1 : 0)
  && value <= UINT32_MAX

const isMaximumPayloadBytes = (value: unknown): value is number =>
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value > 0

const assertMaximumPayloadBytes: (
  value: unknown,
) => asserts value is number = value => {
  if (!isMaximumPayloadBytes(value)) {
    throw new RangeError('Maximum payload bytes must be a positive safe integer')
  }
}

const assertUint32 = (value: unknown, nonZero = false) => {
  if (!isUint32(value, nonZero)) {
    throw new RangeError(nonZero
      ? 'Value must be a non-zero uint32'
      : 'Value must be a uint32')
  }
}

const assertPayload: (
  value: unknown,
  maximumPayloadBytes: number,
) => asserts value is Uint8Array = (value, maximumPayloadBytes) => {
  if (
    !(value instanceof Uint8Array)
    || value.byteLength === 0
    || value.byteLength > maximumPayloadBytes
  ) {
    throw new RangeError('Payload must be a non-empty Uint8Array within the negotiated maximum')
  }
}

export const encodeFileChunkFrame = (
  frame: FileChunkFrame,
  maximumPayloadBytes: number,
): ArrayBuffer => {
  assertMaximumPayloadBytes(maximumPayloadBytes)
  assertUint32(frame.streamId, true)
  assertUint32(frame.chunkIndex)
  assertPayload(frame.payload, maximumPayloadBytes)

  const bytes = new Uint8Array(FILE_CHUNK_HEADER_BYTES + frame.payload.byteLength)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, FILE_CHUNK_MAGIC)
  view.setUint8(4, TRANSFER_PROTOCOL_VERSION)
  view.setUint8(5, FILE_CHUNK_FRAME_TYPE)
  view.setUint16(6, FILE_CHUNK_HEADER_BYTES)
  view.setUint32(8, frame.streamId)
  view.setUint32(12, frame.chunkIndex)
  bytes.set(frame.payload, FILE_CHUNK_HEADER_BYTES)

  return bytes.buffer
}

export const parseFileChunkFrame = (
  raw: ArrayBuffer,
  maximumPayloadBytes: number,
): FileChunkParseResult => {
  if (!isMaximumPayloadBytes(maximumPayloadBytes)) {
    return chunkError('Maximum payload bytes must be a positive safe integer')
  }
  if (!(raw instanceof ArrayBuffer)) return chunkError('Binary frame must be an ArrayBuffer')
  if (raw.byteLength <= FILE_CHUNK_HEADER_BYTES) {
    return chunkError('Binary frame has no payload or a truncated header')
  }

  const payloadBytes = raw.byteLength - FILE_CHUNK_HEADER_BYTES
  if (payloadBytes > maximumPayloadBytes) {
    return chunkError('Binary payload exceeds the negotiated maximum')
  }

  const view = new DataView(raw)
  if (view.getUint32(0) !== FILE_CHUNK_MAGIC) return chunkError('Invalid binary frame magic')
  if (view.getUint8(4) !== TRANSFER_PROTOCOL_VERSION) {
    return chunkError('Unsupported binary frame version')
  }
  if (view.getUint8(5) !== FILE_CHUNK_FRAME_TYPE) {
    return chunkError('Unsupported binary frame type')
  }
  if (view.getUint16(6) !== FILE_CHUNK_HEADER_BYTES) {
    return chunkError('Invalid binary frame header length')
  }

  const streamId = view.getUint32(8)
  if (streamId === 0) return chunkError('Invalid binary frame stream ID')

  return {
    ok: true,
    frame: {
      streamId,
      chunkIndex: view.getUint32(12),
      payload: new Uint8Array(raw, FILE_CHUNK_HEADER_BYTES),
    },
  }
}
