import type { VisitorSession } from '../shared/contracts'
import { getTabStorageKey } from './tab-session'

const VISITOR_SESSION_KEY = 'p2p.visitorSession'

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const getDefaultStorage = (): StorageLike | undefined => {
  if (typeof window === 'undefined') return undefined

  return window.sessionStorage
}

const getDefaultSessionKey = () => {
  return getTabStorageKey(VISITOR_SESSION_KEY)
}

const isVisitorSession = (value: unknown): value is VisitorSession => {
  if (!value || typeof value !== 'object') return false

  const session = value as VisitorSession

  return Boolean(
    session.token
    && session.visitor
    && session.visitor.id
    && session.visitor.avatarSeed
    && session.visitor.displayName,
  )
}

export const loadVisitorSession = (
  storage?: StorageLike,
): VisitorSession | undefined => {
  const resolvedStorage = storage ?? getDefaultStorage()
  const key = storage ? VISITOR_SESSION_KEY : getDefaultSessionKey()
  const raw = resolvedStorage?.getItem(key)

  if (!raw) return undefined

  try {
    const parsed = JSON.parse(raw) as unknown

    return isVisitorSession(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export const saveVisitorSession = (
  session: VisitorSession,
  storage?: StorageLike,
) => {
  const resolvedStorage = storage ?? getDefaultStorage()
  const key = storage ? VISITOR_SESSION_KEY : getDefaultSessionKey()
  const persistedSession: VisitorSession = {
    token: session.token,
    visitor: {
      id: session.visitor.id,
      avatarSeed: session.visitor.avatarSeed,
      displayName: session.visitor.displayName,
      createdAt: session.visitor.createdAt,
      lastSeenAt: session.visitor.lastSeenAt,
    },
  }

  resolvedStorage?.setItem(key, JSON.stringify(persistedSession))
}

export const clearVisitorSession = (
  storage?: StorageLike,
) => {
  const resolvedStorage = storage ?? getDefaultStorage()
  const key = storage ? VISITOR_SESSION_KEY : getDefaultSessionKey()
  resolvedStorage?.removeItem(key)
}
