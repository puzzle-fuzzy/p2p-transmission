import { describe, expect, test } from 'bun:test'
import {
  encodeFileChunkFrame,
  parseFileChunkFrame,
  type FileChunkFrame,
} from './file-chunk'

const maximumPayloadBytes = 16_384

const frame = (overrides: Partial<FileChunkFrame> = {}): FileChunkFrame => ({
  streamId: 1,
  chunkIndex: 0,
  payload: new Uint8Array([0xaa, 0xbb]),
  ...overrides,
})

const expectParseError = (raw: ArrayBuffer, maximum = maximumPayloadBytes) => {
  const result = parseFileChunkFrame(raw, maximum)

  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected file chunk parse error')
  expect(result.error.code).toBe('PROTOCOL_ERROR')
  expect(result.error.message.length).toBeGreaterThan(0)
}

describe('file chunk codec', () => {
  test('encodes the fixed big-endian 16-byte header', () => {
    const encoded = encodeFileChunkFrame({
      streamId: 0x01020304,
      chunkIndex: 0x05060708,
      payload: new Uint8Array([0xaa, 0xbb]),
    }, 2)

    expect(Array.from(new Uint8Array(encoded))).toEqual([
      0x50, 0x32, 0x50, 0x32,
      0x02, 0x01, 0x00, 0x10,
      0x01, 0x02, 0x03, 0x04,
      0x05, 0x06, 0x07, 0x08,
      0xaa, 0xbb,
    ])
  })

  test('round-trips uint32 boundaries and a Uint8Array subview', () => {
    const source = new Uint8Array([0, 1, 2, 3])
    const expected = frame({
      streamId: 0xffff_ffff,
      chunkIndex: 0xffff_ffff,
      payload: source.subarray(1, 3),
    })
    const encoded = encodeFileChunkFrame(expected, 2)
    const parsed = parseFileChunkFrame(encoded, 2)

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected parsed file chunk')
    expect(parsed.frame.streamId).toBe(expected.streamId)
    expect(parsed.frame.chunkIndex).toBe(expected.chunkIndex)
    expect(Array.from(parsed.frame.payload)).toEqual([1, 2])
  })

  test('encoder rejects invalid stream IDs and chunk indices', () => {
    for (const streamId of [0, -1, 1.5, 0x1_0000_0000]) {
      expect(() => encodeFileChunkFrame(frame({ streamId }), maximumPayloadBytes)).toThrow(RangeError)
    }
    for (const chunkIndex of [-1, 1.5, 0x1_0000_0000]) {
      expect(() => encodeFileChunkFrame(frame({ chunkIndex }), maximumPayloadBytes)).toThrow(RangeError)
    }
  })

  test('encoder rejects invalid payloads and configured maxima', () => {
    expect(() => encodeFileChunkFrame(frame({ payload: new Uint8Array() }), 1)).toThrow(RangeError)
    expect(() => encodeFileChunkFrame(frame({ payload: new Uint8Array(3) }), 2)).toThrow(RangeError)
    for (const maximum of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => encodeFileChunkFrame(frame(), maximum)).toThrow(RangeError)
    }
    expect(() => encodeFileChunkFrame({
      ...frame(),
      payload: {} as Uint8Array,
    }, maximumPayloadBytes)).toThrow(RangeError)
  })

  test('parser rejects truncated, header-only, and oversized frames', () => {
    expectParseError(new ArrayBuffer(15))
    expectParseError(new ArrayBuffer(16))
    expectParseError(encodeFileChunkFrame(frame({ payload: new Uint8Array(3) }), 3), 2)
  })

  test('parser rejects invalid magic, version, type, and header length', () => {
    const offsets: Array<[number, number]> = [
      [0, 0],
      [4, 1],
      [5, 2],
      [7, 15],
    ]

    for (const [offset, value] of offsets) {
      const encoded = encodeFileChunkFrame(frame(), maximumPayloadBytes)
      new Uint8Array(encoded)[offset] = value
      expectParseError(encoded)
    }
  })

  test('parser rejects a zero stream ID and invalid configured maxima', () => {
    const encoded = encodeFileChunkFrame(frame(), maximumPayloadBytes)
    new DataView(encoded).setUint32(8, 0)
    expectParseError(encoded)

    const valid = encodeFileChunkFrame(frame(), maximumPayloadBytes)
    for (const maximum of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expectParseError(valid, maximum)
    }
  })
})
