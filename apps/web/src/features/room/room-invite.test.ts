import { describe, expect, test } from 'vitest'
import {
  buildRoomInviteUrl,
  parseLegacyRoomCode,
  parseRoomInviteFragment,
  parseRoomCodeFromSearch,
} from './room-invite'

const inviteToken = `inv_${'A'.repeat(43)}`

describe('parseRoomInviteFragment', () => {
  test('distinguishes an absent fragment from one valid invitation', () => {
    expect(parseRoomInviteFragment('')).toEqual({ kind: 'absent' })
    expect(parseRoomInviteFragment(`#room=012345&invite=${inviteToken}`)).toEqual({
      kind: 'invite',
      intent: {
        kind: 'invite',
        roomCode: '012345',
        inviteToken,
      },
    })
  })

  test.each([
    '#',
    `#room=123456&invite=${inviteToken}&source=share`,
    `#room=123456&room=654321&invite=${inviteToken}`,
    `#room=123456&invite=${inviteToken}&invite=${inviteToken}`,
    '#room=123456&invite=',
    '#room=123456&invite=inv_%E0%A4%A',
    `#room=123456&invite=inv_${'A'.repeat(42)}`,
    `#room=123456&invite=inv_${'A'.repeat(44)}`,
    `#room=１２３４５６&invite=${inviteToken}`,
    '#room=123456',
    `#invite=${inviteToken}`,
  ])('rejects a partial, duplicate, unknown, or malformed fragment: %s', hash => {
    expect(parseRoomInviteFragment(hash)).toEqual({ kind: 'invalid' })
  })

  test('returns a deeply immutable valid result', () => {
    const result = parseRoomInviteFragment(`#room=123456&invite=${inviteToken}`)

    expect(Object.isFrozen(result)).toBe(true)
    if (result.kind !== 'invite') throw new Error('expected invite result')
    expect(Object.isFrozen(result.intent)).toBe(true)
  })
})

describe('parseLegacyRoomCode', () => {
  test('returns one exact six-digit room code as manual-only navigation data', () => {
    expect(parseLegacyRoomCode('?room=123456')).toBe('123456')
    expect(parseLegacyRoomCode('?source=share&room=012345')).toBe('012345')
    expect(parseLegacyRoomCode('?room=%31%32%33%34%35%36')).toBe('123456')
  })

  test.each([
    '',
    '?room=',
    '?room=12345',
    '?room=1234567',
    '?room=12a456',
    '?room=123456&room=654321',
    '?room=%EF%BC%91%EF%BC%92%EF%BC%93%EF%BC%94%EF%BC%95%EF%BC%96',
  ])('rejects missing, duplicate, or malformed room values from %s', search => {
    expect(parseLegacyRoomCode(search)).toBeUndefined()
  })

  test('keeps the legacy export compatible until App adopts the navigation snapshot', () => {
    expect(parseRoomCodeFromSearch('?room=123456')).toBe('123456')
  })
})

describe('buildRoomInviteUrl', () => {
  test('preserves deployment origin, path, and query while replacing the fragment', () => {
    expect(buildRoomInviteUrl(
      'https://files.example/deploy/app/?source=sender#old-fragment',
      '123456',
      inviteToken,
    )).toBe(
      `https://files.example/deploy/app/?source=sender#room=123456&invite=${inviteToken}`,
    )
  })
})
