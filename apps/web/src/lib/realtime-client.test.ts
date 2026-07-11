import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createRealtimeClient,
  type RealtimeStatus,
  type WebSocketLike,
} from './realtime-client'
import type { ClientRealtimeMessage, ServerRealtimeMessage } from '../shared/contracts'

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = []

  readyState = 0
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  sent: string[] = []
  url: string
  closeCalls = 0

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.closeCalls += 1
    this.emitClose()
  }

  open() {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  emitMessage(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<string>)
  }

  emitRaw(data: string) {
    this.onmessage?.({ data } as MessageEvent<string>)
  }

  emitClose() {
    this.readyState = 3
    this.onclose?.({} as CloseEvent)
  }
}

describe('realtime-client', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('connects with realtime token URL', () => {
    FakeWebSocket.instances = []
    const client = createRealtimeClient({
      token: 'tok_1',
      WebSocketCtor: FakeWebSocket,
      realtimeUrl: token => `ws://api.test/v1/realtime?token=${token}`,
    })

    client.connect()

    expect(FakeWebSocket.instances[0]?.url).toBe('ws://api.test/v1/realtime?token=tok_1')
  })

  test('sends typed messages as JSON', () => {
    FakeWebSocket.instances = []
    const client = createRealtimeClient({
      token: 'tok_1',
      WebSocketCtor: FakeWebSocket,
      realtimeUrl: token => `ws://api.test/v1/realtime?token=${token}`,
    })

    client.connect()
    FakeWebSocket.instances[0]?.open()
    client.send({ type: 'room:join', roomCode: '123456', role: 'sender' })

    expect(FakeWebSocket.instances[0]?.sent).toEqual([
      JSON.stringify({ type: 'room:join', roomCode: '123456', role: 'sender' }),
    ])
  })

  test('queues messages until socket opens', () => {
    FakeWebSocket.instances = []
    const client = createRealtimeClient({
      token: 'tok_1',
      WebSocketCtor: FakeWebSocket,
      realtimeUrl: token => `ws://api.test/v1/realtime?token=${token}`,
    })

    client.connect()
    client.send({ type: 'room:join', roomCode: '123456', role: 'sender' })
    expect(FakeWebSocket.instances[0]?.sent).toEqual([])

    FakeWebSocket.instances[0]?.open()

    expect(FakeWebSocket.instances[0]?.sent).toEqual([
      JSON.stringify({ type: 'room:join', roomCode: '123456', role: 'sender' }),
    ])
  })

  test('delivers incoming parsed messages to subscribers', () => {
    FakeWebSocket.instances = []
    const messages: ServerRealtimeMessage[] = []
    const client = createRealtimeClient({
      token: 'tok_1',
      WebSocketCtor: FakeWebSocket,
      realtimeUrl: token => `ws://api.test/v1/realtime?token=${token}`,
    })

    client.subscribe(message => messages.push(message))
    client.connect()
    FakeWebSocket.instances[0]?.emitMessage({
      type: 'visitor:ready',
      visitor: {
        id: 'vis_1',
        avatarSeed: 'seed_1',
        displayName: '访客 0001',
        createdAt: 1,
        lastSeenAt: 1,
      },
    })

    expect(messages).toEqual([{
      type: 'visitor:ready',
      visitor: {
        id: 'vis_1',
        avatarSeed: 'seed_1',
        displayName: '访客 0001',
        createdAt: 1,
        lastSeenAt: 1,
      },
    }])
  })

  test('unsubscribe stops delivery', () => {
    FakeWebSocket.instances = []
    const messages: ServerRealtimeMessage[] = []
    const client = createRealtimeClient({
      token: 'tok_1',
      WebSocketCtor: FakeWebSocket,
      realtimeUrl: token => `ws://api.test/v1/realtime?token=${token}`,
    })
    const unsubscribe = client.subscribe(message => messages.push(message))

    client.connect()
    unsubscribe()
    FakeWebSocket.instances[0]?.emitMessage({
      type: 'error',
      code: 'NOPE',
      message: 'nope',
    })

    expect(messages).toEqual([])
  })

  test('emits parse error when incoming data is invalid JSON', () => {
    FakeWebSocket.instances = []
    const messages: ServerRealtimeMessage[] = []
    const client = createRealtimeClient({
      token: 'tok_1',
      WebSocketCtor: FakeWebSocket,
      realtimeUrl: token => `ws://api.test/v1/realtime?token=${token}`,
    })

    client.subscribe(message => messages.push(message))
    client.connect()
    FakeWebSocket.instances[0]?.emitRaw('{bad json')

    expect(messages).toEqual([{
      type: 'error',
      code: 'CLIENT_PARSE_ERROR',
      message: '无法解析实时消息',
    }])
  })

  test('reports the current status and socket lifecycle', () => {
    FakeWebSocket.instances = []
    const statuses: RealtimeStatus[] = []
    const client = createRealtimeClient({
      token: 'tok_1',
      WebSocketCtor: FakeWebSocket,
      realtimeUrl: token => `ws://api.test/v1/realtime?token=${token}`,
    })

    client.subscribeStatus(status => statuses.push(status))
    client.connect()
    FakeWebSocket.instances[0]?.open()

    expect(statuses).toEqual(['idle', 'connecting', 'open'])
  })

  test('bounds reconnects even when every socket briefly opens before closing', () => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    const statuses: RealtimeStatus[] = []
    const client = createRealtimeClient({
      token: 'tok_1',
      WebSocketCtor: FakeWebSocket,
      realtimeUrl: token => `ws://api.test/v1/realtime?token=${token}`,
    })

    client.subscribeStatus(status => statuses.push(status))
    client.connect()
    FakeWebSocket.instances[0]?.open()
    FakeWebSocket.instances[0]?.emitClose()

    expect(statuses.at(-1)).toBe('reconnecting')
    vi.advanceTimersByTime(499)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(2)

    FakeWebSocket.instances[1]?.open()
    FakeWebSocket.instances[1]?.emitClose()
    vi.advanceTimersByTime(999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(3)

    FakeWebSocket.instances[2]?.open()
    FakeWebSocket.instances[2]?.emitClose()
    vi.advanceTimersByTime(2_000)
    expect(FakeWebSocket.instances).toHaveLength(4)

    FakeWebSocket.instances[3]?.open()
    FakeWebSocket.instances[3]?.emitClose()
    vi.advanceTimersByTime(10_000)

    expect(FakeWebSocket.instances).toHaveLength(4)
    expect(statuses.at(-1)).toBe('closed')
  })

  test('restores the reconnect budget after a stable connection', () => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    const client = createRealtimeClient({
      token: 'tok_1',
      WebSocketCtor: FakeWebSocket,
      realtimeUrl: token => `ws://api.test/v1/realtime?token=${token}`,
      reconnectDelays: [100, 200, 300],
      stableConnectionMs: 1_000,
    })

    client.connect()
    FakeWebSocket.instances[0]?.open()
    FakeWebSocket.instances[0]?.emitClose()
    vi.advanceTimersByTime(100)

    FakeWebSocket.instances[1]?.open()
    vi.advanceTimersByTime(1_000)
    FakeWebSocket.instances[1]?.emitClose()

    vi.advanceTimersByTime(99)
    expect(FakeWebSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  test('explicit close clears handlers and never reconnects', () => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    const statuses: RealtimeStatus[] = []
    const messages: ServerRealtimeMessage[] = []
    const client = createRealtimeClient({
      token: 'tok_1',
      WebSocketCtor: FakeWebSocket,
      realtimeUrl: token => `ws://api.test/v1/realtime?token=${token}`,
    })

    client.subscribe(message => messages.push(message))
    client.subscribeStatus(status => statuses.push(status))
    client.connect()
    const socket = FakeWebSocket.instances[0]
    socket?.open()

    client.close()
    socket?.emitMessage({ type: 'error', code: 'LATE', message: 'late' })
    vi.runAllTimers()

    expect(socket?.closeCalls).toBe(1)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(statuses.at(-1)).toBe('closed')
    expect(messages).toEqual([])
  })

  test('emits open before flushing queued signals so the room rejoins first', () => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    const client = createRealtimeClient({
      token: 'tok_1',
      WebSocketCtor: FakeWebSocket,
      realtimeUrl: token => `ws://api.test/v1/realtime?token=${token}`,
    })
    let openCount = 0

    client.subscribeStatus(status => {
      if (status !== 'open') return

      openCount += 1
      if (openCount === 2) {
        client.send({ type: 'room:join', roomCode: '123456', role: 'sender' })
      }
    })
    client.connect()
    FakeWebSocket.instances[0]?.open()
    FakeWebSocket.instances[0]?.emitClose()

    const queuedSignal = {
      type: 'signal:ice',
      roomCode: '123456',
      to: 'vis_2',
      peerSessionId: 'peer_1',
      candidate: null,
    } as ClientRealtimeMessage
    client.send(queuedSignal)

    vi.advanceTimersByTime(500)
    const reconnectedSocket = FakeWebSocket.instances[1]
    reconnectedSocket?.open()

    expect(reconnectedSocket?.sent).toEqual([
      JSON.stringify({ type: 'room:join', roomCode: '123456', role: 'sender' }),
      JSON.stringify(queuedSignal),
    ])
  })
})
