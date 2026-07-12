// @vitest-environment jsdom

import { beforeEach, describe, expect, test } from 'vitest'
import {
  clearVisitorSession,
  loadVisitorSession,
  saveVisitorSession,
  type StorageLike,
} from './visitor-session'
import type { VisitorSession } from '../shared/contracts'

const createMemoryStorage = (): StorageLike => {
  const values = new Map<string, string>()

  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: key => {
      values.delete(key)
    },
  }
}

const session: VisitorSession = {
  token: 'tok_1',
  visitor: {
    id: 'vis_1',
    avatarSeed: 'seed_1',
    displayName: '访客 0001',
    createdAt: 1,
    lastSeenAt: 2,
  },
}

describe('visitor-session', () => {
  beforeEach(() => {
    window.name = ''
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  test('saves and loads a visitor session', () => {
    const storage = createMemoryStorage()

    saveVisitorSession(session, storage)

    expect(loadVisitorSession(storage)).toEqual(session)
  })

  test('returns undefined for missing or malformed session data', () => {
    const storage = createMemoryStorage()

    expect(loadVisitorSession(storage)).toBeUndefined()
    storage.setItem('p2p.visitorSession', '{bad json')
    expect(loadVisitorSession(storage)).toBeUndefined()
  })

  test('uses tab-scoped storage by default so same-browser receivers do not share identity', () => {
    window.localStorage.setItem('p2p.visitorSession', JSON.stringify({
      ...session,
      token: 'tok_local',
    }))

    expect(loadVisitorSession()).toBeUndefined()

    saveVisitorSession(session)

    const firstTabName = window.name
    const firstKey = `p2p.visitorSession:${firstTabName}`
    expect(window.localStorage.getItem('p2p.visitorSession')).toContain('tok_local')
    expect(window.sessionStorage.getItem(firstKey)).toContain('tok_1')
    expect(loadVisitorSession()).toEqual(session)

    window.name = ''
    expect(loadVisitorSession()).toBeUndefined()
    expect(window.name).not.toBe(firstTabName)
  })

  test('clears saved visitor session', () => {
    const storage = createMemoryStorage()
    saveVisitorSession(session, storage)

    clearVisitorSession(storage)

    expect(loadVisitorSession(storage)).toBeUndefined()
  })
})
