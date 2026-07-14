import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  encodeFileChunkFrame,
  type FileDescriptor,
  type IceCandidateDto,
  type PublicRoom,
  type SignalClientMessage,
  type TransferProtocolMessage,
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
  binaryType: BinaryType = 'blob'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onbufferedamountlow: (() => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: (string | ArrayBuffer)[] = []

  constructor(label = 'p2p-transfer', protocol = 'p2p-transfer.v2') {
    this.label = label
    this.protocol = protocol
  }

  send(data: string | ArrayBuffer) {
    if (this.readyState !== 'open') throw new Error('channel closed')
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
  sctp: { maxMessageSize: number } | null
  onicecandidate: PeerConnectionLike['onicecandidate'] = null
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  channels: FakeDataChannel[] = []
  addedIce: (IceCandidateDto | null)[] = []
  closed = false

  constructor(maxMessageSize = 64 * 1024) {
    this.sctp = { maxMessageSize }
  }

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
    { visitor: sender, role: 'sender', joinedAt: 1, status: 'online' },
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
  await Promise.resolve()
}

const settleDeep = async () => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

const controls = (channel: FakeDataChannel) => channel.sent
  .filter((item): item is string => typeof item === 'string')
  .map(item => JSON.parse(item) as TransferProtocolMessage)

const senderHarness = (connections: FakePeerConnection[] = []) => {
  let peerId = 0
  let transferId = 0
  const events: PeerSessionEvent[] = []
  const session = createPeerSession({
    selfId: sender.id,
    roomCode: '123456',
    role: 'sender',
    createPeerConnection: () => connections.shift() ?? new FakePeerConnection(),
    createId: prefix => prefix === 'peer'
      ? `peer_${String(++peerId)}`
      : `tx_${String(++transferId)}`,
    sendSignal: () => undefined,
  })
  session.subscribe(event => events.push(event))
  return { session, events }
}

const receiverHarness = async () => {
  const connection = new FakePeerConnection()
  const events: PeerSessionEvent[] = []
  const session = createPeerSession({
    selfId: receiver.id,
    roomCode: '123456',
    role: 'receiver',
    createPeerConnection: () => connection,
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
  const channel = connection.emitDataChannel()
  channel.open()
  return { session, connection, channel, events }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('peer session v2', () => {
  test('keeps peer generation guards and creates a v2 binary channel', async () => {
    const connection = new FakePeerConnection()
    const signals: SignalClientMessage[] = []
    const session = createPeerSession({
      selfId: sender.id,
      roomCode: '123456',
      role: 'sender',
      createPeerConnection: () => connection,
      createId: () => 'peer_current',
      sendSignal: message => signals.push(message),
    })

    session.syncRoom(room())
    session.syncRoom(room())
    await settle()

    expect(connection.channels).toHaveLength(1)
    expect(connection.channels[0]).toMatchObject({
      label: 'p2p-transfer',
      protocol: 'p2p-transfer.v2',
      binaryType: 'arraybuffer',
    })
    expect(signals).toContainEqual(expect.objectContaining({
      type: 'signal:offer',
      peerSessionId: 'peer_current',
    }))

    await session.handleSignal({
      type: 'signal:answer',
      roomCode: '123456',
      from: receiver.id,
      peerSessionId: 'peer_old',
      description: { type: 'answer', sdp: 'stale' },
    })
    expect(connection.remoteDescription).toBeNull()
  })

  test('returns exact ready peer IDs in room order and removes closed peers', async () => {
    const first = new FakePeerConnection()
    const second = new FakePeerConnection()
    const receiverTwo = { ...receiver, id: 'vis_receiver_2' }
    const { session } = senderHarness([first, second])
    session.syncRoom(room([receiver, receiverTwo]))
    await settle()

    const firstChannel = first.channels[0] as FakeDataChannel
    const secondChannel = second.channels[0] as FakeDataChannel
    expect(session.readyPeerIds()).toEqual([])

    secondChannel.open()
    expect(session.readyPeerIds()).toEqual([receiverTwo.id])

    firstChannel.open()
    const snapshot = session.readyPeerIds()
    expect(snapshot).toEqual([receiver.id, receiverTwo.id])
    expect(session.readyPeerIds()).not.toBe(snapshot)

    firstChannel.close()
    expect(session.readyPeerIds()).toEqual([receiverTwo.id])

    session.close()
    expect(session.readyPeerIds()).toEqual([])
  })

  test('offers files only to selected ready peers and rejects an empty target set', async () => {
    const first = new FakePeerConnection(4096)
    const second = new FakePeerConnection(4096)
    const receiverTwo = { ...receiver, id: 'vis_receiver_2' }
    const { session } = senderHarness([first, second])
    session.syncRoom(room([receiver, receiverTwo]))
    await settle()

    const firstChannel = first.channels[0] as FakeDataChannel
    const secondChannel = second.channels[0] as FakeDataChannel
    firstChannel.open()
    secondChannel.open()
    const file = new File([new Uint8Array([1, 2, 3])], 'target.txt')

    expect(() => session.offerFiles([{ fileId: 'file_empty_target', file }], [])).toThrow('No connected receivers')

    const offered = session.offerFiles([{ fileId: 'file_target', file }], [receiver.id])

    expect(offered.peerIds).toEqual([receiver.id])
    expect(controls(firstChannel)).toContainEqual(expect.objectContaining({ type: 'transfer:file-request' }))
    expect(controls(secondChannel)).not.toContainEqual(expect.objectContaining({ type: 'transfer:file-request' }))
  })

  test('offers metadata only and excludes a peer whose channel cannot carry 1 KiB chunks', async () => {
    const supported = new FakePeerConnection(4096)
    const unsupported = new FakePeerConnection(1000)
    const secondReceiver = { ...receiver, id: 'vis_receiver_2' }
    const { session } = senderHarness([supported, unsupported])
    session.syncRoom(room([receiver, secondReceiver]))
    await settle()
    const supportedChannel = supported.channels[0] as FakeDataChannel
    const unsupportedChannel = unsupported.channels[0] as FakeDataChannel
    supportedChannel.open()
    unsupportedChannel.open()
    const file = new File([new Uint8Array([1, 2, 3])], 'safe.txt', { type: 'text/plain', lastModified: 9 })
    const slice = vi.spyOn(file, 'slice')

    const offered = session.offerFiles([{ fileId: 'file_1', file }])

    expect(offered.peerIds).toEqual([receiver.id, secondReceiver.id])
    expect(offered.peerCount).toBe(1)
    expect(offered.unsupportedPeerIds).toEqual([secondReceiver.id])
    expect(slice).not.toHaveBeenCalled()
    expect(supportedChannel.sent.some(item => item instanceof ArrayBuffer)).toBe(false)
    expect(unsupportedChannel.sent).toEqual([])
    expect(controls(supportedChannel)[0]).toMatchObject({
      v: 2,
      type: 'transfer:file-request',
      transferId: offered.transferId,
      files: [{ fileId: 'file_1', chunkSize: 4080, chunkCount: 1 }],
    })
  })

  test('starts file reads only after accept and completes only after the file receipt', async () => {
    const connection = new FakePeerConnection(4096)
    const { session, events } = senderHarness([connection])
    session.syncRoom(room())
    await settle()
    const channel = connection.channels[0] as FakeDataChannel
    channel.open()
    const file = new File([new Uint8Array([1, 2, 3])], 'payload.bin')
    const slice = vi.spyOn(file, 'slice')
    const offered = session.offerFiles([{ fileId: 'file_1', file }])

    channel.emit({ v: 2, type: 'transfer:decision', transferId: offered.transferId, decision: 'accept' })
    await vi.waitFor(() => {
      expect(controls(channel).some(frame => frame.type === 'transfer:file-end')).toBe(true)
    })

    expect(slice).toHaveBeenCalledTimes(1)
    expect(controls(channel)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'transfer:file-start', fileId: 'file_1' }),
      expect.objectContaining({ type: 'transfer:file-end', fileId: 'file_1' }),
    ]))
    expect(channel.sent.filter(item => item instanceof ArrayBuffer)).toHaveLength(1)
    expect(events.some(event => event.type === 'transfer:terminal' && event.outcome === 'completed')).toBe(false)

    channel.emit({
      v: 2,
      type: 'transfer:receipt',
      transferId: offered.transferId,
      kind: 'file',
      fileId: 'file_1',
      status: 'received',
    })
    await settle()
    expect(events).toContainEqual({
      type: 'transfer:terminal',
      peerId: receiver.id,
      transferId: offered.transferId,
      outcome: 'completed',
    })
  })

  test('reconstructs exact bytes, sanitizes names, and emits one final file batch', async () => {
    const { session, channel, events } = await receiverHarness()
    const descriptor: FileDescriptor = {
      fileId: 'file_1',
      streamId: 1,
      name: '../unsafe\\name.txt',
      mimeType: 'text/plain',
      byteLength: 3,
      lastModified: 9,
      chunkSize: 1024,
      chunkCount: 1,
    }
    channel.emit({ v: 2, type: 'transfer:file-request', transferId: 'tx_1', files: [descriptor] })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'transfer:file-requested',
      files: [expect.objectContaining({ name: '..unsafename.txt' })],
    }))
    expect(session.acceptFiles(sender.id, 'tx_1')).toBe(true)
    channel.emit({ v: 2, type: 'transfer:file-start', transferId: 'tx_1', fileId: 'file_1', streamId: 1 })
    channel.emitRaw(encodeFileChunkFrame({
      streamId: 1,
      chunkIndex: 0,
      payload: new Uint8Array([7, 8, 9]),
    }, 1024))
    channel.emit({
      v: 2,
      type: 'transfer:file-end',
      transferId: 'tx_1',
      fileId: 'file_1',
      streamId: 1,
      chunkCount: 1,
      byteLength: 3,
    })

    const finals = events.filter((event): event is Extract<PeerSessionEvent, { type: 'transfer:files-received' }> =>
      event.type === 'transfer:files-received')
    expect(finals).toHaveLength(1)
    expect(finals[0]?.files[0]).toMatchObject({
      fileId: 'file_1',
      name: '..unsafename.txt',
      byteLength: 3,
    })
    expect(new Uint8Array(await finals[0]?.files[0]?.blob.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]))
    expect(controls(channel)).toContainEqual({
      v: 2,
      type: 'transfer:receipt',
      transferId: 'tx_1',
      kind: 'file',
      fileId: 'file_1',
      status: 'received',
    })
  })

  test('rejects a file request without accepting binary payloads', async () => {
    const { session, channel, events } = await receiverHarness()
    const descriptor: FileDescriptor = {
      fileId: 'file_1',
      streamId: 1,
      name: 'a.txt',
      mimeType: 'text/plain',
      byteLength: 1,
      lastModified: 1,
      chunkSize: 1024,
      chunkCount: 1,
    }
    channel.emit({ v: 2, type: 'transfer:file-request', transferId: 'tx_1', files: [descriptor] })
    expect(session.rejectFiles(sender.id, 'tx_1')).toBe(true)
    expect(session.rejectFiles(sender.id, 'tx_1')).toBe(false)
    expect(controls(channel)).toContainEqual({
      v: 2,
      type: 'transfer:decision',
      transferId: 'tx_1',
      decision: 'reject',
    })
    expect(events).toContainEqual({
      type: 'transfer:terminal',
      peerId: sender.id,
      transferId: 'tx_1',
      outcome: 'rejected',
    })
  })

  test('times out an unanswered file decision and releases transfer mutual exclusion', async () => {
    vi.useFakeTimers()
    const connection = new FakePeerConnection()
    const { session, events } = senderHarness([connection])
    session.syncRoom(room())
    await settle()
    const channel = connection.channels[0] as FakeDataChannel
    channel.open()
    const first = session.offerFiles([{ fileId: 'file_1', file: new File(['a'], 'a.txt') }])

    await vi.advanceTimersByTimeAsync(30_000)
    expect(events).toContainEqual({
      type: 'transfer:terminal',
      peerId: receiver.id,
      transferId: first.transferId,
      outcome: 'timed-out',
    })
    expect(session.offerFiles([{ fileId: 'file_unlocked', file: new File(['b'], 'b.txt') }]).peerCount).toBe(1)
  })

  test('peer close aborts active work and emits one terminal cancellation', async () => {
    const connection = new FakePeerConnection()
    const { session, events } = senderHarness([connection])
    session.syncRoom(room())
    await settle()
    const channel = connection.channels[0] as FakeDataChannel
    channel.open()
    const offered = session.offerFiles([{ fileId: 'file_1', file: new File(['a'], 'a.txt') }])
    channel.close()
    await settle()

    expect(events.filter(event =>
      event.type === 'transfer:terminal'
      && event.transferId === offered.transferId)).toEqual([{
      type: 'transfer:terminal',
      peerId: receiver.id,
      transferId: offered.transferId,
      outcome: 'cancelled',
    }])
    expect(events).toContainEqual({ type: 'peer:state', peerId: receiver.id, state: 'closed' })
  })

  test('allocates a fresh stream after cancellation instead of reusing a tombstoned ID', async () => {
    const connection = new FakePeerConnection()
    const { session } = senderHarness([connection])
    session.syncRoom(room())
    await settle()
    const channel = connection.channels[0] as FakeDataChannel
    channel.open()
    const first = session.offerFiles([{ fileId: 'file_1', file: new File(['a'], 'a.txt') }])
    const firstRequest = controls(channel).find(frame => frame.type === 'transfer:file-request')
    expect(session.cancelTransfer(first.transferId)).toBe(true)

    const second = session.offerFiles([{ fileId: 'file_2', file: new File(['b'], 'b.txt') }])
    const secondRequest = controls(channel)
      .filter(frame => frame.type === 'transfer:file-request')
      .at(-1)
    expect(firstRequest?.type === 'transfer:file-request' ? firstRequest.files[0]?.streamId : undefined).toBe(1)
    expect(secondRequest?.type === 'transfer:file-request' ? secondRequest.files[0]?.streamId : undefined).toBe(2)
    session.cancelTransfer(second.transferId)
  })

  test('a throwing first peer does not detach the still-active second peer', async () => {
    const failing = new FakePeerConnection()
    const healthy = new FakePeerConnection()
    const secondReceiver = { ...receiver, id: 'vis_receiver_2' }
    const { session, events } = senderHarness([failing, healthy])
    session.syncRoom(room([receiver, secondReceiver]))
    await settle()
    const failingChannel = failing.channels[0] as FakeDataChannel
    const healthyChannel = healthy.channels[0] as FakeDataChannel
    failingChannel.open()
    healthyChannel.open()
    failingChannel.send = () => { throw new Error('send failed') }

    const files = session.offerFiles([{ fileId: 'file_1', file: new File(['x'], 'x.txt') }])
    healthyChannel.emit({ v: 2, type: 'transfer:decision', transferId: files.transferId, decision: 'accept' })
    await vi.waitFor(() => {
      expect(controls(healthyChannel).some(frame =>
        frame.type === 'transfer:file-end'
        && frame.transferId === files.transferId)).toBe(true)
    })
    healthyChannel.emit({
      v: 2,
      type: 'transfer:receipt',
      transferId: files.transferId,
      kind: 'file',
      fileId: 'file_1',
      status: 'received',
    })
    await settle()
    expect(events).toContainEqual({
      type: 'transfer:terminal',
      peerId: secondReceiver.id,
      transferId: files.transferId,
      outcome: 'completed',
    })
  })

  test('two accepted peers pump independently when one channel is backpressured', async () => {
    const stalled = new FakePeerConnection()
    const healthy = new FakePeerConnection()
    const secondReceiver = { ...receiver, id: 'vis_receiver_2' }
    const { session, events } = senderHarness([stalled, healthy])
    session.syncRoom(room([receiver, secondReceiver]))
    await settle()
    const stalledChannel = stalled.channels[0] as FakeDataChannel
    const healthyChannel = healthy.channels[0] as FakeDataChannel
    stalledChannel.open()
    healthyChannel.open()
    stalledChannel.bufferedAmount = 2 * 1024 * 1024

    const offered = session.offerFiles([{
      fileId: 'file_1',
      file: new File([new Uint8Array([1, 2, 3])], 'payload.bin'),
    }])
    stalledChannel.emit({ v: 2, type: 'transfer:decision', transferId: offered.transferId, decision: 'accept' })
    healthyChannel.emit({ v: 2, type: 'transfer:decision', transferId: offered.transferId, decision: 'accept' })

    await vi.waitFor(() => {
      expect(controls(healthyChannel).some(frame => frame.type === 'transfer:file-end')).toBe(true)
    })
    expect(controls(stalledChannel).some(frame => frame.type === 'transfer:file-end')).toBe(false)
    healthyChannel.emit({
      v: 2,
      type: 'transfer:receipt',
      transferId: offered.transferId,
      kind: 'file',
      fileId: 'file_1',
      status: 'received',
    })
    await settleDeep()
    expect(events).toContainEqual({
      type: 'transfer:terminal',
      peerId: secondReceiver.id,
      transferId: offered.transferId,
      outcome: 'completed',
    })
    expect(events.some(event =>
      event.type === 'transfer:terminal'
      && event.peerId === receiver.id
      && event.transferId === offered.transferId)).toBe(false)
    session.cancelTransfer(offered.transferId)
  })

  test('fails non-sequential chunks and mismatched final totals without exposing partial files', async () => {
    const descriptor: FileDescriptor = {
      fileId: 'file_1',
      streamId: 1,
      name: 'a.bin',
      mimeType: 'application/octet-stream',
      byteLength: 2,
      lastModified: 1,
      chunkSize: 1024,
      chunkCount: 1,
    }
    const first = await receiverHarness()
    first.channel.emit({ v: 2, type: 'transfer:file-request', transferId: 'tx_order', files: [descriptor] })
    first.session.acceptFiles(sender.id, 'tx_order')
    first.channel.emit({ v: 2, type: 'transfer:file-start', transferId: 'tx_order', fileId: 'file_1', streamId: 1 })
    first.channel.emitRaw(encodeFileChunkFrame({
      streamId: 1,
      chunkIndex: 1,
      payload: new Uint8Array([1, 2]),
    }, 1024))
    expect(first.events).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'PROTOCOL_ERROR',
      transferId: 'tx_order',
    }))
    expect(first.events.some(event => event.type === 'transfer:files-received')).toBe(false)

    const second = await receiverHarness()
    second.channel.emit({ v: 2, type: 'transfer:file-request', transferId: 'tx_total', files: [descriptor] })
    second.session.acceptFiles(sender.id, 'tx_total')
    second.channel.emit({ v: 2, type: 'transfer:file-start', transferId: 'tx_total', fileId: 'file_1', streamId: 1 })
    second.channel.emitRaw(encodeFileChunkFrame({
      streamId: 1,
      chunkIndex: 0,
      payload: new Uint8Array([1, 2]),
    }, 1024))
    second.channel.emit({
      v: 2,
      type: 'transfer:file-end',
      transferId: 'tx_total',
      fileId: 'file_1',
      streamId: 1,
      chunkCount: 1,
      byteLength: 1,
    })
    expect(second.events).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'PROTOCOL_ERROR',
      transferId: 'tx_total',
    }))
    expect(second.events.some(event => event.type === 'transfer:files-received')).toBe(false)
  })

  test('chunk inactivity and file receipt timeouts terminate and release active locks', async () => {
    vi.useFakeTimers()
    const incoming = await receiverHarness()
    const descriptor: FileDescriptor = {
      fileId: 'file_1',
      streamId: 1,
      name: 'a.bin',
      mimeType: '',
      byteLength: 1,
      lastModified: 1,
      chunkSize: 1024,
      chunkCount: 1,
    }
    incoming.channel.emit({ v: 2, type: 'transfer:file-request', transferId: 'tx_idle', files: [descriptor] })
    incoming.session.acceptFiles(sender.id, 'tx_idle')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(incoming.events).toContainEqual({
      type: 'transfer:terminal',
      peerId: sender.id,
      transferId: 'tx_idle',
      outcome: 'timed-out',
    })
    incoming.channel.emit({
      v: 2,
      type: 'transfer:file-request',
      transferId: 'tx_after_idle',
      files: [{ ...descriptor, streamId: 2 }],
    })
    expect(incoming.events).toContainEqual(expect.objectContaining({
      type: 'transfer:file-requested',
      transferId: 'tx_after_idle',
    }))

    const connection = new FakePeerConnection()
    const outgoing = senderHarness([connection])
    outgoing.session.syncRoom(room())
    await settleDeep()
    const channel = connection.channels[0] as FakeDataChannel
    channel.open()
    const offered = outgoing.session.offerFiles([{
      fileId: 'empty_file',
      file: new File([], 'empty.bin'),
    }])
    channel.emit({ v: 2, type: 'transfer:decision', transferId: offered.transferId, decision: 'accept' })
    await settleDeep()
    expect(controls(channel).some(frame => frame.type === 'transfer:file-end')).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(outgoing.events).toContainEqual({
      type: 'transfer:terminal',
      peerId: receiver.id,
      transferId: offered.transferId,
      outcome: 'timed-out',
    })
    expect(outgoing.session.offerFiles([{ fileId: 'file_unlocked', file: new File(['b'], 'b.txt') }]).peerCount).toBe(1)
  })

  test('read failure sends cancellation before reporting a local terminal failure', async () => {
    const connection = new FakePeerConnection()
    const { session, events } = senderHarness([connection])
    session.syncRoom(room())
    await settle()
    const channel = connection.channels[0] as FakeDataChannel
    channel.open()
    const file = new File(['x'], 'broken.bin')
    vi.spyOn(file, 'slice').mockReturnValue({
      arrayBuffer: () => Promise.reject(new Error('read failed')),
    } as Blob)
    const offered = session.offerFiles([{ fileId: 'file_1', file }])
    channel.emit({ v: 2, type: 'transfer:decision', transferId: offered.transferId, decision: 'accept' })
    await settleDeep()

    const cancelIndex = controls(channel).findIndex(frame =>
      frame.type === 'transfer:cancel'
      && frame.transferId === offered.transferId)
    expect(cancelIndex).toBeGreaterThan(-1)
    expect(events).toContainEqual({
      type: 'transfer:terminal',
      peerId: receiver.id,
      transferId: offered.transferId,
      outcome: 'failed',
      code: 'TRANSFER_ERROR',
    })
  })

  test('detaches a replaced data channel so stale callbacks cannot affect the peer', async () => {
    const { connection, channel: first, events } = await receiverHarness()
    const second = connection.emitDataChannel(new FakeDataChannel())
    second.open()
    const eventsBeforeStaleFrame = events.length

    first.emitRaw(JSON.stringify({
      v: 2,
      type: 'transfer:text',
      transferId: 'tx_stale',
      text: 'stale',
    }))
    first.close()
    expect(events).toHaveLength(eventsBeforeStaleFrame)
    expect(connection.closed).toBe(false)

    second.emit({
      v: 2,
      type: 'transfer:file-request',
      transferId: 'tx_current',
      files: [{
        fileId: 'file_current',
        streamId: 1,
        name: 'current.txt',
        mimeType: 'text/plain',
        byteLength: 0,
        lastModified: 1,
        chunkSize: 1024,
        chunkCount: 0,
      }],
    })
    expect(events).toContainEqual({
      type: 'transfer:file-requested',
      peerId: sender.id,
      transferId: 'tx_current',
      files: [expect.objectContaining({ fileId: 'file_current' })],
    })
  })

  test('buffers replacement-generation ICE while the old peer entry still exists', async () => {
    const first = new FakePeerConnection()
    const second = new FakePeerConnection()
    const connections = [first, second]
    const session = createPeerSession({
      selfId: receiver.id,
      roomCode: '123456',
      role: 'receiver',
      createPeerConnection: () => connections.shift() as FakePeerConnection,
      sendSignal: () => undefined,
    })
    await session.handleSignal({
      type: 'signal:offer',
      roomCode: '123456',
      from: sender.id,
      peerSessionId: 'peer_old',
      description: { type: 'offer', sdp: 'old-offer' },
    })
    const candidate: IceCandidateDto = {
      candidate: 'replacement-candidate',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null,
    }
    await session.handleSignal({
      type: 'signal:ice',
      roomCode: '123456',
      from: sender.id,
      peerSessionId: 'peer_new',
      candidate,
    })
    await session.handleSignal({
      type: 'signal:offer',
      roomCode: '123456',
      from: sender.id,
      peerSessionId: 'peer_new',
      description: { type: 'offer', sdp: 'new-offer' },
    })

    expect(first.closed).toBe(true)
    expect(second.addedIce).toEqual([candidate])
  })
})
