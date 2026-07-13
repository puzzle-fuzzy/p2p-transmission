import type { PublicRoom } from './model'
import type {
  ReceiverJoinBody,
  RoomAccessServerMessage,
  RoomJoinRequestSummary,
} from './room-access'
import type { ClientRealtimeMessage } from './realtime'

type Assert<T extends true> = T
type UnionKeys<T> = T extends unknown ? keyof T : never
type InvitationField = 'invite' | 'inviteToken'
type ExcludesInvitationFields<T> = Extract<
  UnionKeys<T>,
  InvitationField
> extends never ? true : false

export type ClientRealtimeMessageExcludesLegacyJoin = Assert<
  Extract<ClientRealtimeMessage, { type: 'room:join' }> extends never
    ? true
    : false
>

export type PublicRoomExcludesInvitationFields = Assert<
  ExcludesInvitationFields<PublicRoom>
>

export type RoomJoinRequestSummaryExcludesInvitationFields = Assert<
  ExcludesInvitationFields<RoomJoinRequestSummary>
>

export type RoomAccessServerMessageExcludesInvitationFields = Assert<
  ExcludesInvitationFields<RoomAccessServerMessage>
>

export type ReceiverJoinBodyExcludesApproval = Assert<
  Extract<
    ReceiverJoinBody,
    { admission: { kind: 'approval' } }
  > extends never ? true : false
>
