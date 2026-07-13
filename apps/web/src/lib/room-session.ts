import { getTabStorageKey } from './tab-session'

const ROOM_SESSION_KEY = 'p2p.roomSession:v2'
const LEGACY_ROOM_SESSION_KEY = 'p2p.roomSession'
const ROOM_SESSION_KEYS = ['roomCode', 'role', 'expiresAt'] as const

export type RoomSession = {
  roomCode: string
  role: 'receiver'
  expiresAt: number
}

const isRoomSession = (value: unknown): value is RoomSession => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false

  const keys = Object.keys(value)
  if (
    keys.length !== ROOM_SESSION_KEYS.length
    || !keys.every(key => ROOM_SESSION_KEYS.includes(key as typeof ROOM_SESSION_KEYS[number]))
  ) {
    return false
  }

  const session = value as RoomSession
  return Boolean(
    typeof session.roomCode === 'string'
    && /^[0-9]{6}$/u.test(session.roomCode)
    && session.role === 'receiver'
    && Number.isSafeInteger(session.expiresAt)
    && session.expiresAt > 0,
  )
}

const removeLegacyRoomSession = () => {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(LEGACY_ROOM_SESSION_KEY)
    }
  } catch {
    // Legacy cleanup is best-effort when browser storage is unavailable.
  }
}

const getRoomStorage = () => {
  if (typeof window === 'undefined') return undefined

  return window.sessionStorage
}

export const saveRoomSession = (session: RoomSession) => {
  removeLegacyRoomSession()

  try {
    const persistedSession: RoomSession = {
      roomCode: session.roomCode,
      role: session.role,
      expiresAt: session.expiresAt,
    }

    getRoomStorage()?.setItem(
      getTabStorageKey(ROOM_SESSION_KEY),
      JSON.stringify(persistedSession),
    )
  } catch {
    // Recovery is non-critical when browser storage is full or unavailable.
  }
}

export const loadRoomSession = (): RoomSession | undefined => {
  removeLegacyRoomSession()

  try {
    const storage = getRoomStorage()
    const key = getTabStorageKey(ROOM_SESSION_KEY)
    const raw = storage?.getItem(key)
    if (!raw) return undefined

    const parsed = JSON.parse(raw) as unknown
    if (isRoomSession(parsed)) return parsed

    storage?.removeItem(key)
    return undefined
  } catch {
    return undefined
  }
}

export const clearRoomSession = () => {
  removeLegacyRoomSession()

  try {
    getRoomStorage()?.removeItem(getTabStorageKey(ROOM_SESSION_KEY))
  } catch {
    // Recovery cleanup is best-effort when browser storage is unavailable.
  }
}
