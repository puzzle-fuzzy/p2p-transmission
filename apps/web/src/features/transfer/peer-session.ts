import {
  encodeTransferMessage,
  parseTransferMessage,
  textByteLength,
  type IceCandidateDto,
  type ParticipantRole,
  type PublicRoom,
  type SignalClientMessage,
  type SignalServerMessage,
  type TransferProtocolMessage,
} from '@p2p/contracts'

const CHANNEL_LABEL = 'p2p-transfer'
const CHANNEL_PROTOCOL = 'p2p-transfer.v1'
const DECISION_TIMEOUT_MS = 30_000
const PAYLOAD_TIMEOUT_MS = 15_000
const DISCONNECT_GRACE_MS = 5_000

export type DataChannelLike = {
  readonly label: string
  readonly protocol: string
  readyState: RTCDataChannelState
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  send(data: string): void
  close(): void
}

export type PeerConnectionLike = {
  connectionState: RTCPeerConnectionState
  localDescription: RTCSessionDescriptionInit | null
  remoteDescription: RTCSessionDescriptionInit | null
  onicecandidate: ((event: {
    candidate: {
      candidate: string
      sdpMid: string | null
      sdpMLineIndex: number | null
      usernameFragment: string | null
    } | null
  }) => void) | null
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null
  onconnectionstatechange: (() => void) | null
  createDataChannel(label: string, options?: RTCDataChannelInit): DataChannelLike
  createOffer(): Promise<RTCSessionDescriptionInit>
  createAnswer(): Promise<RTCSessionDescriptionInit>
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>
  addIceCandidate(candidate: IceCandidateDto | null): Promise<void>
  close(): void
}

export type IncomingTextRequest = {
  transferId: string
  characterCount: number
  byteLength: number
}

export type PeerSessionEvent =
  | {
      type: 'peer:state'
      peerId: string
      state: 'connecting' | 'ready' | 'closed'
    }
  | {
      type: 'transfer:request'
      peerId: string
      request: IncomingTextRequest
    }
  | {
      type: 'transfer:decision'
      peerId: string
      transferId: string
      decision: 'accept' | 'reject'
    }
  | {
      type: 'transfer:received'
      peerId: string
      transferId: string
      text: string
    }
  | {
      type: 'transfer:receipt'
      peerId: string
      transferId: string
    }
  | {
      type: 'transfer:cancelled'
      peerId: string
      transferId: string
      reason: 'timeout' | 'remote' | 'peer-closed'
    }
  | {
      type: 'error'
      peerId?: string
      transferId?: string
      code: 'PEER_ERROR' | 'PROTOCOL_ERROR' | 'TRANSFER_ERROR'
      message: string
    }

type PeerSessionOptions = {
  selfId: string
  roomCode: string
  role: ParticipantRole
  rtcConfiguration?: RTCConfiguration
  sendSignal(message: SignalClientMessage): void
  createPeerConnection?: (configuration: RTCConfiguration) => PeerConnectionLike
  createId?: (prefix: 'peer' | 'transfer') => string
  setTimer?: (handler: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

type PeerEntry = {
  peerId: string
  peerSessionId: string
  connection: PeerConnectionLike
  channel?: DataChannelLike
  pendingIce: (IceCandidateDto | null)[]
  remoteDescriptionSet: boolean
  disconnectTimer?: ReturnType<typeof setTimeout>
  closed: boolean
}

type OutgoingPeerState = {
  state: 'awaiting-decision' | 'awaiting-receipt' | 'received' | 'rejected' | 'cancelled'
  timer?: ReturnType<typeof setTimeout>
}

type OutgoingTransfer = {
  text: string
  peers: Map<string, OutgoingPeerState>
}

type IncomingTransfer = {
  request: IncomingTextRequest
  state: 'pending' | 'accepted'
  timer?: ReturnType<typeof setTimeout>
}

export type PeerSession = {
  syncRoom(room: PublicRoom): void
  handleSignal(message: SignalServerMessage): Promise<void>
  offerText(text: string): { transferId: string; peerCount: number }
  acceptText(peerId: string, transferId: string): boolean
  rejectText(peerId: string, transferId: string): boolean
  readyPeerCount(): number
  subscribe(listener: (event: PeerSessionEvent) => void): () => void
  close(): void
}

const defaultCreatePeerConnection = (configuration: RTCConfiguration) =>
  new RTCPeerConnection(configuration) as unknown as PeerConnectionLike

const defaultCreateId = (prefix: 'peer' | 'transfer') =>
  prefix + '_' + crypto.randomUUID()

const descriptionDto = <Type extends 'offer' | 'answer'>(
  description: RTCSessionDescriptionInit,
  expectedType: Type,
): { type: Type; sdp: string } => {
  if (description.type !== expectedType || !description.sdp) {
    throw new Error('WebRTC 会话描述无效')
  }

  return {
    type: expectedType,
    sdp: description.sdp,
  }
}

const incomingKey = (peerId: string, transferId: string) =>
  peerId + '\u0000' + transferId

export const createPeerSession = ({
  selfId,
  roomCode,
  role,
  rtcConfiguration = {},
  sendSignal,
  createPeerConnection = defaultCreatePeerConnection,
  createId = defaultCreateId,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: PeerSessionOptions): PeerSession => {
  const peers = new Map<string, PeerEntry>()
  const earlyIce = new Map<string, (IceCandidateDto | null)[]>()
  const outgoingTransfers = new Map<string, OutgoingTransfer>()
  const incomingTransfers = new Map<string, IncomingTransfer>()
  const listeners = new Set<(event: PeerSessionEvent) => void>()
  let signalQueue = Promise.resolve()
  let closed = false

  const emit = (event: PeerSessionEvent) => {
    for (const listener of listeners) listener(event)
  }

  const emitError = (
    message: string,
    peerId?: string,
    transferId?: string,
    code: 'PEER_ERROR' | 'PROTOCOL_ERROR' | 'TRANSFER_ERROR' = 'PEER_ERROR',
  ) => {
    emit({
      type: 'error',
      peerId,
      transferId,
      code,
      message,
    })
  }

  const sendFrame = (
    entry: PeerEntry,
    message: TransferProtocolMessage,
  ) => {
    if (entry.channel?.readyState !== 'open') {
      emitError('点对点连接尚未就绪', entry.peerId, message.transferId, 'TRANSFER_ERROR')
      return false
    }

    try {
      entry.channel.send(encodeTransferMessage(message))
      return true
    } catch {
      emitError('发送点对点消息失败', entry.peerId, message.transferId, 'TRANSFER_ERROR')
      return false
    }
  }

  const clearOutgoingTimer = (state: OutgoingPeerState) => {
    if (state.timer === undefined) return
    clearTimer(state.timer)
    state.timer = undefined
  }

  const maybeDeleteOutgoing = (transferId: string) => {
    const transfer = outgoingTransfers.get(transferId)
    if (!transfer) return

    const active = Array.from(transfer.peers.values()).some(state =>
      state.state === 'awaiting-decision' || state.state === 'awaiting-receipt')
    if (!active) outgoingTransfers.delete(transferId)
  }

  const cancelPeerTransfers = (peerId: string) => {
    for (const [transferId, transfer] of outgoingTransfers) {
      const state = transfer.peers.get(peerId)
      if (!state || state.state === 'received' || state.state === 'rejected' || state.state === 'cancelled') {
        continue
      }

      clearOutgoingTimer(state)
      state.state = 'cancelled'
      emit({
        type: 'transfer:cancelled',
        peerId,
        transferId,
        reason: 'peer-closed',
      })
      maybeDeleteOutgoing(transferId)
    }

    for (const [key, transfer] of incomingTransfers) {
      if (!key.startsWith(peerId + '\u0000')) continue
      if (transfer.timer !== undefined) clearTimer(transfer.timer)
      const transferId = key.slice(peerId.length + 1)
      incomingTransfers.delete(key)
      emit({
        type: 'transfer:cancelled',
        peerId,
        transferId,
        reason: 'peer-closed',
      })
    }
  }

  const closePeer = (peerId: string) => {
    const entry = peers.get(peerId)
    if (!entry || entry.closed) return
    entry.closed = true

    if (entry.disconnectTimer !== undefined) clearTimer(entry.disconnectTimer)
    entry.channel?.close()
    entry.connection.close()
    if (peers.get(peerId) === entry) peers.delete(peerId)
    earlyIce.delete(incomingKey(peerId, entry.peerSessionId))
    cancelPeerTransfers(peerId)
    emit({ type: 'peer:state', peerId, state: 'closed' })
  }

  const onTransferMessage = (
    entry: PeerEntry,
    message: TransferProtocolMessage,
  ) => {
    if (message.type === 'transfer:request') {
      if (role !== 'receiver') {
        sendFrame(entry, {
          v: 1,
          type: 'transfer:error',
          transferId: message.transferId,
          code: 'INVALID_STATE',
        })
        return
      }

      const key = incomingKey(entry.peerId, message.transferId)
      if (incomingTransfers.has(key)) return
      const incoming: IncomingTransfer = {
        request: {
          transferId: message.transferId,
          characterCount: message.characterCount,
          byteLength: message.byteLength,
        },
        state: 'pending',
      }
      incoming.timer = setTimer(() => {
        if (incomingTransfers.get(key) !== incoming || incoming.state !== 'pending') return
        incomingTransfers.delete(key)
        emit({
          type: 'transfer:cancelled',
          peerId: entry.peerId,
          transferId: message.transferId,
          reason: 'timeout',
        })
      }, DECISION_TIMEOUT_MS)
      incomingTransfers.set(key, incoming)
      emit({
        type: 'transfer:request',
        peerId: entry.peerId,
        request: incoming.request,
      })
      return
    }

    if (message.type === 'transfer:decision') {
      if (role !== 'sender') return
      const transfer = outgoingTransfers.get(message.transferId)
      const peerState = transfer?.peers.get(entry.peerId)
      if (!transfer || !peerState || peerState.state !== 'awaiting-decision') return
      clearOutgoingTimer(peerState)

      if (message.decision === 'reject') {
        peerState.state = 'rejected'
        emit({
          type: 'transfer:decision',
          peerId: entry.peerId,
          transferId: message.transferId,
          decision: 'reject',
        })
        maybeDeleteOutgoing(message.transferId)
        return
      }

      peerState.state = 'awaiting-receipt'
      emit({
        type: 'transfer:decision',
        peerId: entry.peerId,
        transferId: message.transferId,
        decision: 'accept',
      })
      if (!sendFrame(entry, {
        v: 1,
        type: 'transfer:text',
        transferId: message.transferId,
        text: transfer.text,
      })) {
        peerState.state = 'cancelled'
        maybeDeleteOutgoing(message.transferId)
        return
      }
      peerState.timer = setTimer(() => {
        if (peerState.state !== 'awaiting-receipt') return
        peerState.state = 'cancelled'
        sendFrame(entry, {
          v: 1,
          type: 'transfer:cancel',
          transferId: message.transferId,
        })
        emit({
          type: 'transfer:cancelled',
          peerId: entry.peerId,
          transferId: message.transferId,
          reason: 'timeout',
        })
        maybeDeleteOutgoing(message.transferId)
      }, PAYLOAD_TIMEOUT_MS)
      return
    }

    if (message.type === 'transfer:text') {
      const key = incomingKey(entry.peerId, message.transferId)
      const incoming = incomingTransfers.get(key)
      if (!incoming || incoming.state !== 'accepted') {
        sendFrame(entry, {
          v: 1,
          type: 'transfer:error',
          transferId: message.transferId,
          code: 'INVALID_STATE',
        })
        return
      }

      const countsMatch =
        message.text.length === incoming.request.characterCount
        && textByteLength(message.text) === incoming.request.byteLength
      if (!countsMatch) {
        if (incoming.timer !== undefined) clearTimer(incoming.timer)
        incomingTransfers.delete(key)
        sendFrame(entry, {
          v: 1,
          type: 'transfer:error',
          transferId: message.transferId,
          code: 'CONTENT_MISMATCH',
        })
        emitError(
          '接收文本与请求信息不匹配',
          entry.peerId,
          message.transferId,
          'PROTOCOL_ERROR',
        )
        return
      }

      if (incoming.timer !== undefined) clearTimer(incoming.timer)
      incomingTransfers.delete(key)
      sendFrame(entry, {
        v: 1,
        type: 'transfer:receipt',
        transferId: message.transferId,
        status: 'received',
      })
      emit({
        type: 'transfer:received',
        peerId: entry.peerId,
        transferId: message.transferId,
        text: message.text,
      })
      return
    }

    if (message.type === 'transfer:receipt') {
      const transfer = outgoingTransfers.get(message.transferId)
      const peerState = transfer?.peers.get(entry.peerId)
      if (!transfer || !peerState || peerState.state !== 'awaiting-receipt') return
      clearOutgoingTimer(peerState)
      peerState.state = 'received'
      emit({
        type: 'transfer:receipt',
        peerId: entry.peerId,
        transferId: message.transferId,
      })
      maybeDeleteOutgoing(message.transferId)
      return
    }

    if (message.type === 'transfer:cancel') {
      const key = incomingKey(entry.peerId, message.transferId)
      const incoming = incomingTransfers.get(key)
      if (incoming?.timer !== undefined) clearTimer(incoming.timer)
      incomingTransfers.delete(key)
      emit({
        type: 'transfer:cancelled',
        peerId: entry.peerId,
        transferId: message.transferId,
        reason: 'remote',
      })
      return
    }

    const outgoing = outgoingTransfers.get(message.transferId)
    const outgoingPeer = outgoing?.peers.get(entry.peerId)
    if (outgoingPeer) {
      clearOutgoingTimer(outgoingPeer)
      outgoingPeer.state = 'cancelled'
      maybeDeleteOutgoing(message.transferId)
    }
    const key = incomingKey(entry.peerId, message.transferId)
    const incoming = incomingTransfers.get(key)
    if (incoming?.timer !== undefined) clearTimer(incoming.timer)
    incomingTransfers.delete(key)
    emitError(
      '远端报告传输协议错误',
      entry.peerId,
      message.transferId,
      'TRANSFER_ERROR',
    )
  }

  const bindChannel = (entry: PeerEntry, channel: DataChannelLike) => {
    if (channel.label !== CHANNEL_LABEL || channel.protocol !== CHANNEL_PROTOCOL) {
      channel.close()
      emitError('收到不受支持的点对点通道', entry.peerId, undefined, 'PROTOCOL_ERROR')
      return
    }

    entry.channel = channel
    channel.onopen = () => {
      if (peers.get(entry.peerId) !== entry || entry.closed || entry.channel !== channel) return
      emit({ type: 'peer:state', peerId: entry.peerId, state: 'ready' })
    }
    channel.onclose = () => {
      if (peers.get(entry.peerId) === entry && !entry.closed) closePeer(entry.peerId)
    }
    channel.onerror = () => {
      if (peers.get(entry.peerId) !== entry || entry.closed) return
      emitError('点对点数据通道发生错误', entry.peerId)
      closePeer(entry.peerId)
    }
    channel.onmessage = event => {
      if (peers.get(entry.peerId) !== entry || entry.closed) return
      if (typeof event.data !== 'string') {
        emitError('收到不支持的二进制协议帧', entry.peerId, undefined, 'PROTOCOL_ERROR')
        return
      }

      const parsed = parseTransferMessage(event.data)
      if (!parsed.ok) {
        emitError(parsed.error.message, entry.peerId, undefined, 'PROTOCOL_ERROR')
        return
      }

      onTransferMessage(entry, parsed.message)
    }

    if (channel.readyState === 'open') channel.onopen()
  }

  const createEntry = (peerId: string, peerSessionId: string) => {
    const connection = createPeerConnection(rtcConfiguration)
    const entry: PeerEntry = {
      peerId,
      peerSessionId,
      connection,
      pendingIce: earlyIce.get(incomingKey(peerId, peerSessionId)) ?? [],
      remoteDescriptionSet: false,
      closed: false,
    }
    earlyIce.delete(incomingKey(peerId, peerSessionId))

    connection.onicecandidate = event => {
      if (peers.get(peerId) !== entry || entry.closed) return
      const candidate = event.candidate
        ? {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            usernameFragment: event.candidate.usernameFragment,
          }
        : null
      sendSignal({
        type: 'signal:ice',
        roomCode,
        to: peerId,
        peerSessionId,
        candidate,
      })
    }
    connection.ondatachannel = event => {
      if (peers.get(peerId) !== entry || entry.closed) {
        event.channel.close()
        return
      }
      bindChannel(entry, event.channel)
    }
    connection.onconnectionstatechange = () => {
      if (peers.get(peerId) !== entry || entry.closed) return
      if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
        closePeer(peerId)
        return
      }
      if (connection.connectionState === 'disconnected') {
        if (entry.disconnectTimer !== undefined) return
        entry.disconnectTimer = setTimer(() => {
          entry.disconnectTimer = undefined
          if (connection.connectionState === 'disconnected') closePeer(peerId)
        }, DISCONNECT_GRACE_MS)
        return
      }
      if (entry.disconnectTimer !== undefined) {
        clearTimer(entry.disconnectTimer)
        entry.disconnectTimer = undefined
      }
    }

    peers.set(peerId, entry)
    emit({ type: 'peer:state', peerId, state: 'connecting' })
    return entry
  }

  const flushIce = async (entry: PeerEntry) => {
    for (const candidate of entry.pendingIce.splice(0)) {
      if (peers.get(entry.peerId) !== entry || entry.closed) return
      await entry.connection.addIceCandidate(candidate)
    }
  }

  const createOfferer = (peerId: string) => {
    if (closed || peers.has(peerId)) return
    const peerSessionId = createId('peer')
    const entry = createEntry(peerId, peerSessionId)
    const channel = entry.connection.createDataChannel(CHANNEL_LABEL, {
      ordered: true,
      protocol: CHANNEL_PROTOCOL,
    })
    bindChannel(entry, channel)

    void (async () => {
      try {
        const offer = await entry.connection.createOffer()
        if (peers.get(peerId) !== entry || entry.closed) return
        await entry.connection.setLocalDescription(offer)
        if (peers.get(peerId) !== entry || entry.closed) return
        sendSignal({
          type: 'signal:offer',
          roomCode,
          to: peerId,
          peerSessionId,
          description: descriptionDto(entry.connection.localDescription ?? offer, 'offer'),
        })
      } catch {
        emitError('创建点对点连接失败', peerId)
        closePeer(peerId)
      }
    })()
  }

  const handleSignalNow = async (message: SignalServerMessage) => {
    if (closed || message.roomCode !== roomCode) return

    if (message.type === 'signal:offer') {
      if (role !== 'receiver') return
      const current = peers.get(message.from)
      if (current?.peerSessionId === message.peerSessionId) return
      if (current) closePeer(message.from)

      const entry = createEntry(message.from, message.peerSessionId)
      await entry.connection.setRemoteDescription(message.description)
      if (peers.get(message.from) !== entry || entry.closed) return
      entry.remoteDescriptionSet = true
      await flushIce(entry)
      const answer = await entry.connection.createAnswer()
      await entry.connection.setLocalDescription(answer)
      if (peers.get(message.from) !== entry || entry.closed) return
      sendSignal({
        type: 'signal:answer',
        roomCode,
        to: message.from,
        peerSessionId: message.peerSessionId,
        description: descriptionDto(entry.connection.localDescription ?? answer, 'answer'),
      })
      return
    }

    if (message.type === 'signal:answer') {
      if (role !== 'sender') return
      const entry = peers.get(message.from)
      if (!entry || entry.peerSessionId !== message.peerSessionId || entry.closed) return
      await entry.connection.setRemoteDescription(message.description)
      if (peers.get(message.from) !== entry || entry.closed) return
      entry.remoteDescriptionSet = true
      await flushIce(entry)
      return
    }

    const entry = peers.get(message.from)
    if (!entry || entry.peerSessionId !== message.peerSessionId || entry.closed) {
      if (role === 'receiver' && !entry) {
        const key = incomingKey(message.from, message.peerSessionId)
        const candidates = earlyIce.get(key) ?? []
        candidates.push(message.candidate)
        earlyIce.set(key, candidates)
      }
      return
    }

    if (!entry.remoteDescriptionSet) {
      entry.pendingIce.push(message.candidate)
      return
    }

    await entry.connection.addIceCandidate(message.candidate)
  }

  return {
    syncRoom(room) {
      if (closed || room.code !== roomCode) return
      const expectedPeers = new Set(
        room.participants
          .filter(participant => participant.visitor.id !== selfId)
          .filter(participant =>
            role === 'sender'
              ? participant.role === 'receiver'
              : participant.role === 'sender')
          .map(participant => participant.visitor.id),
      )

      for (const peerId of peers.keys()) {
        if (!expectedPeers.has(peerId)) closePeer(peerId)
      }
      if (role === 'sender') {
        for (const peerId of expectedPeers) createOfferer(peerId)
      }
    },
    handleSignal(message) {
      signalQueue = signalQueue
        .then(() => handleSignalNow(message))
        .catch(() => {
          emitError('处理 WebRTC 信令失败', message.from)
        })
      return signalQueue
    },
    offerText(text) {
      if (role !== 'sender') throw new Error('只有发送者可以发起传输')
      if (!text || text.length > 500) throw new Error('文本长度必须在 1 到 500 个字符之间')

      const readyEntries = Array.from(peers.values())
        .filter(entry => entry.channel?.readyState === 'open' && !entry.closed)
      if (readyEntries.length === 0) throw new Error('当前没有已连接的接收者')

      const transferId = createId('transfer')
      const transfer: OutgoingTransfer = {
        text,
        peers: new Map(),
      }
      outgoingTransfers.set(transferId, transfer)
      const request: TransferProtocolMessage = {
        v: 1,
        type: 'transfer:request',
        transferId,
        kind: 'text',
        characterCount: text.length,
        byteLength: textByteLength(text),
      }

      for (const entry of readyEntries) {
        const peerState: OutgoingPeerState = { state: 'awaiting-decision' }
        transfer.peers.set(entry.peerId, peerState)
        if (!sendFrame(entry, request)) {
          peerState.state = 'cancelled'
          continue
        }
        peerState.timer = setTimer(() => {
          if (peerState.state !== 'awaiting-decision') return
          peerState.state = 'cancelled'
          sendFrame(entry, {
            v: 1,
            type: 'transfer:cancel',
            transferId,
          })
          emit({
            type: 'transfer:cancelled',
            peerId: entry.peerId,
            transferId,
            reason: 'timeout',
          })
          maybeDeleteOutgoing(transferId)
        }, DECISION_TIMEOUT_MS)
      }

      maybeDeleteOutgoing(transferId)
      return { transferId, peerCount: readyEntries.length }
    },
    acceptText(peerId, transferId) {
      const key = incomingKey(peerId, transferId)
      const incoming = incomingTransfers.get(key)
      const entry = peers.get(peerId)
      if (!incoming || incoming.state !== 'pending' || !entry) return false
      if (incoming.timer !== undefined) clearTimer(incoming.timer)
      incoming.state = 'accepted'
      if (!sendFrame(entry, {
        v: 1,
        type: 'transfer:decision',
        transferId,
        decision: 'accept',
      })) {
        incomingTransfers.delete(key)
        return false
      }
      incoming.timer = setTimer(() => {
        if (incomingTransfers.get(key) !== incoming || incoming.state !== 'accepted') return
        incomingTransfers.delete(key)
        sendFrame(entry, {
          v: 1,
          type: 'transfer:error',
          transferId,
          code: 'INVALID_STATE',
        })
        emit({
          type: 'transfer:cancelled',
          peerId,
          transferId,
          reason: 'timeout',
        })
      }, PAYLOAD_TIMEOUT_MS)
      return true
    },
    rejectText(peerId, transferId) {
      const key = incomingKey(peerId, transferId)
      const incoming = incomingTransfers.get(key)
      const entry = peers.get(peerId)
      if (!incoming || incoming.state !== 'pending' || !entry) return false
      if (incoming.timer !== undefined) clearTimer(incoming.timer)
      incomingTransfers.delete(key)
      return sendFrame(entry, {
        v: 1,
        type: 'transfer:decision',
        transferId,
        decision: 'reject',
      })
    },
    readyPeerCount() {
      return Array.from(peers.values())
        .filter(entry => !entry.closed && entry.channel?.readyState === 'open')
        .length
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      if (closed) return
      closed = true
      for (const peerId of Array.from(peers.keys())) closePeer(peerId)
      for (const transfer of outgoingTransfers.values()) {
        for (const state of transfer.peers.values()) clearOutgoingTimer(state)
      }
      for (const incoming of incomingTransfers.values()) {
        if (incoming.timer !== undefined) clearTimer(incoming.timer)
      }
      outgoingTransfers.clear()
      incomingTransfers.clear()
      earlyIce.clear()
      listeners.clear()
    },
  }
}
