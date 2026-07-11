const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '')

export const getApiBaseUrl = () =>
  trimTrailingSlash(import.meta.env.VITE_API_URL ?? 'http://localhost:3000')

export const getRealtimeUrl = (token: string) => {
  const baseUrl = new URL(getApiBaseUrl())
  baseUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  baseUrl.pathname = '/v1/realtime'
  baseUrl.search = new URLSearchParams({ token }).toString()

  return baseUrl.toString()
}
