import { describe, expect, test, vi } from 'vitest'
import {
  ApiClientError,
  createRoom,
  createVisitor,
  getRoom,
  joinRoom,
} from './api-client'

describe('api-client', () => {
  test('creates a visitor from POST /v1/visitors', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      visitor: {
        id: 'vis_1',
        avatarSeed: 'seed_1',
        displayName: '访客 0001',
        createdAt: 1,
        lastSeenAt: 1,
      },
      token: 'tok_1',
    })))

    const result = await createVisitor({
      fetch: fetchMock,
      apiBaseUrl: 'http://api.test',
    })

    expect(fetchMock).toHaveBeenCalledWith('http://api.test/v1/visitors', {
      method: 'POST',
    })
    expect(result.token).toBe('tok_1')
  })

  test('sends bearer token when creating and joining rooms', async () => {
    const room = {
      code: '123456',
      senderId: 'vis_1',
      receivers: [],
      participants: [],
      createdAt: 1,
      expiresAt: 2,
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ room })))

    await createRoom('tok_1', 'off', { fetch: fetchMock, apiBaseUrl: 'http://api.test' })
    await joinRoom('123456', 'tok_2', 'receiver', 'off', {
      fetch: fetchMock,
      apiBaseUrl: 'http://api.test',
    })
    await getRoom('123456', { fetch: fetchMock, apiBaseUrl: 'http://api.test' })

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://api.test/v1/rooms', {
      method: 'POST',
      headers: {
        authorization: 'Bearer tok_1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ iceMode: 'off' }),
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://api.test/v1/rooms/123456/join', {
      method: 'POST',
      headers: {
        authorization: 'Bearer tok_2',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'receiver', iceMode: 'off' }),
    })
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'http://api.test/v1/rooms/123456', {
      method: 'GET',
    })
  })

  test('maps API errors to thrown messages', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 'ROOM_NOT_FOUND',
        message: '房间不存在或已过期',
      },
    }), { status: 404 }))

    await expect(getRoom('000000', {
      fetch: fetchMock,
      apiBaseUrl: 'http://api.test',
    })).rejects.toThrow('房间不存在或已过期')
  })

  test('preserves API error code and response status', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 'VISITOR_NOT_FOUND',
        message: '访客身份已失效',
      },
    }), { status: 401 }))

    const request = createRoom('stale-token', 'api', {
      fetch: fetchMock,
      apiBaseUrl: 'http://api.test',
    })

    await expect(request).rejects.toBeInstanceOf(ApiClientError)
    await expect(request).rejects.toMatchObject({
      name: 'ApiClientError',
      message: '访客身份已失效',
      code: 'VISITOR_NOT_FOUND',
      status: 401,
    })
  })

  test('returns an atomic room bootstrap and rejects unpaired TURN fields', async () => {
    const room = {
      code: '123456',
      senderId: 'vis_1',
      receivers: [],
      participants: [],
      createdAt: 1,
      expiresAt: 2,
    }
    const bootstrap = {
      room,
      rtcConfiguration: {
        iceServers: [{
          urls: ['turn:turn.example.com:3478'],
          username: '3:vis_1',
          credential: 'signed',
          credentialType: 'password',
        }],
      },
      credentialExpiresAt: 3,
    }
    const validFetch = vi.fn(async () => new Response(JSON.stringify(bootstrap)))

    await expect(createRoom('tok_1', 'api', {
      fetch: validFetch,
      apiBaseUrl: 'http://api.test',
    })).resolves.toEqual(bootstrap)

    const invalidFetch = vi.fn(async () => new Response(JSON.stringify({
      room,
      rtcConfiguration: bootstrap.rtcConfiguration,
    })))
    await expect(createRoom('tok_1', 'api', {
      fetch: invalidFetch,
      apiBaseUrl: 'http://api.test',
    })).rejects.toMatchObject({
      code: 'INVALID_API_RESPONSE',
      status: 200,
    })
  })

  test('rejects credentials in off mode and a mismatched joined room code', async () => {
    const room = {
      code: '123456',
      senderId: 'vis_1',
      receivers: [],
      participants: [],
      createdAt: 1,
      expiresAt: 2,
    }
    const credentialed = {
      room,
      rtcConfiguration: {
        iceServers: [{
          urls: ['turn:turn.example.com:3478'],
          username: '3:vis_1',
          credential: 'signed',
        }],
      },
      credentialExpiresAt: 3,
    }
    const credentialedFetch = vi.fn(async () => new Response(JSON.stringify(credentialed)))

    await expect(createRoom('tok_1', 'off', {
      fetch: credentialedFetch,
      apiBaseUrl: 'http://api.test',
    })).rejects.toMatchObject({ code: 'INVALID_API_RESPONSE' })

    const wrongRoomFetch = vi.fn(async () => new Response(JSON.stringify({ room })))
    await expect(joinRoom('654321', 'tok_1', 'receiver', 'off', {
      fetch: wrongRoomFetch,
      apiBaseUrl: 'http://api.test',
    })).rejects.toMatchObject({ code: 'INVALID_API_RESPONSE' })
  })
})
