import type { ParticipantRole } from '../shared/contracts'

const ROOM_SESSION_KEY = 'p2p.roomSession'

export type RoomSession = {
  roomCode: string
  role: Exclude<ParticipantRole, 'receiver'> | 'receiver'
  expiresAt: number
}

const isRoomSession = (value: unknown): value is RoomSession => {
  if (!value || typeof value !== 'object') return false
  const session = value as RoomSession
  return Boolean(
    session.roomCode && session.role && Number.isSafeInteger(session.expiresAt),
  )
}

export const saveRoomSession = (session: RoomSession) => {
  try {
    localStorage.setItem(ROOM_SESSION_KEY, JSON.stringify(session))
  } catch {
    // Storage full or unavailable — non-critical
  }
}

export const loadRoomSession = (): RoomSession | undefined => {
  try {
    const raw = localStorage.getItem(ROOM_SESSION_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as unknown
    return isRoomSession(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export const clearRoomSession = () => {
  try {
    localStorage.removeItem(ROOM_SESSION_KEY)
  } catch {
    // ignore
  }
}
