import { describe, expect, test } from 'vitest'
import { parseRoomCodeFromSearch } from './room-invite'

describe('parseRoomCodeFromSearch', () => {
  test('returns one exact six-digit room code', () => {
    expect(parseRoomCodeFromSearch('?room=123456')).toBe('123456')
    expect(parseRoomCodeFromSearch('?source=share&room=012345')).toBe('012345')
    expect(parseRoomCodeFromSearch('?room=%31%32%33%34%35%36')).toBe('123456')
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
    expect(parseRoomCodeFromSearch(search)).toBeUndefined()
  })
})
