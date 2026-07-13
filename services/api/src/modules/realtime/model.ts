import type { PublicVisitor } from '@p2p/contracts'

export type {
  ClientRealtimeMessage,
  IceCandidateDto,
  RoomAccessServerMessage,
  ServerRealtimeMessage,
  SessionDescriptionDto,
  SignalClientMessage,
  SignalMessageType,
  SignalServerMessage,
} from '@p2p/contracts'

export type RealtimeConnectionResult =
  | { ok: true; visitor: PublicVisitor }
  | {
      ok: false
      error: {
        code: "VISITOR_NOT_FOUND" | "CAPACITY_EXCEEDED" | "ORIGIN_NOT_ALLOWED"
        message: string
      }
    }
