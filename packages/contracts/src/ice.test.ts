import { describe, expect, test } from 'bun:test'
import {
  isRoomBootstrapRequest,
  isRoomSessionBootstrap,
  isRtcConfigurationDto,
  isRtcIceServerDto,
  type RoomSessionBootstrap,
} from './ice'

const room = {
  code: '123456',
  senderId: 'vis_sender',
  receivers: ['vis_receiver'],
  participants: [{
    visitor: {
      id: 'vis_sender',
      avatarSeed: 'sender',
      displayName: '发送者',
      createdAt: 1,
      lastSeenAt: 1,
    },
    role: 'sender' as const,
    joinedAt: 1,
    status: 'connecting' as const,
  }],
  createdAt: 1,
  expiresAt: 1_800_001,
}

describe('ICE bootstrap contracts', () => {
  test('accepts STUN and credentialed TURN server DTOs', () => {
    expect(isRtcIceServerDto({ urls: ['stun:stun.example.com:3478'] })).toBe(true)
    expect(isRtcIceServerDto({
      urls: [
        'turn:turn.example.com:3478?transport=udp',
        'turns:turn.example.com:5349?transport=tcp',
      ],
      username: '1700000000:vis_1',
      credential: 'credential',
      credentialType: 'password',
    })).toBe(true)
  })

  test('rejects invalid schemes, empty URL arrays, and partial credentials', () => {
    for (const value of [
      { urls: [] },
      { urls: ['https://turn.example.com'] },
      { urls: ['turn:turn.example.com'], username: 'user' },
      { urls: ['turn:turn.example.com'], credential: 'secret' },
      { urls: ['turn:turn.example.com'], username: 'user', credential: '' },
      { urls: ['stun:stun.example.com'], extra: true },
    ]) {
      expect(isRtcIceServerDto(value)).toBe(false)
    }
  })

  test('keeps iceTransportPolicy out of the server DTO', () => {
    expect(isRtcConfigurationDto({
      iceServers: [{ urls: ['stun:stun.example.com:3478'] }],
    })).toBe(true)
    expect(isRtcConfigurationDto({
      iceServers: [{ urls: ['stun:stun.example.com:3478'] }],
      iceTransportPolicy: 'relay',
    })).toBe(false)
  })

  test('validates exact off/api request modes', () => {
    expect(isRoomBootstrapRequest({ iceMode: 'off' })).toBe(true)
    expect(isRoomBootstrapRequest({ iceMode: 'api' })).toBe(true)
    expect(isRoomBootstrapRequest({})).toBe(false)
    expect(isRoomBootstrapRequest({ iceMode: 'static' })).toBe(false)
    expect(isRoomBootstrapRequest({ iceMode: 'off', extra: true })).toBe(false)
  })

  test('requires RTC configuration and epoch-millisecond expiry together', () => {
    const rtcConfiguration = {
      iceServers: [{
        urls: ['turn:turn.example.com:3478'],
        username: '1700000000:vis_1',
        credential: 'credential',
        credentialType: 'password' as const,
      }],
    }
    const api: RoomSessionBootstrap = {
      room,
      rtcConfiguration,
      credentialExpiresAt: room.expiresAt + 300_000,
    }

    expect(isRoomSessionBootstrap({ room })).toBe(true)
    expect(isRoomSessionBootstrap(api)).toBe(true)
    expect(isRoomSessionBootstrap({ room, rtcConfiguration })).toBe(false)
    expect(isRoomSessionBootstrap({ room, credentialExpiresAt: 2_100_001 })).toBe(false)
    expect(isRoomSessionBootstrap({ ...api, credentialExpiresAt: 2_100.001 })).toBe(false)
    expect(isRoomSessionBootstrap({ ...api, credentialExpiresAt: room.expiresAt })).toBe(false)
  })

  test('rejects malformed rooms and unknown bootstrap keys', () => {
    expect(isRoomSessionBootstrap({ room: { ...room, code: '123' } })).toBe(false)
    expect(isRoomSessionBootstrap({ room, secret: 'nope' })).toBe(false)
    expect(isRoomSessionBootstrap({
      room,
      invite: { token: `inv_${'A'.repeat(43)}`, expiresAt: room.expiresAt },
    })).toBe(false)
    expect(isRoomSessionBootstrap({ room, inviteToken: `inv_${'A'.repeat(43)}` })).toBe(false)
    expect(isRoomSessionBootstrap({ room, requestId: 'request_1' })).toBe(false)
  })
})
