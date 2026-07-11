import { describe, expect, test, vi } from 'vitest'
import { createRoom, createVisitor, getRoom, joinRoom } from './api-client'

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

    await createRoom('tok_1', { fetch: fetchMock, apiBaseUrl: 'http://api.test' })
    await joinRoom('123456', 'tok_2', 'receiver', {
      fetch: fetchMock,
      apiBaseUrl: 'http://api.test',
    })
    await getRoom('123456', { fetch: fetchMock, apiBaseUrl: 'http://api.test' })

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://api.test/v1/rooms', {
      method: 'POST',
      headers: { authorization: 'Bearer tok_1' },
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://api.test/v1/rooms/123456/join', {
      method: 'POST',
      headers: {
        authorization: 'Bearer tok_2',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'receiver' }),
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
})
