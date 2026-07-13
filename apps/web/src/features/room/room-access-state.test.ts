import { describe, expect, test } from 'vitest'
import type { RoomJoinRequestSummary } from '../../shared/contracts'
import {
  initialRoomAccessState,
  roomAccessReducer,
} from './room-access-state'

const summary = (
  requestId: string,
  createdAt: number,
  displayName = requestId,
): RoomJoinRequestSummary => ({
  requestId,
  roomCode: '123456',
  visitor: {
    id: `visitor-${requestId}`,
    avatarSeed: `seed-${requestId}`,
    displayName,
    createdAt,
    lastSeenAt: createdAt,
  },
  createdAt,
  expiresAt: createdAt + 90_000,
})

describe('room access reducer', () => {
  test('replaces snapshots with a deduplicated stable queue', () => {
    const input = [
      summary('request-c', 2),
      summary('request-b', 1),
      summary('request-a', 1),
      summary('request-b', 1, '最新访客资料'),
    ]
    const state = roomAccessReducer({
      requests: [summary('stale', 0)],
      decision: { requestId: 'stale', decision: 'approve' },
    }, {
      type: 'snapshot',
      requests: input,
    })

    expect(state.requests.map(request => request.requestId)).toEqual([
      'request-a',
      'request-b',
      'request-c',
    ])
    expect(state.requests[1]?.visitor.displayName).toBe('最新访客资料')
    expect(state.decision).toBeUndefined()
    expect(input.map(request => request.requestId)).toEqual([
      'request-c',
      'request-b',
      'request-a',
      'request-b',
    ])
  })

  test('upserts requested events without duplicating dialogs', () => {
    const first = summary('request-b', 2)
    const state = roomAccessReducer(initialRoomAccessState, {
      type: 'requested',
      request: first,
    })
    const replay = roomAccessReducer(state, {
      type: 'requested',
      request: { ...first, visitor: { ...first.visitor, displayName: '重连访客' } },
    })
    const withEarlier = roomAccessReducer(replay, {
      type: 'requested',
      request: summary('request-a', 1),
    })

    expect(withEarlier.requests).toHaveLength(2)
    expect(withEarlier.requests.map(request => request.requestId)).toEqual([
      'request-a',
      'request-b',
    ])
    expect(withEarlier.requests[1]?.visitor.displayName).toBe('重连访客')
  })

  test('resolving one request leaves the remaining stable queue', () => {
    const state = {
      requests: [
        summary('request-a', 1),
        summary('request-b', 2),
        summary('request-c', 3),
      ],
      decision: { requestId: 'request-b', decision: 'reject' as const },
    }

    const resolved = roomAccessReducer(state, {
      type: 'resolved',
      requestId: 'request-b',
    })

    expect(resolved.requests.map(request => request.requestId)).toEqual([
      'request-a',
      'request-c',
    ])
    expect(resolved.decision).toBeUndefined()
  })

  test('tracks one decision and clears only the matching busy state on failure', () => {
    const state = {
      requests: [summary('request-a', 1), summary('request-b', 2)],
    }
    const deciding = roomAccessReducer(state, {
      type: 'decision:start',
      requestId: 'request-a',
      decision: 'approve',
    })

    expect(deciding.decision).toEqual({
      requestId: 'request-a',
      decision: 'approve',
    })
    expect(roomAccessReducer(deciding, {
      type: 'decision:finish',
      requestId: 'request-b',
    }).decision).toEqual(deciding.decision)

    const failed = roomAccessReducer(deciding, {
      type: 'decision:finish',
      requestId: 'request-a',
    })
    expect(failed.decision).toBeUndefined()
    expect(failed.requests).toEqual(state.requests)
  })

  test('a snapshot preserves a decision only while that request remains canonical', () => {
    const deciding = {
      requests: [summary('request-a', 1)],
      decision: { requestId: 'request-a', decision: 'approve' as const },
    }

    const retained = roomAccessReducer(deciding, {
      type: 'snapshot',
      requests: [summary('request-a', 1)],
    })
    expect(retained.decision).toEqual(deciding.decision)

    const cleared = roomAccessReducer(deciding, {
      type: 'snapshot',
      requests: [],
    })
    expect(cleared.decision).toBeUndefined()
  })

  test('reset clears queue and busy state', () => {
    const state = {
      requests: [summary('request-a', 1)],
      decision: { requestId: 'request-a', decision: 'approve' as const },
    }

    expect(roomAccessReducer(state, { type: 'reset' })).toEqual(initialRoomAccessState)
  })
})
