import { describe, expect, test } from 'vitest'
import {
  initialRoomFlowState,
  roomFlowReducer,
  type RoomFlowState,
} from './state'
import type { PublicRoom, VisitorSession } from '../../shared/contracts'

const visitorSession: VisitorSession = {
  token: 'tok_1',
  visitor: {
    id: 'vis_1',
    avatarSeed: 'seed_1',
    displayName: '访客 0001',
    createdAt: 1,
    lastSeenAt: 1,
  },
}

const room: PublicRoom = {
  code: '123456',
  senderId: 'vis_1',
  receivers: [],
  participants: [{
    visitor: visitorSession.visitor,
    role: 'sender',
    joinedAt: 1,
    status: 'online',
  }],
  createdAt: 1,
  expiresAt: 2,
}

const receiver = {
  id: 'vis_2',
  avatarSeed: 'seed_2',
  displayName: '访客 0002',
  createdAt: 1,
  lastSeenAt: 1,
}

describe('room flow reducer', () => {
  test('visitor ready moves booting to lobby', () => {
    const state = roomFlowReducer({
      ...initialRoomFlowState,
      room,
      role: 'sender',
      readyPeerCount: 1,
    }, {
      type: 'visitor:ready',
      session: visitorSession,
    })

    expect(state.phase).toBe('lobby')
    expect(state.session).toEqual(visitorSession)
    expect(state.room).toBeUndefined()
    expect(state.role).toBeUndefined()
    expect(state.readyPeerCount).toBe(0)
  })

  test('room created stores sender room state', () => {
    const state = roomFlowReducer({ ...initialRoomFlowState, session: visitorSession }, {
      type: 'room:created',
      room,
    })

    expect(state.phase).toBe('room')
    expect(state.role).toBe('sender')
    expect(state.room?.code).toBe('123456')
  })

  test('room joined stores receiver room state', () => {
    const state = roomFlowReducer({ ...initialRoomFlowState, session: visitorSession }, {
      type: 'room:joined',
      room,
    })

    expect(state.phase).toBe('room')
    expect(state.role).toBe('receiver')
  })

  test('realtime connected marks room connecting', () => {
    const state = roomFlowReducer({
      ...initialRoomFlowState,
      phase: 'room',
      room,
      role: 'sender',
      session: visitorSession,
    }, { type: 'realtime:connected' })

    expect(state.phase).toBe('connecting')
  })

  test('participants update membership without implying DataChannel readiness', () => {
    const updatedRoom: PublicRoom = {
      ...room,
      receivers: ['vis_2'],
      participants: [
        ...room.participants,
        {
          visitor: receiver,
          role: 'receiver',
          joinedAt: 1,
          status: 'online',
        },
      ],
    }
    const state = roomFlowReducer({
      ...initialRoomFlowState,
      phase: 'connecting',
      room,
      role: 'sender',
      session: visitorSession,
    }, {
      type: 'server:message',
      message: { type: 'room:participants', room: updatedRoom },
    })

    expect(state.phase).toBe('connecting')
    expect(state.room?.participants).toHaveLength(2)
    expect(state.readyPeerCount).toBe(0)
  })

  test('peer readiness controls the ready phase independently of membership', () => {
    const readyState = roomFlowReducer({
      ...initialRoomFlowState,
      phase: 'connecting',
      room,
      role: 'sender',
      session: visitorSession,
    }, { type: 'peer:ready-count', count: 1 })

    expect(readyState.phase).toBe('ready')
    expect(readyState.readyPeerCount).toBe(1)

    const connectingState = roomFlowReducer(readyState, {
      type: 'peer:ready-count',
      count: 0,
    })

    expect(connectingState.phase).toBe('connecting')
    expect(connectingState.readyPeerCount).toBe(0)
  })

  test('realtime disconnect clears peer readiness', () => {
    const state = roomFlowReducer({
      ...initialRoomFlowState,
      phase: 'ready',
      room,
      role: 'sender',
      session: visitorSession,
      readyPeerCount: 1,
    }, { type: 'realtime:disconnected' })

    expect(state.phase).toBe('connecting')
    expect(state.readyPeerCount).toBe(0)
  })

  test('participant left updates membership without guessing peer readiness', () => {
    const stateWithParticipants: RoomFlowState = {
      ...initialRoomFlowState,
      phase: 'ready',
      role: 'sender',
      session: visitorSession,
      room: {
        ...room,
        receivers: ['vis_2'],
        participants: [
          ...room.participants,
          {
            visitor: receiver,
            role: 'receiver',
            joinedAt: 1,
            status: 'online',
          },
        ],
      },
      error: '',
      readyPeerCount: 1,
    }

    const state = roomFlowReducer(stateWithParticipants, {
      type: 'server:message',
      message: { type: 'participant:left', roomCode: '123456', visitorId: 'vis_2' },
    })

    expect(state.phase).toBe('ready')
    expect(state.readyPeerCount).toBe(1)
    expect(state.room?.participants).toHaveLength(1)
    expect(state.room?.receivers).toEqual([])
  })

  test('error stores visible message', () => {
    const state = roomFlowReducer(initialRoomFlowState, {
      type: 'server:message',
      message: { type: 'error', code: 'ROOM_NOT_FOUND', message: '房间不存在或已过期' },
    })

    expect(state.phase).toBe('error')
    expect(state.error).toBe('房间不存在或已过期')
  })
})
