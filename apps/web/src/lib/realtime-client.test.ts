import { describe, expect, test } from 'vitest'
import { createRealtimeClient, type WebSocketLike } from './realtime-client'
import type { ServerRealtimeMessage } from '../shared/contracts'

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = []

  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  sent: string[] = []
  url: string

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.onclose?.(new CloseEvent('close'))
  }

  emitMessage(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<string>)
  }

  emitRaw(data: string) {
    this.onmessage?.({ data } as MessageEvent<string>)
  }
}

describe('realtime-client', () => {
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
    client.send({ type: 'room:join', roomCode: '123456', role: 'sender' })

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
})
