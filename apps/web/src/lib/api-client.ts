import { getApiBaseUrl } from './config'
import { isRoomSessionBootstrap } from '@p2p/contracts'
import type {
  ApiError,
  ParticipantRole,
  PublicRoom,
  RoomIceMode,
  RoomSessionBootstrap,
  VisitorSession,
} from '../shared/contracts'

export type ApiClientOptions = {
  fetch?: typeof fetch
  apiBaseUrl?: string
}

type VisitorResponse = VisitorSession

type RoomResponse = { room: PublicRoom }

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

const request = async <T>(
  path: string,
  init: RequestInit,
  options?: ApiClientOptions,
): Promise<T> => {
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

  return readJson<T>(response)
}

export const createVisitor = (options?: ApiClientOptions) =>
  request<VisitorResponse>('/v1/visitors', { method: 'POST' }, options)

const assertRoomBootstrap = (
  value: unknown,
  iceMode: RoomIceMode,
  expectedRoomCode?: string,
): RoomSessionBootstrap => {
  if (isRoomSessionBootstrap(value)) {
    const hasCredential = value.rtcConfiguration !== undefined
      && value.credentialExpiresAt !== undefined
    if (
      hasCredential === (iceMode === 'api')
      && (expectedRoomCode === undefined || value.room.code === expectedRoomCode)
    ) {
      return value
    }
  }
  throw new ApiClientError('服务端返回了无效的房间配置', 'INVALID_API_RESPONSE', 200)
}

export const createRoom = async (
  token: string,
  iceMode: RoomIceMode,
  options?: ApiClientOptions,
) => {
  const response = await request<unknown>('/v1/rooms', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ iceMode }),
  }, options)

  return assertRoomBootstrap(response, iceMode)
}

export const joinRoom = async (
  code: string,
  token: string,
  role: ParticipantRole,
  iceMode: RoomIceMode,
  options?: ApiClientOptions,
) => {
  const response = await request<unknown>(`/v1/rooms/${code}/join`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ role, iceMode }),
  }, options)

  return assertRoomBootstrap(response, iceMode, code)
}

export const getRoom = async (code: string, options?: ApiClientOptions) => {
  const response = await request<RoomResponse>(`/v1/rooms/${code}`, {
    method: 'GET',
  }, options)

  return response.room
}
