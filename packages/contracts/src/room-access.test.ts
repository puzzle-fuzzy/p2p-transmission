import { describe, expect, test } from 'bun:test'
import {
  isReceiverJoinBody,
  isRoomAccessServerMessage,
  isRoomInviteToken,
  isRoomJoinRequestReceipt,
  isRoomJoinRequestSummary,
  isRoomOwnerBootstrap,
  type RoomJoinRequestState,
} from './room-access'

const inviteToken = `inv_${'A'.repeat(43)}`

const visitor = {
  id: 'vis_receiver',
  avatarSeed: 'receiver',
  displayName: '接收者',
  createdAt: 1,
  lastSeenAt: 1,
}

const room = {
  code: '123456',
  senderId: 'vis_sender',
  receivers: ['vis_receiver'],
  participants: [{
    visitor,
    role: 'receiver' as const,
    joinedAt: 1,
    status: 'online' as const,
  }],
  createdAt: 1,
  expiresAt: 1_800_001,
}

const summary = {
  requestId: 'request_1',
  roomCode: room.code,
  visitor,
  createdAt: 10,
  expiresAt: 90_010,
}

describe('room invitation contracts', () => {
  test('accepts only the exact invitation capability token shape', () => {
    expect(isRoomInviteToken(inviteToken)).toBe(true)
    expect(isRoomInviteToken(`inv_${'A'.repeat(42)}`)).toBe(false)
    expect(isRoomInviteToken(`inv_${'A'.repeat(44)}`)).toBe(false)
    expect(isRoomInviteToken(`inv_${'A'.repeat(42)}=`)).toBe(false)
    expect(isRoomInviteToken(`inv_${'-_'.repeat(21)}-`)).toBe(true)
    expect(isRoomInviteToken(`INV_${'A'.repeat(43)}`)).toBe(false)
    expect(isRoomInviteToken(123)).toBe(false)
  })

  test('validates exact public invitation and recovery join branches', () => {
    expect(isReceiverJoinBody({
      iceMode: 'api',
      admission: { kind: 'invite', inviteToken },
    })).toBe(true)
    expect(isReceiverJoinBody({
      iceMode: 'off',
      admission: { kind: 'recovery' },
    })).toBe(true)

    // Exact token authorization happens in the room service so malformed and
    // incorrect capabilities share the same external denial response.
    expect(isReceiverJoinBody({
      iceMode: 'off',
      admission: { kind: 'invite', inviteToken: 'malformed' },
    })).toBe(true)

    for (const value of [
      { iceMode: 'off', admission: { kind: 'approval', requestId: 'request_1' } },
      { iceMode: 'off', admission: { kind: 'recovery', requestId: 'request_1' } },
      { iceMode: 'off', admission: { kind: 'recovery', inviteToken } },
      { iceMode: 'off', admission: { kind: 'invite', inviteToken, requestId: 'request_1' } },
      { iceMode: 'off', admission: { kind: 'invite' } },
      { iceMode: 'off', admission: { kind: 'invite', inviteToken: '' } },
      { iceMode: 'off', admission: { kind: 'invite', inviteToken: 'x'.repeat(129) } },
      { iceMode: 'off', admission: { kind: 'recovery' }, extra: true },
      { iceMode: 'static', admission: { kind: 'recovery' } },
      { iceMode: 'off' },
    ]) {
      expect(isReceiverJoinBody(value)).toBe(false)
    }
  })

  test('validates owner bootstrap without weakening the ordinary bootstrap', () => {
    expect(isRoomOwnerBootstrap({
      room,
      invite: { token: inviteToken, expiresAt: room.expiresAt },
    })).toBe(true)
    expect(isRoomOwnerBootstrap({
      room,
      rtcConfiguration: {
        iceServers: [{
          urls: ['turn:turn.example.com:3478'],
          username: 'user',
          credential: 'credential',
          credentialType: 'password',
        }],
      },
      credentialExpiresAt: room.expiresAt + 300_000,
      invite: { token: inviteToken, expiresAt: room.expiresAt },
    })).toBe(true)
    expect(isRoomOwnerBootstrap({
      room,
      invite: { token: inviteToken, expiresAt: room.expiresAt - 1 },
    })).toBe(false)
    expect(isRoomOwnerBootstrap({
      room,
      invite: { token: inviteToken, expiresAt: room.expiresAt, extra: true },
    })).toBe(false)
    expect(isRoomOwnerBootstrap({ room })).toBe(false)
    expect(isRoomOwnerBootstrap({
      room,
      invite: { token: `inv_${'A'.repeat(42)}`, expiresAt: room.expiresAt },
    })).toBe(false)
  })
})

describe('room join request contracts', () => {
  const states: RoomJoinRequestState[] = [
    'pending',
    'approved',
    'rejected',
    'cancelled',
    'expired',
    'finalized',
  ]

  test('validates exact receipts and every state', () => {
    for (const state of states) {
      expect(isRoomJoinRequestReceipt({
        requestId: 'r',
        state,
        expiresAt: 1,
      })).toBe(true)
    }
    expect(isRoomJoinRequestReceipt({
      requestId: 'r'.repeat(96),
      state: 'pending',
      expiresAt: Number.MAX_SAFE_INTEGER,
    })).toBe(true)

    for (const value of [
      { requestId: '', state: 'pending', expiresAt: 1 },
      { requestId: 'r'.repeat(97), state: 'pending', expiresAt: 1 },
      { requestId: 'r', state: 'unknown', expiresAt: 1 },
      { requestId: 'r', state: 'pending', expiresAt: 0 },
      { requestId: 'r', state: 'pending', expiresAt: 1.5 },
      { requestId: 'r', state: 'pending', expiresAt: Number.MAX_SAFE_INTEGER + 1 },
      { requestId: 'r', state: 'pending', expiresAt: 1, inviteToken },
    ]) {
      expect(isRoomJoinRequestReceipt(value)).toBe(false)
    }
  })

  test('validates exact summaries, ASCII room codes, visitor shape, and deadlines', () => {
    expect(isRoomJoinRequestSummary(summary)).toBe(true)
    expect(isRoomJoinRequestSummary({ ...summary, requestId: 'r' })).toBe(true)
    expect(isRoomJoinRequestSummary({ ...summary, requestId: 'r'.repeat(96) })).toBe(true)

    for (const value of [
      { ...summary, requestId: '' },
      { ...summary, requestId: 'r'.repeat(97) },
      { ...summary, roomCode: '12345' },
      { ...summary, roomCode: '1234567' },
      { ...summary, roomCode: '１２３４５６' },
      { ...summary, createdAt: 0 },
      { ...summary, expiresAt: summary.createdAt },
      { ...summary, visitor: { ...visitor, extra: true } },
      { ...summary, visitor: { ...visitor, lastSeenAt: 1.5 } },
      { ...summary, inviteToken },
    ]) {
      expect(isRoomJoinRequestSummary(value)).toBe(false)
    }
  })
})

describe('room access realtime contracts', () => {
  test('accepts exact snapshot, requested, and terminal resolution messages', () => {
    expect(isRoomAccessServerMessage({
      type: 'room:join-requests',
      roomCode: room.code,
      requests: [summary],
    })).toBe(true)
    expect(isRoomAccessServerMessage({
      type: 'room:join-requested',
      request: summary,
    })).toBe(true)

    for (const state of ['approved', 'rejected', 'cancelled', 'expired', 'finalized']) {
      expect(isRoomAccessServerMessage({
        type: 'room:join-request-resolved',
        roomCode: room.code,
        requestId: summary.requestId,
        state,
      })).toBe(true)
    }
  })

  test('rejects pending resolutions, extra fields, and secret-bearing payloads', () => {
    for (const value of [
      {
        type: 'room:join-request-resolved',
        roomCode: room.code,
        requestId: summary.requestId,
        state: 'pending',
      },
      {
        type: 'room:join-request-resolved',
        roomCode: room.code,
        requestId: summary.requestId,
        state: 'approved',
        extra: true,
      },
      {
        type: 'room:join-requested',
        request: { ...summary, inviteToken },
      },
      {
        type: 'room:join-requests',
        roomCode: room.code,
        requests: [summary],
        inviteToken,
      },
      {
        type: 'room:join-requests',
        roomCode: 'not-a-room',
        requests: [],
      },
      {
        type: 'room:join-requests',
        roomCode: room.code,
        requests: [{ ...summary, roomCode: '654321' }],
      },
      {
        type: 'room:join-requested',
        request: summary,
        requestId: summary.requestId,
      },
    ]) {
      expect(isRoomAccessServerMessage(value)).toBe(false)
    }
  })
})
