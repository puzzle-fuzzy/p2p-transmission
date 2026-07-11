import type { PublicRoom } from './model'

export type RoomIceMode = 'off' | 'api'

export type RtcIceServerDto = {
  urls: string[]
  username?: string
  credential?: string
  credentialType?: 'password'
}

export type RtcConfigurationDto = {
  iceServers: RtcIceServerDto[]
}

export type RoomBootstrapRequest = {
  iceMode: RoomIceMode
}

export type RoomSessionBootstrap = {
  room: PublicRoom
  rtcConfiguration?: RtcConfigurationDto
  credentialExpiresAt?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
) => Object.keys(value).every(key => allowed.includes(key))

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
) => Object.keys(value).length === expected.length
  && expected.every(key => Object.hasOwn(value, key))

const isEpochMilliseconds = (value: unknown): value is number =>
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value > 0

const isIceUrl = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= 2_048
  && /^(?:stun|turn|turns):[^\s]+$/u.test(value)

export const isRoomIceMode = (value: unknown): value is RoomIceMode =>
  value === 'off' || value === 'api'

export const isRtcIceServerDto = (value: unknown): value is RtcIceServerDto => {
  if (!isRecord(value)) return false
  if (!hasOnlyKeys(value, ['urls', 'username', 'credential', 'credentialType'])) {
    return false
  }
  if (!Array.isArray(value.urls) || value.urls.length < 1 || value.urls.length > 8) {
    return false
  }
  if (!value.urls.every(isIceUrl)) return false

  const hasUsername = Object.hasOwn(value, 'username')
  const hasCredential = Object.hasOwn(value, 'credential')
  const hasCredentialType = Object.hasOwn(value, 'credentialType')
  if (hasUsername !== hasCredential) return false
  if (
    hasUsername
    && (typeof value.username !== 'string' || value.username.length < 1 || value.username.length > 512)
  ) {
    return false
  }
  if (
    hasCredential
    && (typeof value.credential !== 'string' || value.credential.length < 1 || value.credential.length > 512)
  ) {
    return false
  }
  if (hasCredentialType && value.credentialType !== 'password') return false
  if (hasCredentialType && !hasCredential) return false

  const needsCredential = value.urls.some(url => url.startsWith('turn:') || url.startsWith('turns:'))
  return !needsCredential || (hasUsername && hasCredential)
}

export const isRtcConfigurationDto = (
  value: unknown,
): value is RtcConfigurationDto => {
  if (!isRecord(value) || !hasExactKeys(value, ['iceServers'])) return false
  return Array.isArray(value.iceServers)
    && value.iceServers.length > 0
    && value.iceServers.length <= 16
    && value.iceServers.every(isRtcIceServerDto)
}

export const isRoomBootstrapRequest = (
  value: unknown,
): value is RoomBootstrapRequest =>
  isRecord(value)
  && hasExactKeys(value, ['iceMode'])
  && isRoomIceMode(value.iceMode)

const isPublicVisitor = (value: unknown) => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'id',
    'avatarSeed',
    'displayName',
    'createdAt',
    'lastSeenAt',
  ])) {
    return false
  }

  return typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.avatarSeed === 'string'
    && value.avatarSeed.length > 0
    && typeof value.displayName === 'string'
    && value.displayName.length > 0
    && isEpochMilliseconds(value.createdAt)
    && isEpochMilliseconds(value.lastSeenAt)
}

const isPublicParticipant = (value: unknown) => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'visitor',
    'role',
    'joinedAt',
    'status',
  ])) {
    return false
  }

  return isPublicVisitor(value.visitor)
    && (value.role === 'sender' || value.role === 'receiver')
    && isEpochMilliseconds(value.joinedAt)
    && (
      value.status === 'online'
      || value.status === 'connecting'
      || value.status === 'transferring'
      || value.status === 'left'
    )
}

export const isPublicRoom = (value: unknown): value is PublicRoom => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'code',
    'senderId',
    'receivers',
    'participants',
    'createdAt',
    'expiresAt',
  ])) {
    return false
  }

  return typeof value.code === 'string'
    && /^\d{6}$/u.test(value.code)
    && (value.senderId === null || typeof value.senderId === 'string')
    && Array.isArray(value.receivers)
    && value.receivers.every(receiver => typeof receiver === 'string')
    && Array.isArray(value.participants)
    && value.participants.every(isPublicParticipant)
    && isEpochMilliseconds(value.createdAt)
    && isEpochMilliseconds(value.expiresAt)
    && value.expiresAt > value.createdAt
}

export const isRoomSessionBootstrap = (
  value: unknown,
): value is RoomSessionBootstrap => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'room',
    'rtcConfiguration',
    'credentialExpiresAt',
  ])) {
    return false
  }
  if (!Object.hasOwn(value, 'room') || !isPublicRoom(value.room)) return false

  const hasConfiguration = Object.hasOwn(value, 'rtcConfiguration')
  const hasExpiry = Object.hasOwn(value, 'credentialExpiresAt')
  if (hasConfiguration !== hasExpiry) return false
  if (!hasConfiguration) return true

  return isRtcConfigurationDto(value.rtcConfiguration)
    && isEpochMilliseconds(value.credentialExpiresAt)
    && value.credentialExpiresAt > value.room.expiresAt
}
