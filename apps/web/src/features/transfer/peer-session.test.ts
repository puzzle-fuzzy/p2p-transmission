import { describe, expect, test, vi } from 'vitest'
import type {
  IceCandidateDto,
  PublicRoom,
  SignalClientMessage,
  TransferProtocolMessage,
} from '@p2p/contracts'
import {
  createPeerSession,
  type DataChannelLike,
  type PeerConnectionLike,
  type PeerSessionEvent,
} from './peer-session'

class FakeDataChannel implements DataChannelLike {
  readonly label: string
  readonly protocol: string
  readyState: RTCDataChannelState = 'connecting'
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: string[] = []

  constructor(
    label = 'p2p-transfer',
    protocol = 'p2p-transfer.v1',
  ) {
    this.label = label
    this.protocol = protocol
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.()
  }

  open() {
    this.readyState = 'open'
    this.onopen?.()
  }

  emit(message: TransferProtocolMessage) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  emitRaw(data: unknown) {
    this.onmessage?.({ data })
  }
}

class FakePeerConnection implements PeerConnectionLike {
  connectionState: RTCPeerConnectionState = 'new'
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  onicecandidate: PeerConnectionLike['onicecandidate'] = null
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  channels: FakeDataChannel[] = []
  addedIce: (IceCandidateDto | null)[] = []
  closed = false

  createDataChannel(label: string, options?: RTCDataChannelInit) {
    const channel = new FakeDataChannel(label, options?.protocol)
    this.channels.push(channel)
    return channel
  }

  async createOffer() {
    return { type: 'offer' as const, sdp: 'offer-sdp' }
  }

  async createAnswer() {
    return { type: 'answer' as const, sdp: 'answer-sdp' }
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description
  }

  async addIceCandidate(candidate: IceCandidateDto | null) {
    this.addedIce.push(candidate)
  }

  close() {
    this.closed = true
    this.connectionState = 'closed'
  }

  emitDataChannel(channel = new FakeDataChannel()) {
    this.channels.push(channel)
    this.ondatachannel?.({ channel })
    return channel
  }
}

const sender = {
  id: 'vis_sender',
  avatarSeed: 'sender',
  displayName: '发送者',
  createdAt: 1,
  lastSeenAt: 1,
}

const receiver = {
  id: 'vis_receiver',
  avatarSeed: 'receiver',
  displayName: '接收者',
  createdAt: 1,
  lastSeenAt: 1,
}

const room = (receivers = [receiver]): PublicRoom => ({
  code: '123456',
  senderId: sender.id,
  receivers: receivers.map(item => item.id),
  participants: [
    {
      visitor: sender,
      role: 'sender',
      joinedAt: 1,
      status: 'online',
    },
    ...receivers.map(visitor => ({
      visitor,
      role: 'receiver' as const,
      joinedAt: 1,
      status: 'online' as const,
    })),
  ],
  createdAt: 1,
  expiresAt: 10_000,
})

const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const parseSent = (channel: FakeDataChannel) =>
  channel.sent.map(item => JSON.parse(item) as TransferProtocolMessage)

describe('peer session', () => {
  test('sender creates one channel and offer per receiver without duplicating snapshots', async () => {
    const peers: FakePeerConnection[] = []
    const signals: SignalClientMessage[] = []
    const session = createPeerSession({
      selfId: sender.id,
      roomCode: '123456',
      role: 'sender',
      createPeerConnection: () => {
        const peer = new FakePeerConnection()
        peers.push(peer)
        return peer
      },
      createId: () => 'peer_1',
      sendSignal: message => signals.push(message),
    })

    session.syncRoom(room())
    session.syncRoom(room())
    await settle()

    expect(peers).toHaveLength(1)
    expect(peers[0]?.channels[0]).toMatchObject({
      label: 'p2p-transfer',
      protocol: 'p2p-transfer.v1',
    })
    expect(signals).toEqual([{
      type: 'signal:offer',
      roomCode: '123456',
      to: receiver.id,
      peerSessionId: 'peer_1',
      description: { type: 'offer', sdp: 'offer-sdp' },
    }])
  })

  test('queues ICE until the matching offer sets remote description', async () => {
    const peers: FakePeerConnection[] = []
    const signals: SignalClientMessage[] = []
    const session = createPeerSession({
      selfId: receiver.id,
      roomCode: '123456',
      role: 'receiver',
      createPeerConnection: () => {
        const peer = new FakePeerConnection()
        peers.push(peer)
        return peer
      },
      sendSignal: message => signals.push(message),
    })
    const candidate: IceCandidateDto = {
      candidate: 'candidate',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null,
    }

    await session.handleSignal({
      type: 'signal:ice',
      roomCode: '123456',
      from: sender.id,
      peerSessionId: 'peer_1',
      candidate,
    })
    await session.handleSignal({
      type: 'signal:offer',
      roomCode: '123456',
      from: sender.id,
      peerSessionId: 'peer_1',
      description: { type: 'offer', sdp: 'offer-sdp' },
    })

    expect(peers[0]?.remoteDescription).toEqual({ type: 'offer', sdp: 'offer-sdp' })
    expect(peers[0]?.addedIce).toEqual([candidate])
    expect(signals).toContainEqual({
      type: 'signal:answer',
      roomCode: '123456',
      to: sender.id,
      peerSessionId: 'peer_1',
      description: { type: 'answer', sdp: 'answer-sdp' },
    })
  })

  test('ignores answer and ICE from an old peer session', async () => {
    const peers: FakePeerConnection[] = []
    const session = createPeerSession({
      selfId: sender.id,
      roomCode: '123456',
      role: 'sender',
      createPeerConnection: () => {
        const peer = new FakePeerConnection()
        peers.push(peer)
        return peer
      },
      createId: () => 'peer_current',
      sendSignal: () => undefined,
    })

    session.syncRoom(room())
    await settle()
    await session.handleSignal({
      type: 'signal:answer',
      roomCode: '123456',
      from: receiver.id,
      peerSessionId: 'peer_old',
      description: { type: 'answer', sdp: 'stale' },
    })
    await session.handleSignal({
      type: 'signal:ice',
      roomCode: '123456',
      from: receiver.id,
      peerSessionId: 'peer_old',
      candidate: null,
    })

    expect(peers[0]?.remoteDescription).toBeNull()
    expect(peers[0]?.addedIce).toEqual([])
  })

  test('sends text only to peers that explicitly accept', async () => {
    const secondReceiver = {
      ...receiver,
      id: 'vis_receiver_2',
      displayName: '接收者 2',
    }
    const peers: FakePeerConnection[] = []
    let idIndex = 0
    const events: PeerSessionEvent[] = []
    const session = createPeerSession({
      selfId: sender.id,
      roomCode: '123456',
      role: 'sender',
      createPeerConnection: () => {
        const peer = new FakePeerConnection()
        peers.push(peer)
        return peer
      },
      createId: prefix => prefix === 'peer'
        ? 'peer_' + String(++idIndex)
        : 'tx_1',
      sendSignal: () => undefined,
    })
    session.subscribe(event => events.push(event))
    session.syncRoom(room([receiver, secondReceiver]))
    await settle()
    const first = peers[0]?.channels[0] as FakeDataChannel
    const second = peers[1]?.channels[0] as FakeDataChannel
    first.open()
    second.open()

    const offered = session.offerText('你好')

    expect(offered).toEqual({ transferId: 'tx_1', peerCount: 2 })
    expect(first.sent[0]).not.toContain('你好')
    expect(second.sent[0]).not.toContain('你好')

    first.emit({
      v: 1,
      type: 'transfer:decision',
      transferId: 'tx_1',
      decision: 'accept',
    })
    second.emit({
      v: 1,
      type: 'transfer:decision',
      transferId: 'tx_1',
      decision: 'reject',
    })

    expect(parseSent(first)).toContainEqual({
      v: 1,
      type: 'transfer:text',
      transferId: 'tx_1',
      text: '你好',
    })
    expect(parseSent(second).some(message => message.type === 'transfer:text')).toBe(false)
    expect(events).toContainEqual({
      type: 'transfer:decision',
      peerId: secondReceiver.id,
      transferId: 'tx_1',
      decision: 'reject',
    })
  })

  test('receiver emits a request, requires acceptance, validates text, and sends receipt', async () => {
    const peers: FakePeerConnection[] = []
    const events: PeerSessionEvent[] = []
    const session = createPeerSession({
      selfId: receiver.id,
      roomCode: '123456',
      role: 'receiver',
      createPeerConnection: () => {
        const peer = new FakePeerConnection()
        peers.push(peer)
        return peer
      },
      sendSignal: () => undefined,
    })
    session.subscribe(event => events.push(event))
    await session.handleSignal({
      type: 'signal:offer',
      roomCode: '123456',
      from: sender.id,
      peerSessionId: 'peer_1',
      description: { type: 'offer', sdp: 'offer-sdp' },
    })
    const channel = peers[0]?.emitDataChannel() as FakeDataChannel
    channel.open()
    channel.emit({
      v: 1,
      type: 'transfer:request',
      transferId: 'tx_1',
      kind: 'text',
      characterCount: 2,
      byteLength: 6,
    })

    expect(events).toContainEqual({
      type: 'transfer:request',
      peerId: sender.id,
      request: {
        transferId: 'tx_1',
        characterCount: 2,
        byteLength: 6,
      },
    })

    session.acceptText(sender.id, 'tx_1')
    channel.emit({
      v: 1,
      type: 'transfer:text',
      transferId: 'tx_1',
      text: '你好',
    })

    expect(events).toContainEqual({
      type: 'transfer:received',
      peerId: sender.id,
      transferId: 'tx_1',
      text: '你好',
    })
    expect(parseSent(channel)).toContainEqual({
      v: 1,
      type: 'transfer:receipt',
      transferId: 'tx_1',
      status: 'received',
    })
  })

  test('rejecting a request never exposes a later payload to the app', async () => {
    const peers: FakePeerConnection[] = []
    const events: PeerSessionEvent[] = []
    const session = createPeerSession({
      selfId: receiver.id,
      roomCode: '123456',
      role: 'receiver',
      createPeerConnection: () => {
        const peer = new FakePeerConnection()
        peers.push(peer)
        return peer
      },
      sendSignal: () => undefined,
    })
    session.subscribe(event => events.push(event))
    await session.handleSignal({
      type: 'signal:offer',
      roomCode: '123456',
      from: sender.id,
      peerSessionId: 'peer_1',
      description: { type: 'offer', sdp: 'offer-sdp' },
    })
    const channel = peers[0]?.emitDataChannel() as FakeDataChannel
    channel.open()
    channel.emit({
      v: 1,
      type: 'transfer:request',
      transferId: 'tx_1',
      kind: 'text',
      characterCount: 2,
      byteLength: 6,
    })

    session.rejectText(sender.id, 'tx_1')
    channel.emit({
      v: 1,
      type: 'transfer:text',
      transferId: 'tx_1',
      text: '你好',
    })

    expect(events.some(event => event.type === 'transfer:received')).toBe(false)
    expect(parseSent(channel)).toContainEqual({
      v: 1,
      type: 'transfer:decision',
      transferId: 'tx_1',
      decision: 'reject',
    })
  })

  test('channel readiness and cleanup are derived from the actual channel', async () => {
    const peers: FakePeerConnection[] = []
    const events: PeerSessionEvent[] = []
    const session = createPeerSession({
      selfId: sender.id,
      roomCode: '123456',
      role: 'sender',
      createPeerConnection: () => {
        const peer = new FakePeerConnection()
        peers.push(peer)
        return peer
      },
      createId: () => 'peer_1',
      sendSignal: () => undefined,
    })
    session.subscribe(event => events.push(event))
    session.syncRoom(room())
    await settle()
    const channel = peers[0]?.channels[0] as FakeDataChannel

    expect(session.readyPeerCount()).toBe(0)
    channel.open()
    expect(session.readyPeerCount()).toBe(1)

    session.syncRoom(room([]))
    expect(session.readyPeerCount()).toBe(0)
    expect(peers[0]?.closed).toBe(true)
    expect(events).toContainEqual({
      type: 'peer:state',
      peerId: receiver.id,
      state: 'closed',
    })
  })

  test('malformed non-string frames emit protocol errors', async () => {
    const peers: FakePeerConnection[] = []
    const onEvent = vi.fn<(event: PeerSessionEvent) => void>()
    const session = createPeerSession({
      selfId: receiver.id,
      roomCode: '123456',
      role: 'receiver',
      createPeerConnection: () => {
        const peer = new FakePeerConnection()
        peers.push(peer)
        return peer
      },
      sendSignal: () => undefined,
    })
    session.subscribe(onEvent)
    await session.handleSignal({
      type: 'signal:offer',
      roomCode: '123456',
      from: sender.id,
      peerSessionId: 'peer_1',
      description: { type: 'offer', sdp: 'offer-sdp' },
    })
    const channel = peers[0]?.emitDataChannel() as FakeDataChannel
    channel.emitRaw(new Blob(['bad']))

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      code: 'PROTOCOL_ERROR',
      peerId: sender.id,
    }))
  })
})
