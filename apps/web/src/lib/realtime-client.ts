import { getRealtimeUrl } from './config'
import type { ClientRealtimeMessage, ServerRealtimeMessage } from '../shared/contracts'

export type WebSocketLike = {
  readyState: number
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
  reconnectDelays?: readonly number[]
}

export type RealtimeStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export type RealtimeClient = {
  connect(): void
  send(message: ClientRealtimeMessage): void
  close(): void
  subscribe(listener: (message: ServerRealtimeMessage) => void): () => void
  subscribeStatus(listener: (status: RealtimeStatus) => void): () => void
}

const parseError: ServerRealtimeMessage = {
  type: 'error',
  code: 'CLIENT_PARSE_ERROR',
  message: '无法解析实时消息',
}

const defaultReconnectDelays = [500, 1_000, 2_000] as const
const openReadyState = 1

export const createRealtimeClient = ({
  token,
  WebSocketCtor = WebSocket as unknown as WebSocketConstructor,
  realtimeUrl = getRealtimeUrl,
  reconnectDelays = defaultReconnectDelays,
}: RealtimeClientOptions): RealtimeClient => {
  const listeners = new Set<(message: ServerRealtimeMessage) => void>()
  const statusListeners = new Set<(status: RealtimeStatus) => void>()
  const pendingMessages: ClientRealtimeMessage[] = []
  let socket: WebSocketLike | undefined
  let status: RealtimeStatus = 'idle'
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let explicitlyClosed = false

  const emit = (message: ServerRealtimeMessage) => {
    for (const listener of listeners) {
      listener(message)
    }
  }

  const setStatus = (nextStatus: RealtimeStatus) => {
    if (status === nextStatus) return

    status = nextStatus
    for (const listener of statusListeners) {
      listener(status)
    }
  }

  const detachSocket = (target: WebSocketLike) => {
    target.onopen = null
    target.onmessage = null
    target.onclose = null
  }

  const clearReconnectTimer = () => {
    if (reconnectTimer === undefined) return

    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }

  const reconnectLimit = Math.min(reconnectDelays.length, 3)

  const scheduleReconnect = () => {
    if (explicitlyClosed) return

    if (reconnectAttempt >= reconnectLimit) {
      pendingMessages.splice(0)
      setStatus('closed')
      return
    }

    setStatus('reconnecting')
    const delay = reconnectDelays[reconnectAttempt] ?? 0
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      openSocket()
    }, delay)
  }

  const handleUnexpectedClose = (closedSocket: WebSocketLike) => {
    if (socket !== closedSocket || explicitlyClosed) return

    detachSocket(closedSocket)
    socket = undefined
    scheduleReconnect()
  }

  function openSocket() {
    if (explicitlyClosed) return

    let nextSocket: WebSocketLike

    try {
      nextSocket = new WebSocketCtor(realtimeUrl(token))
    } catch {
      scheduleReconnect()
      return
    }

    socket = nextSocket
    nextSocket.onopen = () => {
      if (socket !== nextSocket || explicitlyClosed) return

      reconnectAttempt = 0
      setStatus('open')

      if (socket !== nextSocket || explicitlyClosed) return

      for (const message of pendingMessages.splice(0)) {
        nextSocket.send(JSON.stringify(message))
      }
    }
    nextSocket.onmessage = event => {
      if (socket !== nextSocket || explicitlyClosed) return

      try {
        emit(JSON.parse(event.data) as ServerRealtimeMessage)
      } catch {
        emit(parseError)
      }
    }
    nextSocket.onclose = () => {
      handleUnexpectedClose(nextSocket)
    }
  }

  return {
    connect() {
      if (socket || reconnectTimer !== undefined || status === 'connecting' || status === 'reconnecting') {
        return
      }

      explicitlyClosed = false
      reconnectAttempt = 0
      setStatus('connecting')
      openSocket()
    },
    send(message) {
      if (explicitlyClosed) return

      if (socket?.readyState === openReadyState) {
        socket.send(JSON.stringify(message))
        return
      }

      pendingMessages.push(message)
    },
    close() {
      explicitlyClosed = true
      clearReconnectTimer()
      pendingMessages.splice(0)
      reconnectAttempt = 0

      const activeSocket = socket
      socket = undefined
      if (activeSocket) {
        detachSocket(activeSocket)
        activeSocket.close()
      }

      setStatus('closed')
      listeners.clear()
      statusListeners.clear()
    },
    subscribe(listener) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    subscribeStatus(listener) {
      statusListeners.add(listener)
      listener(status)

      return () => {
        statusListeners.delete(listener)
      }
    },
  }
}
