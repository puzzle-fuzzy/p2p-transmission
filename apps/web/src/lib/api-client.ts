import { getApiBaseUrl } from './config'
import type { ApiError, ParticipantRole, PublicRoom, VisitorSession } from '../shared/contracts'

export type ApiClientOptions = {
  fetch?: typeof fetch
  apiBaseUrl?: string
}

type VisitorResponse = VisitorSession

type RoomResponse = {
  room: PublicRoom
}

type ErrorResponse = {
  error?: ApiError
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
    throw new Error(errorBody?.error?.message ?? '请求失败')
  }

  return readJson<T>(response)
}

export const createVisitor = (options?: ApiClientOptions) =>
  request<VisitorResponse>('/v1/visitors', { method: 'POST' }, options)

export const createRoom = async (token: string, options?: ApiClientOptions) => {
  const response = await request<RoomResponse>('/v1/rooms', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  }, options)

  return response.room
}

export const joinRoom = async (
  code: string,
  token: string,
  role: ParticipantRole = 'receiver',
  options?: ApiClientOptions,
) => {
  const response = await request<RoomResponse>(`/v1/rooms/${code}/join`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ role }),
  }, options)

  return response.room
}

export const getRoom = async (code: string, options?: ApiClientOptions) => {
  const response = await request<RoomResponse>(`/v1/rooms/${code}`, {
    method: 'GET',
  }, options)

  return response.room
}
