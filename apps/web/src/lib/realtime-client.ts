import { getRealtimeUrl } from './config'
import type { ClientRealtimeMessage, ServerRealtimeMessage } from '../shared/contracts'

export type WebSocketLike = {
  onmessage: ((event: MessageEvent<string>) => void) | null
  onopen: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send(data: string): void
  close(): void
}

export type WebSocketConstructor = new (url: string) => WebSocketLike

export type RealtimeClientOptions = {
  token: string
  WebSocketCtor?: WebSocketConstructor
  realtimeUrl?: (token: string) => string
}

export type RealtimeClient = {
  connect(): void
  send(message: ClientRealtimeMessage): void
  close(): void
  subscribe(listener: (message: ServerRealtimeMessage) => void): () => void
}

const parseError: ServerRealtimeMessage = {
  type: 'error',
  code: 'CLIENT_PARSE_ERROR',
  message: '无法解析实时消息',
}

export const createRealtimeClient = ({
  token,
  WebSocketCtor = WebSocket as unknown as WebSocketConstructor,
  realtimeUrl = getRealtimeUrl,
}: RealtimeClientOptions): RealtimeClient => {
  const listeners = new Set<(message: ServerRealtimeMessage) => void>()
  let socket: WebSocketLike | undefined

  const emit = (message: ServerRealtimeMessage) => {
    for (const listener of listeners) {
      listener(message)
    }
  }

  return {
    connect() {
      socket = new WebSocketCtor(realtimeUrl(token))
      socket.onmessage = event => {
        try {
          emit(JSON.parse(event.data) as ServerRealtimeMessage)
        } catch {
          emit(parseError)
        }
      }
    },
    send(message) {
      socket?.send(JSON.stringify(message))
    },
    close() {
      socket?.close()
      socket = undefined
    },
    subscribe(listener) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
  }
}
