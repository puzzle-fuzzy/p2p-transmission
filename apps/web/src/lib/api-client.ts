import { getApiBaseUrl } from './config'
import {
  isReceiverJoinBody,
  isRoomJoinRequestReceipt,
  isRoomOwnerBootstrap,
  isRoomSessionBootstrap,
} from '../shared/contracts'
import type {
  ApiError,
  ReceiverJoinBody,
  RoomIceMode,
  RoomJoinRequestReceipt,
  RoomOwnerBootstrap,
  RoomSessionBootstrap,
  VisitorSession,
} from '../shared/contracts'

export type ApiClientOptions = {
  fetch?: typeof fetch
  apiBaseUrl?: string
}

export type JoinRoomInput = {
  roomCode: string
  visitorToken: string
  iceMode: RoomIceMode
  admission: ReceiverJoinBody['admission']
}

export type RoomJoinRequestInput = {
  roomCode: string
  visitorToken: string
}

export type BoundRoomJoinRequestInput = RoomJoinRequestInput & {
  requestId: string
}

type ErrorResponse = {
  error?: ApiError
}

export class ApiClientError extends Error {
  readonly code: string
  readonly status: number

  constructor(
    message: string,
    code: string,
    status: number,
  ) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.status = status
  }
}

const resolveOptions = (options: ApiClientOptions = {}) => ({
  fetcher: options.fetch ?? fetch,
  apiBaseUrl: (options.apiBaseUrl ?? getApiBaseUrl()).replace(/\/+$/, ''),
})

const readJson = async <T>(response: Response): Promise<T> => {
  const body = await response.text()

  if (!body) return undefined as T

  return JSON.parse(body) as T
}

const invalidApiResponse = () =>
  new ApiClientError('服务端返回了无效的响应', 'INVALID_API_RESPONSE', 200)

const request = async (
  path: string,
  init: RequestInit,
  options?: ApiClientOptions,
): Promise<unknown> => {
  const { fetcher, apiBaseUrl } = resolveOptions(options)
  const response = await fetcher(`${apiBaseUrl}${path}`, init)

  if (!response.ok) {
    const errorBody = await readJson<ErrorResponse>(response).catch(() => undefined)
    throw new ApiClientError(
      errorBody?.error?.message ?? '请求失败',
      errorBody?.error?.code ?? 'UNKNOWN_API_ERROR',
      response.status,
    )
  }

  return readJson<unknown>(response).catch(() => {
    throw invalidApiResponse()
  })
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
) => Object.keys(value).length === keys.length
  && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))

const isPositiveEpoch = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const isVisitorSession = (value: unknown): value is VisitorSession => {
  if (!isRecord(value) || !hasExactKeys(value, ['visitor', 'token'])) return false
  if (typeof value.token !== 'string' || value.token.length === 0) return false
  if (!isRecord(value.visitor) || !hasExactKeys(value.visitor, [
    'id',
    'avatarSeed',
    'displayName',
    'createdAt',
    'lastSeenAt',
  ])) {
    return false
  }

  return typeof value.visitor.id === 'string'
    && value.visitor.id.length > 0
    && typeof value.visitor.avatarSeed === 'string'
    && value.visitor.avatarSeed.length > 0
    && typeof value.visitor.displayName === 'string'
    && value.visitor.displayName.length > 0
    && isPositiveEpoch(value.visitor.createdAt)
    && isPositiveEpoch(value.visitor.lastSeenAt)
}

const hasExpectedIceConfiguration = (
  value: RoomSessionBootstrap,
  iceMode: RoomIceMode,
) => {
  const hasConfiguration = value.rtcConfiguration !== undefined
    && value.credentialExpiresAt !== undefined
  return hasConfiguration === (iceMode === 'api')
}

const assertRoomBootstrap = (
  value: unknown,
  iceMode: RoomIceMode,
  expectedRoomCode: string,
): RoomSessionBootstrap => {
  if (
    isRoomSessionBootstrap(value)
    && value.room.code === expectedRoomCode
    && hasExpectedIceConfiguration(value, iceMode)
  ) {
    return value
  }

  throw invalidApiResponse()
}

const assertRoomOwnerBootstrap = (
  value: unknown,
  iceMode: RoomIceMode,
): RoomOwnerBootstrap => {
  if (isRoomOwnerBootstrap(value) && hasExpectedIceConfiguration(value, iceMode)) {
    return value
  }

  throw invalidApiResponse()
}

const assertJoinRequestReceipt = (
  value: unknown,
  expectedRequestId?: string,
): RoomJoinRequestReceipt => {
  if (
    isRoomJoinRequestReceipt(value)
    && (expectedRequestId === undefined || value.requestId === expectedRequestId)
  ) {
    return value
  }
  throw invalidApiResponse()
}

const bearerHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
})

const jsonHeaders = (token: string) => ({
  ...bearerHeaders(token),
  'content-type': 'application/json',
})

const roomPath = (roomCode: string) =>
  `/v1/rooms/${encodeURIComponent(roomCode)}`

const requestPath = (input: BoundRoomJoinRequestInput) =>
  `${roomPath(input.roomCode)}/join-requests/${encodeURIComponent(input.requestId)}`

export const createVisitor = async (
  options?: ApiClientOptions,
): Promise<VisitorSession> => {
  const response = await request('/v1/visitors', { method: 'POST' }, options)
  if (isVisitorSession(response)) return response
  throw invalidApiResponse()
}

export const createRoom = async (
  token: string,
  iceMode: RoomIceMode,
  options?: ApiClientOptions,
): Promise<RoomOwnerBootstrap> => {
  const response = await request('/v1/rooms', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ iceMode }),
  }, options)

  return assertRoomOwnerBootstrap(response, iceMode)
}

export const joinRoom = async (
  input: JoinRoomInput,
  options?: ApiClientOptions,
): Promise<RoomSessionBootstrap> => {
  if (!isReceiverJoinBody({
    iceMode: input.iceMode,
    admission: input.admission,
  })) {
    throw invalidApiResponse()
  }

  const admission = input.admission.kind === 'invite'
    ? { kind: 'invite' as const, inviteToken: input.admission.inviteToken }
    : { kind: 'recovery' as const }
  const response = await request(`${roomPath(input.roomCode)}/join`, {
    method: 'POST',
    headers: jsonHeaders(input.visitorToken),
    body: JSON.stringify({
      iceMode: input.iceMode,
      admission,
    }),
  }, options)

  return assertRoomBootstrap(response, input.iceMode, input.roomCode)
}

export const createRoomJoinRequest = async (
  input: RoomJoinRequestInput,
  options?: ApiClientOptions,
): Promise<RoomJoinRequestReceipt> => {
  const response = await request(`${roomPath(input.roomCode)}/join-requests`, {
    method: 'POST',
    headers: bearerHeaders(input.visitorToken),
  }, options)

  return assertJoinRequestReceipt(response)
}

export const getRoomJoinRequest = async (
  input: BoundRoomJoinRequestInput,
  options?: ApiClientOptions,
): Promise<RoomJoinRequestReceipt> => {
  const response = await request(requestPath(input), {
    method: 'GET',
    headers: bearerHeaders(input.visitorToken),
  }, options)

  return assertJoinRequestReceipt(response, input.requestId)
}

export const decideRoomJoinRequest = async (
  input: BoundRoomJoinRequestInput & { decision: 'approve' | 'reject' },
  options?: ApiClientOptions,
): Promise<RoomJoinRequestReceipt> => {
  const response = await request(`${requestPath(input)}/decision`, {
    method: 'POST',
    headers: jsonHeaders(input.visitorToken),
    body: JSON.stringify({ decision: input.decision }),
  }, options)

  return assertJoinRequestReceipt(response, input.requestId)
}

export const finalizeRoomJoinRequest = async (
  input: BoundRoomJoinRequestInput & { iceMode: RoomIceMode },
  options?: ApiClientOptions,
): Promise<RoomSessionBootstrap> => {
  const response = await request(`${requestPath(input)}/finalize`, {
    method: 'POST',
    headers: jsonHeaders(input.visitorToken),
    body: JSON.stringify({ iceMode: input.iceMode }),
  }, options)

  return assertRoomBootstrap(response, input.iceMode, input.roomCode)
}

export const cancelRoomJoinRequest = async (
  input: BoundRoomJoinRequestInput,
  options?: ApiClientOptions,
): Promise<RoomJoinRequestReceipt> => {
  const response = await request(`${requestPath(input)}/cancel`, {
    method: 'POST',
    headers: bearerHeaders(input.visitorToken),
  }, options)

  return assertJoinRequestReceipt(response, input.requestId)
}
