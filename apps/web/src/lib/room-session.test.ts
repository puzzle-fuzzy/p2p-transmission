// @vitest-environment jsdom

import { beforeEach, describe, expect, test } from 'vitest'
import {
  clearRoomSession,
  loadRoomSession,
  saveRoomSession,
} from './room-session'

const legacyRoomSessionKey = 'p2p.roomSession'
const roomSessionKey = 'p2p.roomSession:v2:p2p-transmission:tab-a'

describe('room session persistence', () => {
  beforeEach(() => {
    window.name = 'p2p-transmission:tab-a'
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  test('round-trips a receiver room session in same-tab session storage and clears it', () => {
    const session = {
      roomCode: '123456',
      role: 'receiver' as const,
      expiresAt: 123_456_789,
    }

    saveRoomSession(session)
    expect(window.sessionStorage.getItem(roomSessionKey)).toBe(JSON.stringify(session))
    expect(window.localStorage.getItem(roomSessionKey)).toBeNull()
    expect(loadRoomSession()).toEqual(session)

    clearRoomSession()
    expect(loadRoomSession()).toBeUndefined()
  })

  test('isolates recovery between tabs while preserving same-tab refresh', () => {
    saveRoomSession({
      roomCode: '123456',
      role: 'receiver',
      expiresAt: 123_456_789,
    })

    expect(loadRoomSession()).toEqual({
      roomCode: '123456',
      role: 'receiver',
      expiresAt: 123_456_789,
    })

    window.name = 'p2p-transmission:tab-b'
    expect(loadRoomSession()).toBeUndefined()
  })

  test('persists only the recovery allowlist from a structurally compatible object', () => {
    const compatibleSession = {
      roomCode: '123456',
      role: 'receiver' as const,
      expiresAt: 123_456_789,
      inviteToken: 'inv_secret',
      requestId: 'req_secret',
      token: 'visitor_secret',
    }

    saveRoomSession(compatibleSession)

    const raw = window.sessionStorage.getItem(roomSessionKey)
    expect(raw).toBe(JSON.stringify({
      roomCode: '123456',
      role: 'receiver',
      expiresAt: 123_456_789,
    }))
    expect(raw).not.toContain('inviteToken')
    expect(raw).not.toContain('requestId')
    expect(raw).not.toContain('visitor_secret')
  })

  test.each([
    { roomCode: '12345', role: 'receiver', expiresAt: 123_456_789 },
    { roomCode: '1234567', role: 'receiver', expiresAt: 123_456_789 },
    { roomCode: '12a456', role: 'receiver', expiresAt: 123_456_789 },
    { roomCode: 123_456, role: 'receiver', expiresAt: 123_456_789 },
    { roomCode: ['123456'], role: 'receiver', expiresAt: 123_456_789 },
    { roomCode: '123456', role: 'sender', expiresAt: 123_456_789 },
    { roomCode: '123456', role: 'receiver', expiresAt: 0 },
    { roomCode: '123456', role: 'receiver', expiresAt: 1.5 },
    { roomCode: '123456', role: 'receiver', expiresAt: '123456789' },
    { roomCode: '123456', role: 'receiver', expiresAt: 123_456_789, inviteToken: 'secret' },
    { roomCode: '123456', role: 'receiver', expiresAt: 123_456_789, requestId: 'req_1' },
    { roomCode: '123456', role: 'receiver', expiresAt: 123_456_789, token: 'visitor-secret' },
    { roomCode: '123456', role: 'receiver', expiresAt: 123_456_789, extra: true },
  ])('rejects malformed or non-exact persisted values %#', value => {
    window.sessionStorage.setItem(roomSessionKey, JSON.stringify(value))

    expect(loadRoomSession()).toBeUndefined()
    expect(window.sessionStorage.getItem(roomSessionKey)).toBeNull()
  })

  test('ignores malformed JSON', () => {
    window.sessionStorage.setItem(roomSessionKey, '{not-json')

    expect(loadRoomSession()).toBeUndefined()
  })

  test('deletes legacy local storage on load without migrating it', () => {
    window.localStorage.setItem(legacyRoomSessionKey, JSON.stringify({
      roomCode: '123456',
      role: 'receiver',
      expiresAt: 123_456_789,
    }))

    expect(loadRoomSession()).toBeUndefined()
    expect(window.localStorage.getItem(legacyRoomSessionKey)).toBeNull()
    expect(window.sessionStorage.getItem(roomSessionKey)).toBeNull()
  })

  test('deletes legacy local storage on clear', () => {
    window.localStorage.setItem(legacyRoomSessionKey, 'legacy')
    window.sessionStorage.setItem(roomSessionKey, 'current')

    clearRoomSession()

    expect(window.localStorage.getItem(legacyRoomSessionKey)).toBeNull()
    expect(window.sessionStorage.getItem(roomSessionKey)).toBeNull()
  })
})
