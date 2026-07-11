import { describe, expect, test } from 'bun:test'
import {
  encodeTransferMessage,
  parseTransferMessage,
  textByteLength,
  type TransferProtocolMessage,
} from './transfer'

const request = {
  v: 1,
  type: 'transfer:request',
  transferId: 'tx_1',
  kind: 'text',
  characterCount: 4,
  byteLength: 6,
} as const

const expectProtocolError = (raw: string) => {
  const result = parseTransferMessage(raw)

  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected protocol error')
  expect(result.error.code).toBe('PROTOCOL_ERROR')
  expect(result.error.message.length).toBeGreaterThan(0)
}

describe('transfer protocol', () => {
  test('accepts and encodes every v1 frame', () => {
    const messages: TransferProtocolMessage[] = [
      request,
      {
        v: 1,
        type: 'transfer:decision',
        transferId: 'tx_1',
        decision: 'accept',
      },
      {
        v: 1,
        type: 'transfer:text',
        transferId: 'tx_1',
        text: '你好',
      },
      {
        v: 1,
        type: 'transfer:receipt',
        transferId: 'tx_1',
        status: 'received',
      },
      {
        v: 1,
        type: 'transfer:cancel',
        transferId: 'tx_1',
      },
      {
        v: 1,
        type: 'transfer:error',
        transferId: 'tx_1',
        code: 'CONTENT_MISMATCH',
      },
    ]

    for (const message of messages) {
      expect(parseTransferMessage(JSON.stringify(message))).toEqual({
        ok: true,
        message,
      })
      expect(JSON.parse(encodeTransferMessage(message))).toEqual(message)
    }
  })

  test('counts UTF-8 bytes rather than JavaScript code units', () => {
    expect(textByteLength('A你😀')).toBe(8)
  })

  test('rejects malformed JSON and non-object values', () => {
    expectProtocolError('{not-json')
    expectProtocolError('null')
    expectProtocolError('[]')
  })

  test('rejects unknown protocol versions and message types', () => {
    expectProtocolError(JSON.stringify({ ...request, v: 2 }))
    expectProtocolError(JSON.stringify({ ...request, type: 'transfer:file' }))
  })

  test('rejects empty and overlong transfer IDs', () => {
    expectProtocolError(JSON.stringify({ ...request, transferId: '' }))
    expectProtocolError(JSON.stringify({ ...request, transferId: 'x'.repeat(97) }))
  })

  test('rejects negative, fractional, and out-of-range request counts', () => {
    expectProtocolError(JSON.stringify({ ...request, characterCount: -1 }))
    expectProtocolError(JSON.stringify({ ...request, characterCount: 1.5 }))
    expectProtocolError(JSON.stringify({ ...request, characterCount: 501 }))
    expectProtocolError(JSON.stringify({ ...request, byteLength: -1 }))
    expectProtocolError(JSON.stringify({ ...request, byteLength: 4_097 }))
  })

  test('rejects text payloads over 500 JavaScript characters', () => {
    expectProtocolError(JSON.stringify({
      v: 1,
      type: 'transfer:text',
      transferId: 'tx_1',
      text: 'a'.repeat(501),
    }))
  })

  test('rejects frames over 4096 UTF-8 bytes before parsing', () => {
    expectProtocolError('你'.repeat(1_366))
  })

  test('rejects missing, extra, and invalid discriminated fields', () => {
    const { kind: _kind, ...withoutKind } = request

    expectProtocolError(JSON.stringify(withoutKind))
    expectProtocolError(JSON.stringify({ ...request, extra: true }))
    expectProtocolError(JSON.stringify({
      v: 1,
      type: 'transfer:decision',
      transferId: 'tx_1',
      decision: 'later',
    }))
    expectProtocolError(JSON.stringify({
      v: 1,
      type: 'transfer:error',
      transferId: 'tx_1',
      code: 'UNKNOWN',
    }))
  })
})
