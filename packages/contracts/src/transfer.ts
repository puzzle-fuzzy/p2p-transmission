export const MAX_TEXT_CHARACTERS = 500
export const MAX_TRANSFER_FRAME_BYTES = 4_096
export const MAX_TRANSFER_ID_LENGTH = 96

export type TransferProtocolMessage =
  | {
      v: 1
      type: 'transfer:request'
      transferId: string
      kind: 'text'
      characterCount: number
      byteLength: number
    }
  | {
      v: 1
      type: 'transfer:decision'
      transferId: string
      decision: 'accept' | 'reject'
    }
  | { v: 1; type: 'transfer:text'; transferId: string; text: string }
  | { v: 1; type: 'transfer:receipt'; transferId: string; status: 'received' }
  | { v: 1; type: 'transfer:cancel'; transferId: string }
  | {
      v: 1
      type: 'transfer:error'
      transferId: string
      code: 'INVALID_STATE' | 'CONTENT_MISMATCH' | 'CONTENT_TOO_LARGE'
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

const isTransferId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= MAX_TRANSFER_ID_LENGTH

const isBoundedInteger = (value: unknown, maximum: number): value is number =>
  typeof value === 'number'
  && Number.isInteger(value)
  && value >= 0
  && value <= maximum

const isTransferErrorCode = (
  value: unknown,
): value is Extract<TransferProtocolMessage, { type: 'transfer:error' }>['code'] =>
  value === 'INVALID_STATE'
  || value === 'CONTENT_MISMATCH'
  || value === 'CONTENT_TOO_LARGE'

export const parseTransferMessage = (raw: string): TransferParseResult => {
  if (
    raw.length > MAX_TRANSFER_FRAME_BYTES
    || textByteLength(raw) > MAX_TRANSFER_FRAME_BYTES
  ) {
    return protocolError(`Frame exceeds ${MAX_TRANSFER_FRAME_BYTES} UTF-8 bytes`)
  }

  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return protocolError('Frame is not valid JSON')
  }

  if (!isRecord(value)) return protocolError('Frame must be a JSON object')
  if (value.v !== 1) return protocolError('Unsupported protocol version')
  if (!isTransferId(value.transferId)) return protocolError('Invalid transfer ID')

  if (value.type === 'transfer:request') {
    if (!hasExactKeys(value, [
      'v',
      'type',
      'transferId',
      'kind',
      'characterCount',
      'byteLength',
    ])) {
      return protocolError('Invalid transfer request fields')
    }
    if (value.kind !== 'text') return protocolError('Unsupported transfer kind')
    if (!isBoundedInteger(value.characterCount, MAX_TEXT_CHARACTERS)) {
      return protocolError('Invalid character count')
    }
    if (!isBoundedInteger(value.byteLength, MAX_TRANSFER_FRAME_BYTES)) {
      return protocolError('Invalid byte length')
    }

    return {
      ok: true,
      message: {
        v: 1,
        type: 'transfer:request',
        transferId: value.transferId,
        kind: 'text',
        characterCount: value.characterCount,
        byteLength: value.byteLength,
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
        v: 1,
        type: 'transfer:decision',
        transferId: value.transferId,
        decision: value.decision,
      },
    }
  }

  if (value.type === 'transfer:text') {
    if (!hasExactKeys(value, ['v', 'type', 'transferId', 'text'])) {
      return protocolError('Invalid text transfer fields')
    }
    if (typeof value.text !== 'string' || value.text.length > MAX_TEXT_CHARACTERS) {
      return protocolError(`Text exceeds ${MAX_TEXT_CHARACTERS} characters`)
    }

    return {
      ok: true,
      message: {
        v: 1,
        type: 'transfer:text',
        transferId: value.transferId,
        text: value.text,
      },
    }
  }

  if (value.type === 'transfer:receipt') {
    if (!hasExactKeys(value, ['v', 'type', 'transferId', 'status'])) {
      return protocolError('Invalid transfer receipt fields')
    }
    if (value.status !== 'received') return protocolError('Invalid receipt status')

    return {
      ok: true,
      message: {
        v: 1,
        type: 'transfer:receipt',
        transferId: value.transferId,
        status: 'received',
      },
    }
  }

  if (value.type === 'transfer:cancel') {
    if (!hasExactKeys(value, ['v', 'type', 'transferId'])) {
      return protocolError('Invalid transfer cancellation fields')
    }

    return {
      ok: true,
      message: {
        v: 1,
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
        v: 1,
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
