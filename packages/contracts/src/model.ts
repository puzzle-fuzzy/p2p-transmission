export type PublicVisitor = {
  id: string
  avatarSeed: string
  displayName: string
  createdAt: number
  lastSeenAt: number
}

export type VisitorSession = {
  visitor: PublicVisitor
  token: string
}

export type ParticipantRole = 'sender' | 'receiver'

export type ParticipantStatus = 'online' | 'connecting' | 'transferring' | 'left'

export type PublicParticipant = {
  visitor: PublicVisitor
  role: ParticipantRole
  joinedAt: number
  status: ParticipantStatus
}

export type PublicRoom = {
  code: string
  senderId: string | null
  receivers: string[]
  participants: PublicParticipant[]
  createdAt: number
  expiresAt: number
}

export type ApiError = {
  code: string
  message: string
}

export type ApiErrorCode =
  | 'VISITOR_NOT_FOUND'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_SENDER_EXISTS'
  | 'SIGNAL_NOT_ALLOWED'
  | 'SIGNAL_TARGET_NOT_IN_ROOM'
  | 'ROOM_MEMBERSHIP_REQUIRED'
  | 'TURN_NOT_CONFIGURED'
  | 'RATE_LIMITED'
  | 'CAPACITY_EXCEEDED'
  | 'ROOM_EXPIRED'
  | 'ORIGIN_NOT_ALLOWED'
