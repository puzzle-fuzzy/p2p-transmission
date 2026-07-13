import { describe, expect, test, vi } from 'vitest'
import {
  ApiClientError,
  cancelRoomJoinRequest,
  createRoom,
  createRoomJoinRequest,
  createVisitor,
  decideRoomJoinRequest,
  finalizeRoomJoinRequest,
  getRoomJoinRequest,
  joinRoom,
} from './api-client'

const apiOptions = (fetchMock: typeof fetch) => ({
  fetch: fetchMock,
  apiBaseUrl: 'http://api.test/',
})

const room = {
  code: '123456',
  senderId: 'vis_sender',
  receivers: [],
  participants: [],
  createdAt: 1,
  expiresAt: 2,
}

const inviteToken = `inv_${'A'.repeat(43)}`
const ownerBootstrap = {
  room,
  invite: {
    token: inviteToken,
    expiresAt: room.expiresAt,
  },
}
const receiverBootstrap = { room }
const pendingReceipt = {
  requestId: 'request_1',
  state: 'pending' as const,
  expiresAt: 90_000,
}

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), init)

describe('api-client', () => {
  test('creates a visitor from POST /v1/visitors', async () => {
    const visitorSession = {
      visitor: {
        id: 'vis_1',
        avatarSeed: 'seed_1',
        displayName: '访客 0001',
        createdAt: 1,
        lastSeenAt: 1,
      },
      token: 'tok_1',
    }
    const fetchMock = vi.fn(async () => jsonResponse(visitorSession))

    await expect(createVisitor(apiOptions(fetchMock))).resolves.toEqual(visitorSession)
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/v1/visitors', {
      method: 'POST',
    })
  })

  test('creates a room and validates the owner-only invitation bootstrap', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(ownerBootstrap))

    await expect(createRoom('sender-token', 'off', apiOptions(fetchMock)))
      .resolves.toEqual(ownerBootstrap)
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/v1/rooms', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sender-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ iceMode: 'off' }),
    })
  })

  test('joins only through the selected receiver admission branch and sends no role', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(receiverBootstrap))

    await joinRoom({
      roomCode: room.code,
      visitorToken: 'receiver-token',
      iceMode: 'off',
      admission: { kind: 'invite', inviteToken },
    }, apiOptions(fetchMock))
    await joinRoom({
      roomCode: room.code,
      visitorToken: 'receiver-token',
      iceMode: 'off',
      admission: { kind: 'recovery' },
    }, apiOptions(fetchMock))

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://api.test/v1/rooms/123456/join', {
      method: 'POST',
      headers: {
        authorization: 'Bearer receiver-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        iceMode: 'off',
        admission: { kind: 'invite', inviteToken },
      }),
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://api.test/v1/rooms/123456/join', {
      method: 'POST',
      headers: {
        authorization: 'Bearer receiver-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        iceMode: 'off',
        admission: { kind: 'recovery' },
      }),
    })
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('role')
  })

  test('rejects an unexpected admission branch before making a request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(receiverBootstrap))

    await expect(joinRoom({
      roomCode: room.code,
      visitorToken: 'receiver-token',
      iceMode: 'off',
      admission: { kind: 'approval', requestId: 'request_1' },
    } as never, apiOptions(fetchMock))).rejects.toMatchObject({
      code: 'INVALID_API_RESPONSE',
      status: 200,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('creates and reads a join request with the exact authorization envelope', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(pendingReceipt))

    await createRoomJoinRequest({
      roomCode: room.code,
      visitorToken: 'receiver-token',
    }, apiOptions(fetchMock))
    await getRoomJoinRequest({
      roomCode: room.code,
      requestId: pendingReceipt.requestId,
      visitorToken: 'receiver-token',
    }, apiOptions(fetchMock))

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://api.test/v1/rooms/123456/join-requests',
      {
        method: 'POST',
        headers: { authorization: 'Bearer receiver-token' },
      },
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://api.test/v1/rooms/123456/join-requests/request_1',
      {
        method: 'GET',
        headers: { authorization: 'Bearer receiver-token' },
      },
    )
  })

  test('decides, finalizes, and cancels with only their permitted bodies', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.body === JSON.stringify({ iceMode: 'api' })
        ? jsonResponse({
            ...receiverBootstrap,
            rtcConfiguration: {
              iceServers: [{
                urls: ['turn:turn.example.com:3478'],
                username: 'user',
                credential: 'credential',
                credentialType: 'password',
              }],
            },
            credentialExpiresAt: 3,
          })
        : jsonResponse(pendingReceipt))

    const request = {
      roomCode: room.code,
      requestId: pendingReceipt.requestId,
      visitorToken: 'actor-token',
    }
    await decideRoomJoinRequest({ ...request, decision: 'approve' }, apiOptions(fetchMock))
    await finalizeRoomJoinRequest({ ...request, iceMode: 'api' }, apiOptions(fetchMock))
    await cancelRoomJoinRequest(request, apiOptions(fetchMock))

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://api.test/v1/rooms/123456/join-requests/request_1/decision',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer actor-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approve' }),
      },
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://api.test/v1/rooms/123456/join-requests/request_1/finalize',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer actor-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ iceMode: 'api' }),
      },
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://api.test/v1/rooms/123456/join-requests/request_1/cancel',
      {
        method: 'POST',
        headers: { authorization: 'Bearer actor-token' },
      },
    )
  })

  test('encodes room and request path segments', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      error: { code: 'ROOM_JOIN_REQUEST_NOT_FOUND', message: 'not found' },
    }, { status: 404 }))

    await expect(getRoomJoinRequest({
      roomCode: '12/34?56',
      requestId: 'request/with spaces',
      visitorToken: 'token',
    }, apiOptions(fetchMock))).rejects.toBeInstanceOf(ApiClientError)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/v1/rooms/12%2F34%3F56/join-requests/request%2Fwith%20spaces',
      {
        method: 'GET',
        headers: { authorization: 'Bearer token' },
      },
    )
  })

  test('preserves API error code, message, and response status', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      error: {
        code: 'VISITOR_NOT_FOUND',
        message: '访客身份已失效',
      },
    }, { status: 401 }))

    const result = createRoom('stale-token', 'api', apiOptions(fetchMock))

    await expect(result).rejects.toMatchObject({
      name: 'ApiClientError',
      message: '访客身份已失效',
      code: 'VISITOR_NOT_FOUND',
      status: 401,
    })
  })

  test('rejects malformed or extra-key security-sensitive responses', async () => {
    const calls = [
      () => createVisitor(apiOptions(vi.fn(async () => jsonResponse({
        visitor: {
          id: 'vis_1',
          avatarSeed: 'seed_1',
          displayName: '访客 0001',
          createdAt: 1,
          lastSeenAt: 1,
        },
        token: 'token',
        extra: true,
      })))),
      () => createRoom('token', 'off', apiOptions(vi.fn(async () =>
        jsonResponse({ ...ownerBootstrap, extra: true })))),
      () => joinRoom({
        roomCode: room.code,
        visitorToken: 'token',
        iceMode: 'off',
        admission: { kind: 'recovery' },
      }, apiOptions(vi.fn(async () => jsonResponse({ ...receiverBootstrap, extra: true })))),
      () => createRoomJoinRequest({
        roomCode: room.code,
        visitorToken: 'token',
      }, apiOptions(vi.fn(async () => jsonResponse({ ...pendingReceipt, extra: true })))),
      () => getRoomJoinRequest({
        roomCode: room.code,
        requestId: pendingReceipt.requestId,
        visitorToken: 'token',
      }, apiOptions(vi.fn(async () => jsonResponse({ ...pendingReceipt, state: 'unknown' })))),
      () => decideRoomJoinRequest({
        roomCode: room.code,
        requestId: pendingReceipt.requestId,
        visitorToken: 'token',
        decision: 'reject',
      }, apiOptions(vi.fn(async () => jsonResponse({ requestId: 'request_1' })))),
      () => finalizeRoomJoinRequest({
        roomCode: room.code,
        requestId: pendingReceipt.requestId,
        visitorToken: 'token',
        iceMode: 'off',
      }, apiOptions(vi.fn(async () => jsonResponse({
        room: { ...room, code: '654321' },
      })))),
      () => cancelRoomJoinRequest({
        roomCode: room.code,
        requestId: pendingReceipt.requestId,
        visitorToken: 'token',
      }, apiOptions(vi.fn(async () => jsonResponse({ ...pendingReceipt, inviteToken })))),
    ]

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        code: 'INVALID_API_RESPONSE',
        status: 200,
      })
    }
  })

  test('rejects a valid receipt bound to a different request ID', async () => {
    const mismatchedReceipt = {
      ...pendingReceipt,
      requestId: 'request_2',
    }
    const fetchMock = vi.fn(async () => jsonResponse(mismatchedReceipt))
    const request = {
      roomCode: room.code,
      requestId: pendingReceipt.requestId,
      visitorToken: 'actor-token',
    }

    const calls = [
      () => getRoomJoinRequest(request, apiOptions(fetchMock)),
      () => decideRoomJoinRequest({
        ...request,
        decision: 'approve',
      }, apiOptions(fetchMock)),
      () => cancelRoomJoinRequest(request, apiOptions(fetchMock)),
    ]

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        code: 'INVALID_API_RESPONSE',
        status: 200,
      })
    }
  })

  test('rejects a room bootstrap whose TURN fields do not match the selected ICE mode', async () => {
    const credentialed = {
      ...receiverBootstrap,
      rtcConfiguration: {
        iceServers: [{
          urls: ['turn:turn.example.com:3478'],
          username: 'user',
          credential: 'credential',
        }],
      },
      credentialExpiresAt: 3,
    }
    const fetchMock = vi.fn(async () => jsonResponse(credentialed))

    await expect(joinRoom({
      roomCode: room.code,
      visitorToken: 'token',
      iceMode: 'off',
      admission: { kind: 'recovery' },
    }, apiOptions(fetchMock))).rejects.toMatchObject({ code: 'INVALID_API_RESPONSE' })
  })

  test('does not expose the removed public room lookup client', async () => {
    const apiClient = await import('./api-client')

    expect(apiClient).not.toHaveProperty('getRoom')
  })
})
