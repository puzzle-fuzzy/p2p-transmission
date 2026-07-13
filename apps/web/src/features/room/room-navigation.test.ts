// @vitest-environment jsdom

import { beforeEach, describe, expect, test } from 'vitest'
import { consumeRoomNavigation } from './room-navigation'

const inviteToken = `inv_${'z'.repeat(43)}`

describe('consumeRoomNavigation', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/')
  })

  test('consumes a valid fragment once and preserves an immutable entry snapshot', () => {
    const historyState = { source: 'test' }
    window.history.replaceState(
      historyState,
      '',
      `/nested/app/?campaign=summer#room=123456&invite=${inviteToken}`,
    )

    const snapshot = consumeRoomNavigation(window)

    expect(snapshot).toEqual({
      fragment: {
        kind: 'invite',
        intent: {
          kind: 'invite',
          roomCode: '123456',
          inviteToken,
        },
      },
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(window.location.pathname).toBe('/nested/app/')
    expect(window.location.search).toBe('?campaign=summer')
    expect(window.location.hash).toBe('')
    expect(window.history.state).toEqual(historyState)

    window.history.replaceState({ replaced: true }, '', '/other')
    expect(snapshot.fragment).toEqual({
      kind: 'invite',
      intent: {
        kind: 'invite',
        roomCode: '123456',
        inviteToken,
      },
    })
  })

  test('clears an invalid non-empty fragment and captures a legacy manual code', () => {
    window.history.replaceState(
      { keep: true },
      '',
      '/nested/app/?room=654321#room=123456',
    )

    expect(consumeRoomNavigation(window)).toEqual({
      fragment: { kind: 'invalid' },
      legacyRoomCode: '654321',
    })
    expect(window.location.pathname).toBe('/nested/app/')
    expect(window.location.search).toBe('?room=654321')
    expect(window.location.hash).toBe('')
    expect(window.history.state).toEqual({ keep: true })
  })

  test('does not mutate history when the fragment is absent', () => {
    window.history.replaceState({ keep: true }, '', '/nested/?room=123456')

    expect(consumeRoomNavigation(window)).toEqual({
      fragment: { kind: 'absent' },
      legacyRoomCode: '123456',
    })
    expect(window.location.href).toBe('http://localhost:3000/nested/?room=123456')
    expect(window.history.state).toEqual({ keep: true })
  })
})
