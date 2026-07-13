import { isRoomInviteToken } from '@p2p/contracts'

const ROOM_CODE_PATTERN = /^[0-9]{6}$/u
const ROOM_INVITE_FRAGMENT_KEYS = new Set(['room', 'invite'])

export type JoinIntent =
  | { kind: 'invite'; roomCode: string; inviteToken: string }
  | { kind: 'recovery'; roomCode: string }
  | { kind: 'manualRequest'; roomCode: string }

export type RoomInviteFragmentResult =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | {
    kind: 'invite'
    intent: Extract<JoinIntent, { kind: 'invite' }>
  }

const absentResult: RoomInviteFragmentResult = Object.freeze({ kind: 'absent' })
const invalidResult: RoomInviteFragmentResult = Object.freeze({ kind: 'invalid' })

const hasExactInviteKeys = (params: URLSearchParams) => {
  const keys = [...params.keys()]

  return keys.length === ROOM_INVITE_FRAGMENT_KEYS.size
    && keys.every(key => ROOM_INVITE_FRAGMENT_KEYS.has(key))
    && params.getAll('room').length === 1
    && params.getAll('invite').length === 1
}

export const parseRoomInviteFragment = (
  hash: string,
): RoomInviteFragmentResult => {
  if (hash === '') return absentResult
  if (!hash.startsWith('#') || hash.length === 1) return invalidResult

  const params = new URLSearchParams(hash.slice(1))
  if (!hasExactInviteKeys(params)) return invalidResult

  const roomCode = params.get('room')
  const inviteToken = params.get('invite')
  if (
    !roomCode
    || !ROOM_CODE_PATTERN.test(roomCode)
    || !inviteToken
    || !isRoomInviteToken(inviteToken)
  ) {
    return invalidResult
  }

  const intent = Object.freeze({
    kind: 'invite' as const,
    roomCode,
    inviteToken,
  })

  return Object.freeze({ kind: 'invite', intent })
}

export const parseLegacyRoomCode = (search: string): string | undefined => {
  const values = new URLSearchParams(search).getAll('room')
  if (values.length !== 1) return undefined

  const [value] = values
  return value && ROOM_CODE_PATTERN.test(value) ? value : undefined
}

export const buildRoomInviteUrl = (
  currentHref: string,
  roomCode: string,
  inviteToken: string,
) => {
  if (!ROOM_CODE_PATTERN.test(roomCode) || !isRoomInviteToken(inviteToken)) {
    throw new TypeError('Invalid room invitation')
  }

  const url = new URL(currentHref)
  const fragment = new URLSearchParams({ room: roomCode, invite: inviteToken })
  url.hash = fragment.toString()

  return url.toString()
}
