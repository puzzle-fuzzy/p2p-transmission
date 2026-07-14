import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_FILE_CHUNK_BYTES,
  encodeTransferMessage,
  MAX_CONTROL_FRAME_BYTES,
  MAX_FILE_BATCH_BYTES,
  MAX_FILE_COUNT,
  parseTransferMessage,
  sanitizeFileName,
  textByteLength,
  type FileDescriptor,
  type TransferProtocolMessage,
} from './transfer'

const descriptor = (overrides: Partial<FileDescriptor> = {}): FileDescriptor => ({
  fileId: 'file_1',
  streamId: 1,
  name: '设计稿.png',
  mimeType: 'image/png',
  byteLength: 3,
  lastModified: 1,
  chunkSize: DEFAULT_FILE_CHUNK_BYTES,
  chunkCount: 1,
  ...overrides,
})

const fileRequest = (
  files: FileDescriptor[] = [descriptor()],
): TransferProtocolMessage => ({
  v: 2,
  type: 'transfer:file-request',
  transferId: 'tx_files',
  files,
})

const expectProtocolMessage = (message: TransferProtocolMessage) => {
  const raw = JSON.stringify(message)

  expect(parseTransferMessage(raw)).toEqual({ ok: true, message })
  expect(JSON.parse(encodeTransferMessage(message))).toEqual(message)
}

const expectProtocolError = (value: unknown) => {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  const result = parseTransferMessage(raw)

  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected protocol error')
  expect(result.error.code).toBe('PROTOCOL_ERROR')
  expect(result.error.message.length).toBeGreaterThan(0)
}

describe('transfer protocol v2', () => {
  test('accepts and encodes every control-frame shape', () => {
    const messages: TransferProtocolMessage[] = [
      {
        v: 2,
        type: 'transfer:decision',
        transferId: 'tx_files',
        decision: 'accept',
      },
      fileRequest(),
      {
        v: 2,
        type: 'transfer:file-start',
        transferId: 'tx_files',
        fileId: 'file_1',
        streamId: 1,
      },
      {
        v: 2,
        type: 'transfer:file-end',
        transferId: 'tx_files',
        fileId: 'file_1',
        streamId: 1,
        chunkCount: 1,
        byteLength: 3,
      },
      {
        v: 2,
        type: 'transfer:receipt',
        transferId: 'tx_files',
        kind: 'file',
        fileId: 'file_1',
        status: 'received',
      },
      {
        v: 2,
        type: 'transfer:cancel',
        transferId: 'tx_files',
      },
      {
        v: 2,
        type: 'transfer:error',
        transferId: 'tx_files',
        code: 'BUFFER_ERROR',
      },
    ]

    for (const message of messages) expectProtocolMessage(message)
  })

  test('accepts up to MAX_FILE_COUNT files totaling exactly MAX_FILE_BATCH_BYTES', () => {
    const size = MAX_FILE_BATCH_BYTES / MAX_FILE_COUNT
    const files = Array.from({ length: MAX_FILE_COUNT }, (_, index) => descriptor({
      fileId: `file_${index + 1}`,
      streamId: index + 1,
      name: `${index + 1}.bin`,
      mimeType: '',
      byteLength: size,
      chunkCount: Math.ceil(size / DEFAULT_FILE_CHUNK_BYTES),
    }))

    expectProtocolMessage(fileRequest(files))
  })

  test('accepts empty files with zero chunks', () => {
    expectProtocolMessage(fileRequest([descriptor({
      byteLength: 0,
      chunkCount: 0,
    })]))
  })

  test('rejects v1, malformed JSON, and non-object values', () => {
    expectProtocolError({
      v: 1,
      type: 'transfer:file-request',
      transferId: 'tx_1',
      files: [descriptor()],
    })
    expectProtocolError('{not-json')
    expectProtocolError('null')
    expectProtocolError('[]')
  })

  test('rejects invalid transfer IDs, types, and exact-key violations', () => {
    expectProtocolError({
      v: 2,
      type: 'transfer:file-request',
      transferId: '',
      files: [descriptor()],
    })
    expectProtocolError({ v: 2, type: 'unknown', transferId: 'tx_1' })
    expectProtocolError({
      v: 2,
      type: 'transfer:file-request',
      transferId: 'tx_files',
      files: [{ ...descriptor(), extra: true }],
    })
  })

  test('rejects removed legacy text transfer and receipt frames', () => {
    expectProtocolError({ v: 2, type: 'transfer:text', transferId: 'tx_1', text: 'legacy' })
    expectProtocolError({
      v: 2,
      type: 'transfer:receipt',
      transferId: 'tx_1',
      kind: 'text',
      status: 'received',
    })
  })

  test('rejects file-count and aggregate-byte overflow', () => {
    const overflow = Array.from({ length: MAX_FILE_COUNT + 1 }, (_, index) => descriptor({
      fileId: `file_${index + 1}`,
      streamId: index + 1,
      byteLength: 0,
      chunkCount: 0,
    }))

    expectProtocolError(fileRequest([]))
    expectProtocolError(fileRequest(overflow))
    expectProtocolError(fileRequest([descriptor({
      byteLength: MAX_FILE_BATCH_BYTES + 1,
      chunkCount: Math.ceil((MAX_FILE_BATCH_BYTES + 1) / DEFAULT_FILE_CHUNK_BYTES),
    })]))
  })

  test('rejects duplicate file and stream IDs', () => {
    expectProtocolError(fileRequest([
      descriptor(),
      descriptor({ streamId: 2 }),
    ]))
    expectProtocolError(fileRequest([
      descriptor(),
      descriptor({ fileId: 'file_2' }),
    ]))
    expectProtocolError(fileRequest([descriptor({ streamId: 0 })]))
  })

  test('rejects inconsistent chunk metadata', () => {
    expectProtocolError(fileRequest([descriptor({ chunkCount: 0 })]))
    expectProtocolError(fileRequest([descriptor({ byteLength: 0, chunkCount: 1 })]))
    expectProtocolError(fileRequest([descriptor({ chunkSize: 1_023, chunkCount: 1 })]))
    expectProtocolError(fileRequest([descriptor({
      chunkSize: DEFAULT_FILE_CHUNK_BYTES + 1,
      chunkCount: 1,
    })]))
    expectProtocolError(fileRequest([descriptor({ chunkSize: 1_024.5, chunkCount: 1 })]))
  })

  test('rejects fractional and non-finite descriptor numbers', () => {
    expectProtocolError(fileRequest([descriptor({ byteLength: 1.5 })]))
    expectProtocolError(fileRequest([descriptor({ lastModified: Number.NaN })]))
    expectProtocolError(fileRequest([descriptor({ lastModified: Number.POSITIVE_INFINITY })]))
    expectProtocolError(fileRequest([descriptor({ streamId: 1.5 })]))
    expectProtocolError(fileRequest([descriptor({ streamId: 0x1_0000_0000 })]))
    expectProtocolError(fileRequest([descriptor({ chunkCount: 1.5 })]))
  })

  test('enforces character and UTF-8 byte limits for names and MIME types', () => {
    expectProtocolError(fileRequest([descriptor({ name: 'a'.repeat(256) })]))
    expectProtocolError(fileRequest([descriptor({ name: '你'.repeat(86) })]))
    expectProtocolError(fileRequest([descriptor({ mimeType: 'a'.repeat(129) })]))
    expectProtocolError(fileRequest([descriptor({ mimeType: '你'.repeat(43) })]))
  })

  test('rejects invalid receipts, decisions, end frames, and error codes', () => {
    expectProtocolError({
      v: 2,
      type: 'transfer:decision',
      transferId: 'tx_1',
      decision: 'later',
    })
    expectProtocolError({
      v: 2,
      type: 'transfer:receipt',
      transferId: 'tx_1',
      kind: 'file',
      status: 'received',
    })
    expectProtocolError({
      v: 2,
      type: 'transfer:file-end',
      transferId: 'tx_1',
      fileId: 'file_1',
      streamId: 1,
      chunkCount: -1,
      byteLength: 0,
    })
    expectProtocolError({
      v: 2,
      type: 'transfer:error',
      transferId: 'tx_1',
      code: 'UNKNOWN',
    })
  })

  test('rejects control frames over 16 KiB before JSON parsing', () => {
    expectProtocolError(' '.repeat(MAX_CONTROL_FRAME_BYTES + 1))
  })

  test('counts UTF-8 bytes rather than JavaScript code units', () => {
    expect(textByteLength('A你😀')).toBe(8)
  })
})

describe('sanitizeFileName', () => {
  test('removes path separators and control characters, then trims', () => {
    expect(sanitizeFileName('../secret')).toBe('..secret')
    expect(sanitizeFileName(String.raw`folder\file.txt`)).toBe('folderfile.txt')
    expect(sanitizeFileName('\u0000a\u001fb\u007fc\u009fd')).toBe('abcd')
    expect(sanitizeFileName('  report.txt  ')).toBe('report.txt')
  })

  test('uses a safe fallback when no usable name remains', () => {
    for (const name of ['', '   ', '/', '\\', '.', '..', '\u0000\u0080']) {
      expect(sanitizeFileName(name)).toBe('未命名文件')
    }
  })
})
