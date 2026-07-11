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
