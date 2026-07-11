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

export type TransferItem = {
  id: string
  kind: 'text' | 'file'
  name?: string
  size?: number
  mimeType?: string
}

export type SignalMessageType = 'signal:offer' | 'signal:answer' | 'signal:ice'

export type ClientRealtimeMessage =
  | { type: 'room:join'; roomCode: string; role: ParticipantRole }
  | { type: 'room:leave'; roomCode: string }
  | { type: 'signal:offer'; roomCode: string; to: string; sdp: unknown }
  | { type: 'signal:answer'; roomCode: string; to: string; sdp: unknown }
  | { type: 'signal:ice'; roomCode: string; to: string; candidate: unknown }
  | { type: 'transfer:prepare'; roomCode: string; items: TransferItem[] }
  | { type: 'transfer:state'; roomCode: string; state: 'ready' | 'transferring' | 'done' | 'error' }

export type ServerRealtimeMessage =
  | { type: 'visitor:ready'; visitor: PublicVisitor }
  | { type: 'room:participants'; room: PublicRoom }
  | { type: 'participant:left'; roomCode: string; visitorId: string }
  | { type: 'signal:offer'; roomCode: string; from: string; sdp: unknown }
  | { type: 'signal:answer'; roomCode: string; from: string; sdp: unknown }
  | { type: 'signal:ice'; roomCode: string; from: string; candidate: unknown }
  | { type: 'transfer:prepare'; roomCode: string; from: string; items: TransferItem[] }
  | { type: 'transfer:state'; roomCode: string; from: string; state: 'ready' | 'transferring' | 'done' | 'error' }
  | { type: 'error'; code: string; message: string }
