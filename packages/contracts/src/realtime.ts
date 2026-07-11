import type { ParticipantRole, PublicRoom, PublicVisitor } from './model'

export type SessionDescriptionDto =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }

export type IceCandidateDto = {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number | null
  usernameFragment: string | null
}

export type SignalMessageType = 'signal:offer' | 'signal:answer' | 'signal:ice'

export type SignalClientMessage =
  | {
      type: 'signal:offer'
      roomCode: string
      to: string
      peerSessionId: string
      description: Extract<SessionDescriptionDto, { type: 'offer' }>
    }
  | {
      type: 'signal:answer'
      roomCode: string
      to: string
      peerSessionId: string
      description: Extract<SessionDescriptionDto, { type: 'answer' }>
    }
  | {
      type: 'signal:ice'
      roomCode: string
      to: string
      peerSessionId: string
      candidate: IceCandidateDto | null
    }

export type ClientRealtimeMessage =
  | { type: 'room:attach'; roomCode: string; role: ParticipantRole }
  /** @deprecated Temporary migration shim; removed after the Web migration. */
  | { type: 'room:join'; roomCode: string; role: ParticipantRole }
  | { type: 'room:leave'; roomCode: string }
  | SignalClientMessage

export type SignalServerMessage =
  | {
      type: 'signal:offer'
      roomCode: string
      from: string
      peerSessionId: string
      description: Extract<SessionDescriptionDto, { type: 'offer' }>
    }
  | {
      type: 'signal:answer'
      roomCode: string
      from: string
      peerSessionId: string
      description: Extract<SessionDescriptionDto, { type: 'answer' }>
    }
  | {
      type: 'signal:ice'
      roomCode: string
      from: string
      peerSessionId: string
      candidate: IceCandidateDto | null
    }

export type ServerRealtimeMessage =
  | { type: 'visitor:ready'; visitor: PublicVisitor }
  | { type: 'room:participants'; room: PublicRoom }
  | { type: 'participant:left'; roomCode: string; visitorId: string }
  | SignalServerMessage
  | { type: 'error'; code: string; message: string }
