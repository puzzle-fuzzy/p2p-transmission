import { describe, expect, test } from 'vitest'
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

  test('clears saved visitor session', () => {
    const storage = createMemoryStorage()
    saveVisitorSession(session, storage)

    clearVisitorSession(storage)

    expect(loadVisitorSession(storage)).toBeUndefined()
  })
})
