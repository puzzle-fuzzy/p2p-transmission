import type { VisitorSession } from '../shared/contracts'

const VISITOR_SESSION_KEY = 'p2p.visitorSession'
const VISITOR_TAB_NAME_PREFIX = 'p2p-transmission:'

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const getDefaultStorage = (): StorageLike | undefined => {
  if (typeof window === 'undefined') return undefined

  return window.sessionStorage
}

const createBrowserId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const getDefaultSessionKey = () => {
  if (typeof window === 'undefined') return VISITOR_SESSION_KEY

  if (!window.name.startsWith(VISITOR_TAB_NAME_PREFIX)) {
    window.name = `${VISITOR_TAB_NAME_PREFIX}${createBrowserId()}`
  }

  return `${VISITOR_SESSION_KEY}:${window.name}`
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
  resolvedStorage?.setItem(key, JSON.stringify(session))
}

export const clearVisitorSession = (
  storage?: StorageLike,
) => {
  const resolvedStorage = storage ?? getDefaultStorage()
  const key = storage ? VISITOR_SESSION_KEY : getDefaultSessionKey()
  resolvedStorage?.removeItem(key)
}
