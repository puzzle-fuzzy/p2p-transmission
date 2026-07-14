export const TRANSFER_PROTOCOL_VERSION = 2
export const MAX_CONTROL_FRAME_BYTES = 16 * 1024
export const MAX_TRANSFER_ID_LENGTH = 96
export const MAX_FILE_COUNT = 10
export const MAX_FILE_BATCH_BYTES = 100 * 1024 * 1024
export const MAX_FILE_NAME_CHARACTERS = 255
export const MAX_FILE_NAME_BYTES = 255
export const MAX_MIME_TYPE_CHARACTERS = 128
export const MAX_MIME_TYPE_BYTES = 128
export const DEFAULT_FILE_CHUNK_BYTES = 16 * 1024
export const FILE_CHUNK_HEADER_BYTES = 16

const MIN_FILE_CHUNK_BYTES = 1024
const MAX_FILE_CHUNK_COUNT = Math.ceil(MAX_FILE_BATCH_BYTES / MIN_FILE_CHUNK_BYTES)
const UINT32_MAX = 0xffff_ffff
const SAFE_FILE_NAME_FALLBACK = '未命名文件'

export type FileDescriptor = {
  fileId: string
  streamId: number
  name: string
  mimeType: string
  byteLength: number
  lastModified: number
  chunkSize: number
  chunkCount: number
}

export type TransferProtocolMessage =
  | {
      v: 2
      type: 'transfer:file-request'
      transferId: string
      files: FileDescriptor[]
    }
  | {
      v: 2
      type: 'transfer:decision'
      transferId: string
      decision: 'accept' | 'reject'
    }
  | {
      v: 2
      type: 'transfer:file-start'
      transferId: string
      fileId: string
      streamId: number
    }
  | {
      v: 2
      type: 'transfer:file-end'
      transferId: string
      fileId: string
      streamId: number
      chunkCount: number
      byteLength: number
    }
  | {
      v: 2
      type: 'transfer:receipt'
      transferId: string
      kind: 'file'
      fileId: string
      status: 'received'
    }
  | { v: 2; type: 'transfer:cancel'; transferId: string }
  | {
      v: 2
      type: 'transfer:error'
      transferId: string
      code: 'INVALID_STATE' | 'CONTENT_MISMATCH' | 'CONTENT_TOO_LARGE' | 'BUFFER_ERROR'
    }

export type TransferParseResult =
  | { ok: true; message: TransferProtocolMessage }
  | { ok: false; error: { code: 'PROTOCOL_ERROR'; message: string } }

type Utf8Encoder = {
  encode(input?: string): Uint8Array
}

const TextEncoderConstructor = (
  globalThis as typeof globalThis & { TextEncoder: new () => Utf8Encoder }
).TextEncoder
const textEncoder = new TextEncoderConstructor()

export const textByteLength = (text: string) => textEncoder.encode(text).byteLength

export const sanitizeFileName = (name: string) => {
  const cleaned = Array.from(name)
    .filter(character => {
      const codePoint = character.codePointAt(0) ?? 0

      return character !== '/'
        && character !== '\\'
        && codePoint > 0x1f
        && (codePoint < 0x7f || codePoint > 0x9f)
    })
    .join('')
    .trim()

  return cleaned && cleaned !== '.' && cleaned !== '..'
    ? cleaned
    : SAFE_FILE_NAME_FALLBACK
}

const protocolError = (message: string): TransferParseResult => ({
  ok: false,
  error: {
    code: 'PROTOCOL_ERROR',
    message,
  },
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactKeys = (
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
) => {
  const actualKeys = Object.keys(value)

  return actualKeys.length === expectedKeys.length
    && expectedKeys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= MAX_TRANSFER_ID_LENGTH

const isSafeIntegerBetween = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is number =>
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value >= minimum
  && value <= maximum

const isUint32 = (value: unknown, nonZero = false): value is number =>
  isSafeIntegerBetween(value, nonZero ? 1 : 0, UINT32_MAX)

const isBoundedString = (
  value: unknown,
  maximumCharacters: number,
  maximumBytes: number,
  allowEmpty: boolean,
): value is string =>
  typeof value === 'string'
  && (allowEmpty || value.length > 0)
  && value.length <= maximumCharacters
  && textByteLength(value) <= maximumBytes

const parseFileDescriptors = (value: unknown): FileDescriptor[] | undefined => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILE_COUNT) {
    return undefined
  }

  const fileIds = new Set<string>()
  const streamIds = new Set<number>()
  const files: FileDescriptor[] = []
  let totalBytes = 0

  for (const candidate of value) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, [
      'fileId',
      'streamId',
      'name',
      'mimeType',
      'byteLength',
      'lastModified',
      'chunkSize',
      'chunkCount',
    ])) {
      return undefined
    }
    if (!isIdentifier(candidate.fileId) || fileIds.has(candidate.fileId)) return undefined
    if (!isUint32(candidate.streamId, true) || streamIds.has(candidate.streamId)) return undefined
    if (!isBoundedString(
      candidate.name,
      MAX_FILE_NAME_CHARACTERS,
      MAX_FILE_NAME_BYTES,
      false,
    )) return undefined
    if (!isBoundedString(
      candidate.mimeType,
      MAX_MIME_TYPE_CHARACTERS,
      MAX_MIME_TYPE_BYTES,
      true,
    )) return undefined
    if (!isSafeIntegerBetween(candidate.byteLength, 0, MAX_FILE_BATCH_BYTES)) return undefined
    if (!isSafeIntegerBetween(candidate.lastModified, 0, Number.MAX_SAFE_INTEGER)) return undefined
    if (!isSafeIntegerBetween(
      candidate.chunkSize,
      MIN_FILE_CHUNK_BYTES,
      DEFAULT_FILE_CHUNK_BYTES,
    )) return undefined
    if (!isSafeIntegerBetween(candidate.chunkCount, 0, MAX_FILE_CHUNK_COUNT)) return undefined

    const expectedChunkCount = Math.ceil(candidate.byteLength / candidate.chunkSize)
    if (candidate.chunkCount !== expectedChunkCount) return undefined

    totalBytes += candidate.byteLength
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_FILE_BATCH_BYTES) return undefined

    fileIds.add(candidate.fileId)
    streamIds.add(candidate.streamId)
    files.push({
      fileId: candidate.fileId,
      streamId: candidate.streamId,
      name: candidate.name,
      mimeType: candidate.mimeType,
      byteLength: candidate.byteLength,
      lastModified: candidate.lastModified,
      chunkSize: candidate.chunkSize,
      chunkCount: candidate.chunkCount,
    })
  }

  return files
}

const isTransferErrorCode = (
  value: unknown,
): value is Extract<TransferProtocolMessage, { type: 'transfer:error' }>['code'] =>
  value === 'INVALID_STATE'
  || value === 'CONTENT_MISMATCH'
  || value === 'CONTENT_TOO_LARGE'
  || value === 'BUFFER_ERROR'

export const parseTransferMessage = (raw: string): TransferParseResult => {
  if (typeof raw !== 'string') return protocolError('Control frame must be a string')
  if (
    raw.length > MAX_CONTROL_FRAME_BYTES
    || textByteLength(raw) > MAX_CONTROL_FRAME_BYTES
  ) {
    return protocolError(`Frame exceeds ${MAX_CONTROL_FRAME_BYTES} UTF-8 bytes`)
  }

  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return protocolError('Frame is not valid JSON')
  }

  if (!isRecord(value)) return protocolError('Frame must be a JSON object')
  if (value.v !== TRANSFER_PROTOCOL_VERSION) return protocolError('Unsupported protocol version')
  if (!isIdentifier(value.transferId)) return protocolError('Invalid transfer ID')

  if (value.type === 'transfer:file-request') {
    if (!hasExactKeys(value, ['v', 'type', 'transferId', 'files'])) {
      return protocolError('Invalid file request fields')
    }
    const files = parseFileDescriptors(value.files)
    if (!files) return protocolError('Invalid file descriptors')

    return {
      ok: true,
      message: {
        v: 2,
        type: 'transfer:file-request',
        transferId: value.transferId,
        files,
      },
    }
  }

  if (value.type === 'transfer:decision') {
    if (!hasExactKeys(value, ['v', 'type', 'transferId', 'decision'])) {
      return protocolError('Invalid transfer decision fields')
    }
    if (value.decision !== 'accept' && value.decision !== 'reject') {
      return protocolError('Invalid transfer decision')
    }

    return {
      ok: true,
      message: {
        v: 2,
        type: 'transfer:decision',
        transferId: value.transferId,
        decision: value.decision,
      },
    }
  }

  if (value.type === 'transfer:file-start') {
    if (!hasExactKeys(value, ['v', 'type', 'transferId', 'fileId', 'streamId'])) {
      return protocolError('Invalid file start fields')
    }
    if (!isIdentifier(value.fileId) || !isUint32(value.streamId, true)) {
      return protocolError('Invalid file start identity')
    }

    return {
      ok: true,
      message: {
        v: 2,
        type: 'transfer:file-start',
        transferId: value.transferId,
        fileId: value.fileId,
        streamId: value.streamId,
      },
    }
  }

  if (value.type === 'transfer:file-end') {
    if (!hasExactKeys(value, [
      'v',
      'type',
      'transferId',
      'fileId',
      'streamId',
      'chunkCount',
      'byteLength',
    ])) {
      return protocolError('Invalid file end fields')
    }
    if (
      !isIdentifier(value.fileId)
      || !isUint32(value.streamId, true)
      || !isSafeIntegerBetween(value.chunkCount, 0, MAX_FILE_CHUNK_COUNT)
      || !isSafeIntegerBetween(value.byteLength, 0, MAX_FILE_BATCH_BYTES)
    ) {
      return protocolError('Invalid file end metadata')
    }

    return {
      ok: true,
      message: {
        v: 2,
        type: 'transfer:file-end',
        transferId: value.transferId,
        fileId: value.fileId,
        streamId: value.streamId,
        chunkCount: value.chunkCount,
        byteLength: value.byteLength,
      },
    }
  }

  if (value.type === 'transfer:receipt') {
    if (value.kind === 'file') {
      if (!hasExactKeys(value, ['v', 'type', 'transferId', 'kind', 'fileId', 'status'])) {
        return protocolError('Invalid file receipt fields')
      }
      if (!isIdentifier(value.fileId) || value.status !== 'received') {
        return protocolError('Invalid file receipt')
      }

      return {
        ok: true,
        message: {
          v: 2,
          type: 'transfer:receipt',
          transferId: value.transferId,
          kind: 'file',
          fileId: value.fileId,
          status: 'received',
        },
      }
    }

    return protocolError('Invalid receipt kind')
  }

  if (value.type === 'transfer:cancel') {
    if (!hasExactKeys(value, ['v', 'type', 'transferId'])) {
      return protocolError('Invalid transfer cancellation fields')
    }

    return {
      ok: true,
      message: {
        v: 2,
        type: 'transfer:cancel',
        transferId: value.transferId,
      },
    }
  }

  if (value.type === 'transfer:error') {
    if (!hasExactKeys(value, ['v', 'type', 'transferId', 'code'])) {
      return protocolError('Invalid transfer error fields')
    }
    if (!isTransferErrorCode(value.code)) return protocolError('Invalid transfer error code')

    return {
      ok: true,
      message: {
        v: 2,
        type: 'transfer:error',
        transferId: value.transferId,
        code: value.code,
      },
    }
  }

  return protocolError('Unsupported message type')
}

export const encodeTransferMessage = (message: TransferProtocolMessage) => {
  const raw = JSON.stringify(message)
  const parsed = parseTransferMessage(raw)

  if (!parsed.ok) throw new RangeError(parsed.error.message)

  return raw
}
