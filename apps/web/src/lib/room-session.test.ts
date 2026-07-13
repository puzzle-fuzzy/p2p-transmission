// @vitest-environment jsdom

import { beforeEach, describe, expect, test } from 'vitest'
import {
  clearRoomSession,
  loadRoomSession,
  saveRoomSession,
} from './room-session'

const roomSessionKey = 'p2p.roomSession'

describe('room session persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('round-trips a receiver room session and clears it', () => {
    const session = {
      roomCode: '123456',
      role: 'receiver' as const,
      expiresAt: 123_456_789,
    }

    saveRoomSession(session)
    expect(loadRoomSession()).toEqual(session)

    clearRoomSession()
    expect(loadRoomSession()).toBeUndefined()
  })

  test.each([
    { roomCode: '12345', role: 'receiver', expiresAt: 123_456_789 },
    { roomCode: '1234567', role: 'receiver', expiresAt: 123_456_789 },
    { roomCode: '12a456', role: 'receiver', expiresAt: 123_456_789 },
    { roomCode: 123_456, role: 'receiver', expiresAt: 123_456_789 },
    { roomCode: ['123456'], role: 'receiver', expiresAt: 123_456_789 },
    { roomCode: '123456', role: 'sender', expiresAt: 123_456_789 },
    { roomCode: '123456', role: 'receiver', expiresAt: 1.5 },
    { roomCode: '123456', role: 'receiver', expiresAt: '123456789' },
  ])('rejects malformed persisted values %#', value => {
    window.localStorage.setItem(roomSessionKey, JSON.stringify(value))

    expect(loadRoomSession()).toBeUndefined()
  })

  test('ignores malformed JSON', () => {
    window.localStorage.setItem(roomSessionKey, '{not-json')

    expect(loadRoomSession()).toBeUndefined()
  })
})
