const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '')
const DEFAULT_STUN_URL = 'stun:stun.l.google.com:19302'

export const getApiBaseUrl = () =>
  trimTrailingSlash(import.meta.env.VITE_API_URL ?? 'http://localhost:3000')

export const getRealtimeUrl = (token: string) => {
  const baseUrl = new URL(getApiBaseUrl())
  baseUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  baseUrl.pathname = '/v1/realtime'
  baseUrl.search = new URLSearchParams({ token }).toString()

  return baseUrl.toString()
}

export const parseIceServerUrls = (value?: string) => {
  const urls = value
    ?.split(',')
    .map(url => url.trim())
    .filter(Boolean)

  return urls?.length ? urls : [DEFAULT_STUN_URL]
}

export const getRtcConfiguration = (): RTCConfiguration => ({
  iceServers: [{
    urls: parseIceServerUrls(import.meta.env.VITE_STUN_URLS),
  }],
})
