import type { PublicVisitor } from '@p2p/contracts'

export type {
  ClientRealtimeMessage,
  IceCandidateDto,
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
        code: string
        message: string
      }
    }
