import { describe, expect, test } from 'vitest'
import type { RoomSessionBootstrap } from '@p2p/contracts'
import {
  parseClientIceMode,
  parseIceServerUrls,
  resolveBootstrapRtcConfiguration,
} from './config'

const room = {
  code: '123456',
  senderId: 'sender',
  receivers: [],
  participants: [],
  createdAt: 1,
  expiresAt: 1_800_001,
}

describe('runtime ICE config', () => {
  test('uses STUN-only off mode and all policy by default', () => {
    expect(parseClientIceMode({})).toEqual({
      mode: 'off',
      configuration: {
        iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
        iceTransportPolicy: 'all',
      },
    })
  })

  test('normalizes, validates, and deduplicates STUN URLs', () => {
    expect(parseIceServerUrls(
      ' stun:one.example ,stun:two.example, stun:one.example ',
      'stun',
    )).toEqual(['stun:one.example', 'stun:two.example'])
    expect(() => parseIceServerUrls('https://bad.example', 'stun')).toThrow()
  })

  test('requires complete static TURN credentials', () => {
    const parsed = parseClientIceMode({
      VITE_TURN_MODE: 'static',
      VITE_STUN_URLS: 'stun:stun.example.com:3478',
      VITE_TURN_URLS: 'turn:turn.example.com:3478,turns:turn.example.com:5349',
      VITE_TURN_USERNAME: 'development-user',
      VITE_TURN_CREDENTIAL: 'development-password',
      VITE_ICE_TRANSPORT_POLICY: 'relay',
    })

    expect(parsed).toEqual({
      mode: 'static',
      configuration: {
        iceServers: [
          { urls: ['stun:stun.example.com:3478'] },
          {
            urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'],
            username: 'development-user',
            credential: 'development-password',
          },
        ],
        iceTransportPolicy: 'relay',
      },
    })

    for (const environment of [
      { VITE_TURN_MODE: 'static', VITE_TURN_URLS: 'turn:turn.example.com' },
      { VITE_TURN_MODE: 'static', VITE_TURN_USERNAME: 'user' },
      { VITE_TURN_MODE: 'static', VITE_TURN_CREDENTIAL: 'credential' },
    ]) {
      expect(() => parseClientIceMode(environment)).toThrow('静态 TURN 配置不完整')
    }
  })

  test('overlays local relay policy onto API ICE servers', () => {
    const mode = parseClientIceMode({
      VITE_TURN_MODE: 'api',
      VITE_ICE_TRANSPORT_POLICY: 'relay',
    })
    const bootstrap: RoomSessionBootstrap = {
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
    }

    expect(resolveBootstrapRtcConfiguration(mode, bootstrap)).toEqual({
      iceServers: [{
        urls: ['turn:turn.example.com:3478'],
        username: 'user',
        credential: 'credential',
      }],
      iceTransportPolicy: 'relay',
    })
  })

  test('fails closed for malformed API bootstrap and invalid modes/policies', () => {
    const api = parseClientIceMode({ VITE_TURN_MODE: 'api' })
    expect(() => resolveBootstrapRtcConfiguration(api, { room })).toThrow('TURN 凭据')
    expect(() => resolveBootstrapRtcConfiguration(api, {
      room,
      rtcConfiguration: {
        iceServers: [{ urls: ['stun:stun.example.com:3478'] }],
      },
      credentialExpiresAt: room.expiresAt + 300_000,
    })).toThrow('TURN 中继')
    expect(() => parseClientIceMode({ VITE_TURN_MODE: 'unknown' })).toThrow()
    expect(() => parseClientIceMode({ VITE_ICE_TRANSPORT_POLICY: 'none' })).toThrow()
  })
})
