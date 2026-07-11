import type { VisitorSession } from '../shared/contracts'

const VISITOR_SESSION_KEY = 'p2p.visitorSession'

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const getDefaultStorage = (): StorageLike | undefined => {
  if (typeof window === 'undefined') return undefined

  return window.localStorage
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
  storage: StorageLike | undefined = getDefaultStorage(),
): VisitorSession | undefined => {
  const raw = storage?.getItem(VISITOR_SESSION_KEY)

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
  storage: StorageLike | undefined = getDefaultStorage(),
) => {
  storage?.setItem(VISITOR_SESSION_KEY, JSON.stringify(session))
}

export const clearVisitorSession = (
  storage: StorageLike | undefined = getDefaultStorage(),
) => {
  storage?.removeItem(VISITOR_SESSION_KEY)
}
