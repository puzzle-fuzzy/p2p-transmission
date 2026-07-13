import type {
  RoomIceMode,
  RoomSessionBootstrap,
  RtcIceServerDto,
} from '@p2p/contracts'

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '')
const DEFAULT_STUN_URL = 'stun:stun.l.google.com:19302'

export type ClientEnvironment = Readonly<Record<string, string | undefined>>

export type ClientIceMode =
  | { mode: 'off'; configuration: RTCConfiguration }
  | { mode: 'static'; configuration: RTCConfiguration }
  | { mode: 'api'; iceTransportPolicy: RTCIceTransportPolicy }

export const getApiBaseUrl = () =>
  trimTrailingSlash(import.meta.env.VITE_API_URL ?? 'http://localhost:3000')

export const getRealtimeUrl = (ticket: string) => {
  const baseUrl = new URL(getApiBaseUrl())
  baseUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  baseUrl.pathname = '/v1/realtime'
  baseUrl.search = new URLSearchParams({ ticket }).toString()

  return baseUrl.toString()
}

const splitList = (value?: string) => Array.from(new Set(
  value?.split(',').map(item => item.trim()).filter(Boolean) ?? [],
))

export const parseIceServerUrls = (
  value?: string,
  kind: 'stun' | 'turn' = 'stun',
) => {
  const urls = splitList(value)
  const resolved = urls.length > 0
    ? urls
    : kind === 'stun'
      ? [DEFAULT_STUN_URL]
      : []
  const pattern = kind === 'stun' ? /^stun:[^\s]+$/u : /^turns?:[^\s]+$/u
  if (resolved.some(url => url.length > 2_048 || !pattern.test(url))) {
    throw new Error(`无效的 ${kind.toUpperCase()} 地址`)
  }
  return resolved
}

const parsePolicy = (value?: string): RTCIceTransportPolicy => {
  if (value === undefined || value.trim() === '' || value === 'all') return 'all'
  if (value === 'relay') return 'relay'
  throw new Error('VITE_ICE_TRANSPORT_POLICY 只能是 all 或 relay')
}

export const parseClientIceMode = (
  environment: ClientEnvironment,
): ClientIceMode => {
  const rawMode = environment.VITE_TURN_MODE?.trim() || 'off'
  if (rawMode !== 'off' && rawMode !== 'static' && rawMode !== 'api') {
    throw new Error('VITE_TURN_MODE 只能是 off、static 或 api')
  }
  const iceTransportPolicy = parsePolicy(environment.VITE_ICE_TRANSPORT_POLICY)
  if (rawMode === 'api') return { mode: 'api', iceTransportPolicy }

  const stun = { urls: parseIceServerUrls(environment.VITE_STUN_URLS, 'stun') }
  if (rawMode === 'off') {
    return {
      mode: 'off',
      configuration: { iceServers: [stun], iceTransportPolicy },
    }
  }

  const turnUrls = parseIceServerUrls(environment.VITE_TURN_URLS, 'turn')
  const username = environment.VITE_TURN_USERNAME?.trim()
  const credential = environment.VITE_TURN_CREDENTIAL
  if (turnUrls.length === 0 || !username || !credential) {
    throw new Error('静态 TURN 配置不完整')
  }
  return {
    mode: 'static',
    configuration: {
      iceServers: [
        stun,
        {
          urls: turnUrls,
          username,
          credential,
        },
      ],
      iceTransportPolicy,
    },
  }
}

export const getClientIceMode = () => parseClientIceMode(import.meta.env)

const toRtcIceServer = (server: RtcIceServerDto): RTCIceServer => ({
  urls: [...server.urls],
  ...(server.username ? { username: server.username } : {}),
  ...(server.credential ? { credential: server.credential } : {}),
})

export const resolveBootstrapRtcConfiguration = (
  mode: ClientIceMode,
  bootstrap: RoomSessionBootstrap,
): RTCConfiguration => {
  if (mode.mode !== 'api') return mode.configuration
  if (!bootstrap.rtcConfiguration || !bootstrap.credentialExpiresAt) {
    throw new Error('服务端没有返回 TURN 凭据，请检查中继配置')
  }
  const hasCredentialedTurn = bootstrap.rtcConfiguration.iceServers.some(server => (
    server.urls.some(url => url.startsWith('turn:') || url.startsWith('turns:'))
    && Boolean(server.username)
    && Boolean(server.credential)
  ))
  if (!hasCredentialedTurn) {
    throw new Error('服务端没有返回可用的 TURN 中继，请检查中继配置')
  }
  return {
    iceServers: bootstrap.rtcConfiguration.iceServers.map(toRtcIceServer),
    iceTransportPolicy: mode.iceTransportPolicy,
  }
}

export const roomIceMode = (mode: ClientIceMode): RoomIceMode =>
  mode.mode === 'api' ? 'api' : 'off'

export const getRtcConfiguration = (): RTCConfiguration => {
  const mode = getClientIceMode()
  if (mode.mode === 'api') {
    throw new Error('API TURN 模式必须先创建或加入房间')
  }
  return mode.configuration
}
