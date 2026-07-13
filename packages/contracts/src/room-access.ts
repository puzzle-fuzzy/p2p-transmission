import {
  isRoomIceMode,
  isRoomSessionBootstrap,
  type RoomIceMode,
  type RoomSessionBootstrap,
} from './ice'
import type { PublicVisitor } from './model'

export const MAX_ROOM_JOIN_REQUEST_ID_LENGTH = 96
export const MAX_ROOM_INVITE_TOKEN_INPUT_LENGTH = 128

export type RoomInviteCapability = {
  token: string
  expiresAt: number
}

export type RoomOwnerBootstrap = RoomSessionBootstrap & {
  invite: RoomInviteCapability
}

export type RoomJoinRequestState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'finalized'

export type RoomJoinRequestReceipt = {
  requestId: string
  state: RoomJoinRequestState
  expiresAt: number
}

export type RoomJoinRequestSummary = {
  requestId: string
  roomCode: string
  visitor: PublicVisitor
  createdAt: number
  expiresAt: number
}

export type ReceiverAdmission =
  | { kind: 'invite'; inviteToken: string }
  | { kind: 'approval'; requestId: string }
  | { kind: 'recovery' }

export type ReceiverJoinBody =
  | { iceMode: RoomIceMode; admission: { kind: 'invite'; inviteToken: string } }
  | { iceMode: RoomIceMode; admission: { kind: 'recovery' } }

export type RoomAccessServerMessage =
  | {
      type: 'room:join-requests'
      roomCode: string
      requests: RoomJoinRequestSummary[]
    }
  | {
      type: 'room:join-requested'
      request: RoomJoinRequestSummary
    }
  | {
      type: 'room:join-request-resolved'
      roomCode: string
      requestId: string
      state: Exclude<RoomJoinRequestState, 'pending'>
    }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
) => Object.keys(value).length === expected.length
  && expected.every(key => Object.prototype.hasOwnProperty.call(value, key))

const isEpochMilliseconds = (value: unknown): value is number =>
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value > 0

const isRoomCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{6}$/u.test(value)

const isRequestId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= MAX_ROOM_JOIN_REQUEST_ID_LENGTH

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const isPublicVisitor = (value: unknown): value is PublicVisitor => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'id',
    'avatarSeed',
    'displayName',
    'createdAt',
    'lastSeenAt',
  ])) {
    return false
  }

  return isNonEmptyString(value.id)
    && isNonEmptyString(value.avatarSeed)
    && isNonEmptyString(value.displayName)
    && isEpochMilliseconds(value.createdAt)
    && isEpochMilliseconds(value.lastSeenAt)
}

export const isRoomInviteToken = (value: unknown): value is string =>
  typeof value === 'string' && /^inv_[A-Za-z0-9_-]{43}$/u.test(value)

export const isRoomInviteCapability = (
  value: unknown,
): value is RoomInviteCapability =>
  isRecord(value)
  && hasExactKeys(value, ['token', 'expiresAt'])
  && isRoomInviteToken(value.token)
  && isEpochMilliseconds(value.expiresAt)

export const isRoomOwnerBootstrap = (
  value: unknown,
): value is RoomOwnerBootstrap => {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'invite')) {
    return false
  }

  const { invite, ...session } = value

  return isRoomInviteCapability(invite)
    && isRoomSessionBootstrap(session)
    && invite.expiresAt === session.room.expiresAt
}

export const isRoomJoinRequestState = (
  value: unknown,
): value is RoomJoinRequestState =>
  value === 'pending'
  || value === 'approved'
  || value === 'rejected'
  || value === 'cancelled'
  || value === 'expired'
  || value === 'finalized'

export const isRoomJoinRequestReceipt = (
  value: unknown,
): value is RoomJoinRequestReceipt =>
  isRecord(value)
  && hasExactKeys(value, ['requestId', 'state', 'expiresAt'])
  && isRequestId(value.requestId)
  && isRoomJoinRequestState(value.state)
  && isEpochMilliseconds(value.expiresAt)

export const isRoomJoinRequestSummary = (
  value: unknown,
): value is RoomJoinRequestSummary =>
  isRecord(value)
  && hasExactKeys(value, [
    'requestId',
    'roomCode',
    'visitor',
    'createdAt',
    'expiresAt',
  ])
  && isRequestId(value.requestId)
  && isRoomCode(value.roomCode)
  && isPublicVisitor(value.visitor)
  && isEpochMilliseconds(value.createdAt)
  && isEpochMilliseconds(value.expiresAt)
  && value.expiresAt > value.createdAt

export const isReceiverJoinBody = (
  value: unknown,
): value is ReceiverJoinBody => {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['iceMode', 'admission'])
    || !isRoomIceMode(value.iceMode)
    || !isRecord(value.admission)
  ) {
    return false
  }

  if (value.admission.kind === 'invite') {
    return hasExactKeys(value.admission, ['kind', 'inviteToken'])
      && typeof value.admission.inviteToken === 'string'
      && value.admission.inviteToken.length > 0
      && value.admission.inviteToken.length <= MAX_ROOM_INVITE_TOKEN_INPUT_LENGTH
  }

  return value.admission.kind === 'recovery'
    && hasExactKeys(value.admission, ['kind'])
}

const isResolvedRoomJoinRequestState = (
  value: unknown,
): value is Exclude<RoomJoinRequestState, 'pending'> =>
  isRoomJoinRequestState(value) && value !== 'pending'

export const isRoomAccessServerMessage = (
  value: unknown,
): value is RoomAccessServerMessage => {
  if (!isRecord(value)) return false

  if (value.type === 'room:join-requests') {
    if (
      !hasExactKeys(value, ['type', 'roomCode', 'requests'])
      || !isRoomCode(value.roomCode)
      || !Array.isArray(value.requests)
    ) {
      return false
    }

    const roomCode = value.roomCode

    return value.requests.every(request =>
      isRoomJoinRequestSummary(request) && request.roomCode === roomCode,
    )
  }

  if (value.type === 'room:join-requested') {
    return hasExactKeys(value, ['type', 'request'])
      && isRoomJoinRequestSummary(value.request)
  }

  if (value.type === 'room:join-request-resolved') {
    return hasExactKeys(value, [
      'type',
      'roomCode',
      'requestId',
      'state',
    ])
      && isRoomCode(value.roomCode)
      && isRequestId(value.requestId)
      && isResolvedRoomJoinRequestState(value.state)
  }

  return false
}
