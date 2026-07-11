import type { ClientRealtimeMessage } from './realtime'

type Assert<T extends true> = T

export type ClientRealtimeMessageExcludesLegacyJoin = Assert<
  Extract<ClientRealtimeMessage, { type: 'room:join' }> extends never
    ? true
    : false
>
