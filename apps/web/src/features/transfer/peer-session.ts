import {
  DEFAULT_FILE_CHUNK_BYTES,
  MAX_FILE_BATCH_BYTES,
  MAX_FILE_COUNT,
  MAX_TEXT_CHARACTERS,
  encodeTransferMessage,
  parseFileChunkFrame,
  parseTransferMessage,
  sanitizeFileName,
  type FileDescriptor,
  type IceCandidateDto,
  type ParticipantRole,
  type PublicRoom,
  type SignalClientMessage,
  type SignalServerMessage,
  type TransferProtocolMessage,
} from '@p2p/contracts'

import {
  createFileTransferEngine,
  createStreamTombstones,
  resolveFileChunkSize,
  type StreamTombstones,
} from './file-transfer-engine'
import type { FileSelection } from './file-selection'

const CHANNEL_LABEL = 'p2p-transfer'
const CHANNEL_PROTOCOL = 'p2p-transfer.v2'
const DECISION_TIMEOUT_MS = 30_000
const RECEIPT_TIMEOUT_MS = 30_000
const CHUNK_INACTIVITY_TIMEOUT_MS = 60_000
const DISCONNECT_GRACE_MS = 5_000

type TimerHandle = ReturnType<typeof setTimeout>

export type DataChannelLike = {
  readonly label: string
  readonly protocol: string
  readyState: RTCDataChannelState
  binaryType: BinaryType
  bufferedAmount: number
  bufferedAmountLowThreshold: number
  onbufferedamountlow: (() => void) | null
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  send(data: string | ArrayBuffer): void
  close(): void
}

export type PeerConnectionLike = {
  connectionState: RTCPeerConnectionState
  localDescription: RTCSessionDescriptionInit | null
  remoteDescription: RTCSessionDescriptionInit | null
  sctp?: { maxMessageSize: number } | null
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

export type ReceivedFile = {
  fileId: string
  name: string
  mimeType: string
  byteLength: number
  lastModified: number
  blob: Blob
}

export type TransferOfferResult = {
  transferId: string
  peerIds: string[]
  peerCount: number
  unsupportedPeerIds: string[]
}

export type PeerSessionEvent =
  | { type: 'peer:state'; peerId: string; state: 'connecting' | 'ready' | 'closed' }
  | { type: 'transfer:text-received'; peerId: string; transferId: string; text: string }
  | { type: 'transfer:file-requested'; peerId: string; transferId: string; files: FileDescriptor[] }
  | { type: 'transfer:file-decision'; peerId: string; transferId: string; decision: 'accept' | 'reject' }
  | {
      type: 'transfer:file-progress'
      peerId: string
      transferId: string
      fileId: string
      direction: 'sending' | 'receiving'
      fileBytes: number
      fileTotalBytes: number
      batchBytes: number
      batchTotalBytes: number
    }
  | { type: 'transfer:file-receipt'; peerId: string; transferId: string; fileId: string }
  | { type: 'transfer:files-received'; peerId: string; transferId: string; files: ReceivedFile[] }
  | {
      type: 'transfer:terminal'
      peerId: string
      transferId: string
      outcome: 'completed' | 'rejected' | 'cancelled' | 'failed' | 'timed-out'
      code?: 'FILE_TRANSFER_UNSUPPORTED' | 'TRANSFER_ERROR'
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
  setTimer?: (handler: () => void, delay: number) => TimerHandle
  clearTimer?: (timer: TimerHandle) => void
}

type PeerEntry = {
  peerId: string
  peerSessionId: string
  connection: PeerConnectionLike
  channel?: DataChannelLike
  pendingIce: (IceCandidateDto | null)[]
  remoteDescriptionSet: boolean
  tombstones: StreamTombstones
  nextStreamId: number
  disconnectTimer?: TimerHandle
  closed: boolean
}

type PendingIncomingText = {
  text: string
  state: 'awaiting-ui'
  timer?: TimerHandle
}

type OutgoingTextPeer = {
  state: 'awaiting-receipt' | 'received' | 'cancelled' | 'failed'
  timer?: TimerHandle
  terminal: boolean
}

type OutgoingTextTransfer = {
  kind: 'text'
  peers: Map<string, OutgoingTextPeer>
}

type ReceiptWaiter = {
  fileId: string
  resolve(): void
  reject(reason: unknown): void
}

type OutgoingFilePeer = {
  state:
    | 'awaiting-decision'
    | 'sending'
    | 'draining'
    | 'awaiting-file-receipt'
    | 'received'
    | 'rejected'
    | 'cancelled'
    | 'failed'
  fileIndex: number
  descriptors: FileDescriptor[]
  abortController: AbortController
  timer?: TimerHandle
  receipt?: ReceiptWaiter
  terminal: boolean
}

type OutgoingFileTransfer = {
  kind: 'file'
  selections: readonly FileSelection[]
  peers: Map<string, OutgoingFilePeer>
  batchTotalBytes: number
}

type OutgoingTransfer = OutgoingTextTransfer | OutgoingFileTransfer

type IncomingFileBatch = {
  peerId: string
  transferId: string
  descriptors: FileDescriptor[]
  state: 'pending' | 'accepted' | 'receiving' | 'received'
  fileIndex: number
  nextChunkIndex: number
  fileBytes: number
  batchBytes: number
  parts: ArrayBuffer[]
  completedFiles: ReceivedFile[]
  timer?: TimerHandle
}

export type PeerSession = {
  syncRoom(room: PublicRoom): void
  handleSignal(message: SignalServerMessage): Promise<void>
  offerText(text: string): TransferOfferResult
  acknowledgeText(peerId: string, transferId: string): boolean
  discardText(peerId: string, transferId: string): boolean
  offerFiles(files: readonly FileSelection[]): TransferOfferResult
  acceptFiles(peerId: string, transferId: string): boolean
  rejectFiles(peerId: string, transferId: string): boolean
  cancelTransfer(transferId: string): boolean
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
    throw new Error('WebRTC session description is invalid')
  }

  return { type: expectedType, sdp: description.sdp }
}

const compoundKey = (peerId: string, transferId: string) =>
  peerId + '\u0000' + transferId

const isOpen = (entry: PeerEntry) =>
  !entry.closed && entry.channel?.readyState === 'open'

const errorReason = (message: string) => new Error(message)

const nextUint32 = (value: number) => value === 0xffff_ffff ? 1 : value + 1

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
  const incomingTexts = new Map<string, PendingIncomingText>()
  const incomingFileBatches = new Map<string, IncomingFileBatch>()
  const listeners = new Set<(event: PeerSessionEvent) => void>()
  const fileEngine = createFileTransferEngine()
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
  ) => emit({ type: 'error', peerId, transferId, code, message })

  const sendFrame = (entry: PeerEntry, message: TransferProtocolMessage) => {
    if (!isOpen(entry)) {
      emitError('Peer data channel is not ready', entry.peerId, message.transferId, 'TRANSFER_ERROR')
      return false
    }

    try {
      entry.channel?.send(encodeTransferMessage(message))
      return true
    } catch {
      emitError('Failed to send peer transfer frame', entry.peerId, message.transferId, 'TRANSFER_ERROR')
      return false
    }
  }

  const clearOwnedTimer = (owner: { timer?: TimerHandle }) => {
    if (owner.timer === undefined) return
    clearTimer(owner.timer)
    owner.timer = undefined
  }

  const maybeDeleteOutgoing = (transferId: string) => {
    const transfer = outgoingTransfers.get(transferId)
    const allTerminal = transfer?.kind === 'text'
      ? Array.from(transfer.peers.values()).every(peer => peer.terminal)
      : transfer?.kind === 'file'
        ? Array.from(transfer.peers.values()).every(peer => peer.terminal)
        : false
    if (allTerminal) {
      outgoingTransfers.delete(transferId)
    }
  }

  const finishTextPeer = (
    transferId: string,
    transfer: OutgoingTextTransfer,
    peerId: string,
    outcome: 'completed' | 'cancelled' | 'failed' | 'timed-out',
  ) => {
    const peer = transfer.peers.get(peerId)
    if (!peer || peer.terminal) return
    clearOwnedTimer(peer)
    peer.terminal = true
    peer.state = outcome === 'completed'
      ? 'received'
      : outcome === 'cancelled' || outcome === 'timed-out'
        ? 'cancelled'
        : 'failed'
    maybeDeleteOutgoing(transferId)
    emit({
      type: 'transfer:terminal',
      peerId,
      transferId,
      outcome,
      ...(outcome === 'failed' ? { code: 'TRANSFER_ERROR' as const } : {}),
    })
  }

  const finishFilePeer = (
    transferId: string,
    transfer: OutgoingFileTransfer,
    peerId: string,
    outcome: 'completed' | 'rejected' | 'cancelled' | 'failed' | 'timed-out',
  ) => {
    const peer = transfer.peers.get(peerId)
    if (!peer || peer.terminal) return
    clearOwnedTimer(peer)
    peer.terminal = true
    if (outcome !== 'completed' && !peer.abortController.signal.aborted) {
      peer.abortController.abort(errorReason('File transfer ended'))
    }
    const waiter = peer.receipt
    peer.receipt = undefined
    waiter?.reject(errorReason('File receipt wait ended'))
    peer.state = outcome === 'completed'
      ? 'received'
      : outcome === 'rejected'
        ? 'rejected'
        : outcome === 'cancelled' || outcome === 'timed-out'
          ? 'cancelled'
          : 'failed'
    maybeDeleteOutgoing(transferId)
    emit({
      type: 'transfer:terminal',
      peerId,
      transferId,
      outcome,
      ...(outcome === 'failed' ? { code: 'TRANSFER_ERROR' as const } : {}),
    })
  }

  const tombstoneBatch = (entry: PeerEntry, batch: IncomingFileBatch) => {
    for (const descriptor of batch.descriptors) entry.tombstones.add(descriptor.streamId)
  }

  const finishIncomingBatch = (
    entry: PeerEntry,
    batch: IncomingFileBatch,
    outcome: 'completed' | 'rejected' | 'cancelled' | 'failed' | 'timed-out',
  ) => {
    const key = compoundKey(entry.peerId, batch.transferId)
    if (incomingFileBatches.get(key) !== batch) return
    clearOwnedTimer(batch)
    incomingFileBatches.delete(key)
    if (outcome !== 'completed') tombstoneBatch(entry, batch)
    batch.parts = []
    if (outcome !== 'completed') batch.completedFiles = []
    emit({
      type: 'transfer:terminal',
      peerId: entry.peerId,
      transferId: batch.transferId,
      outcome,
      ...(outcome === 'failed' ? { code: 'TRANSFER_ERROR' as const } : {}),
    })
  }

  const failIncomingBatch = (
    entry: PeerEntry,
    batch: IncomingFileBatch,
    message: string,
    protocolCode: Extract<TransferProtocolMessage, { type: 'transfer:error' }>['code'] = 'CONTENT_MISMATCH',
  ) => {
    if (incomingFileBatches.get(compoundKey(entry.peerId, batch.transferId)) !== batch) return
    sendFrame(entry, { v: 2, type: 'transfer:error', transferId: batch.transferId, code: protocolCode })
    emitError(message, entry.peerId, batch.transferId, 'PROTOCOL_ERROR')
    finishIncomingBatch(entry, batch, 'failed')
  }

  const resetIncomingInactivity = (entry: PeerEntry, batch: IncomingFileBatch) => {
    clearOwnedTimer(batch)
    batch.timer = setTimer(() => {
      if (incomingFileBatches.get(compoundKey(entry.peerId, batch.transferId)) !== batch) return
      sendFrame(entry, { v: 2, type: 'transfer:cancel', transferId: batch.transferId })
      finishIncomingBatch(entry, batch, 'timed-out')
    }, CHUNK_INACTIVITY_TIMEOUT_MS)
  }

  const batchPrefixBytes = (descriptors: readonly FileDescriptor[], index: number) =>
    descriptors.slice(0, index).reduce((total, descriptor) => total + descriptor.byteLength, 0)

  const pumpFilePeer = async (
    transferId: string,
    transfer: OutgoingFileTransfer,
    entry: PeerEntry,
    peer: OutgoingFilePeer,
  ) => {
    try {
      while (!peer.terminal && peer.fileIndex < peer.descriptors.length) {
        const descriptor = peer.descriptors[peer.fileIndex]
        const selection = transfer.selections[peer.fileIndex]
        if (!descriptor || !selection) throw errorReason('File descriptor order is invalid')
        const prefixBytes = batchPrefixBytes(peer.descriptors, peer.fileIndex)

        peer.state = 'sending'
        if (!sendFrame(entry, {
          v: 2,
          type: 'transfer:file-start',
          transferId,
          fileId: descriptor.fileId,
          streamId: descriptor.streamId,
        })) throw errorReason('Failed to send file start')

        const resetPumpTimer = () => {
          clearOwnedTimer(peer)
          peer.timer = setTimer(() => {
            if (peer.terminal) return
            sendFrame(entry, { v: 2, type: 'transfer:cancel', transferId })
            finishFilePeer(transferId, transfer, entry.peerId, 'timed-out')
          }, CHUNK_INACTIVITY_TIMEOUT_MS)
        }
        resetPumpTimer()
        await fileEngine.sendFile({
          channel: entry.channel as DataChannelLike,
          descriptor,
          file: selection.file,
          signal: peer.abortController.signal,
          onProgress(fileBytes) {
            if (peer.terminal) return
            resetPumpTimer()
            emit({
              type: 'transfer:file-progress',
              peerId: entry.peerId,
              transferId,
              fileId: descriptor.fileId,
              direction: 'sending',
              fileBytes,
              fileTotalBytes: descriptor.byteLength,
              batchBytes: prefixBytes + fileBytes,
              batchTotalBytes: transfer.batchTotalBytes,
            })
          },
        })

        clearOwnedTimer(peer)
        peer.state = 'draining'
        resetPumpTimer()
        await fileEngine.waitForDrain(entry.channel as DataChannelLike, peer.abortController.signal)
        clearOwnedTimer(peer)
        if (peer.terminal) return

        peer.state = 'awaiting-file-receipt'
        const receipt = new Promise<void>((resolve, reject) => {
          peer.receipt = { fileId: descriptor.fileId, resolve, reject }
          peer.timer = setTimer(() => {
            if (peer.terminal || peer.receipt?.fileId !== descriptor.fileId) return
            sendFrame(entry, { v: 2, type: 'transfer:cancel', transferId })
            finishFilePeer(transferId, transfer, entry.peerId, 'timed-out')
          }, RECEIPT_TIMEOUT_MS)
        })
        if (!sendFrame(entry, {
          v: 2,
          type: 'transfer:file-end',
          transferId,
          fileId: descriptor.fileId,
          streamId: descriptor.streamId,
          chunkCount: descriptor.chunkCount,
          byteLength: descriptor.byteLength,
        })) throw errorReason('Failed to send file end')

        await receipt
        if (peer.terminal) return
        peer.fileIndex += 1
      }

      if (!peer.terminal) finishFilePeer(transferId, transfer, entry.peerId, 'completed')
    } catch {
      if (!peer.terminal) {
        sendFrame(entry, {
          v: 2,
          type: 'transfer:cancel',
          transferId,
        })
        finishFilePeer(transferId, transfer, entry.peerId, 'failed')
      }
    }
  }

  const activeIncomingBatch = (peerId: string) => {
    for (const batch of incomingFileBatches.values()) {
      if (batch.peerId === peerId) return batch
    }
    return undefined
  }

  const peerHasIncoming = (peerId: string) => {
    if (activeIncomingBatch(peerId)) return true
    const prefix = peerId + '\u0000'
    return Array.from(incomingTexts.keys()).some(key => key.startsWith(prefix))
  }

  const allocateStreamIds = (entry: PeerEntry, count: number) => {
    const active = new Set<number>()
    for (const transfer of outgoingTransfers.values()) {
      if (transfer.kind !== 'file') continue
      for (const descriptor of transfer.peers.get(entry.peerId)?.descriptors ?? []) {
        active.add(descriptor.streamId)
      }
    }
    const ids: number[] = []
    let candidate = entry.nextStreamId
    while (ids.length < count) {
      if (!entry.tombstones.has(candidate) && !active.has(candidate)) {
        ids.push(candidate)
        active.add(candidate)
      }
      candidate = nextUint32(candidate)
    }
    entry.nextStreamId = candidate
    return ids
  }

  const onBinaryFrame = (entry: PeerEntry, raw: ArrayBuffer) => {
    const parsed = parseFileChunkFrame(raw, DEFAULT_FILE_CHUNK_BYTES)
    if (!parsed.ok) {
      emitError(parsed.error.message, entry.peerId, undefined, 'PROTOCOL_ERROR')
      const batch = activeIncomingBatch(entry.peerId)
      if (batch) failIncomingBatch(entry, batch, parsed.error.message)
      return
    }
    if (entry.tombstones.has(parsed.frame.streamId)) return

    const batch = activeIncomingBatch(entry.peerId)
    if (!batch) {
      emitError('Binary chunk has no active file batch', entry.peerId, undefined, 'PROTOCOL_ERROR')
      return
    }
    const descriptor = batch.descriptors[batch.fileIndex]
    if (!descriptor || batch.state !== 'receiving') {
      failIncomingBatch(entry, batch, 'Binary chunk arrived before file start')
      return
    }
    const { frame } = parsed
    const remaining = descriptor.byteLength - batch.fileBytes
    const expectedBytes = Math.min(descriptor.chunkSize, remaining)
    if (
      frame.streamId !== descriptor.streamId
      || frame.chunkIndex !== batch.nextChunkIndex
      || batch.nextChunkIndex >= descriptor.chunkCount
      || expectedBytes <= 0
      || frame.payload.byteLength !== expectedBytes
    ) {
      failIncomingBatch(entry, batch, 'File chunk sequence or size does not match its descriptor')
      return
    }

    const copy = new Uint8Array(frame.payload.byteLength)
    copy.set(frame.payload)
    batch.parts.push(copy.buffer)
    batch.fileBytes += copy.byteLength
    batch.batchBytes += copy.byteLength
    batch.nextChunkIndex += 1
    resetIncomingInactivity(entry, batch)
    emit({
      type: 'transfer:file-progress',
      peerId: entry.peerId,
      transferId: batch.transferId,
      fileId: descriptor.fileId,
      direction: 'receiving',
      fileBytes: batch.fileBytes,
      fileTotalBytes: descriptor.byteLength,
      batchBytes: batch.batchBytes,
      batchTotalBytes: batch.descriptors.reduce((total, file) => total + file.byteLength, 0),
    })
  }

  const onControlFrame = (entry: PeerEntry, message: TransferProtocolMessage) => {
    if (message.type === 'transfer:text') {
      if (role !== 'receiver' || peerHasIncoming(entry.peerId)) {
        sendFrame(entry, { v: 2, type: 'transfer:error', transferId: message.transferId, code: 'INVALID_STATE' })
        return
      }
      const key = compoundKey(entry.peerId, message.transferId)
      const incoming: PendingIncomingText = { text: message.text, state: 'awaiting-ui' }
      incoming.timer = setTimer(() => {
        if (incomingTexts.get(key) !== incoming) return
        incomingTexts.delete(key)
        sendFrame(entry, { v: 2, type: 'transfer:error', transferId: message.transferId, code: 'INVALID_STATE' })
      }, RECEIPT_TIMEOUT_MS)
      incomingTexts.set(key, incoming)
      emit({ type: 'transfer:text-received', peerId: entry.peerId, transferId: message.transferId, text: message.text })
      return
    }

    if (message.type === 'transfer:file-request') {
      if (role !== 'receiver' || peerHasIncoming(entry.peerId)) {
        sendFrame(entry, { v: 2, type: 'transfer:error', transferId: message.transferId, code: 'INVALID_STATE' })
        return
      }
      const files = message.files.map(file => ({ ...file, name: sanitizeFileName(file.name) }))
      const batch: IncomingFileBatch = {
        peerId: entry.peerId,
        transferId: message.transferId,
        descriptors: files,
        state: 'pending',
        fileIndex: 0,
        nextChunkIndex: 0,
        fileBytes: 0,
        batchBytes: 0,
        parts: [],
        completedFiles: [],
      }
      const key = compoundKey(entry.peerId, message.transferId)
      batch.timer = setTimer(() => {
        if (incomingFileBatches.get(key) !== batch || batch.state !== 'pending') return
        sendFrame(entry, { v: 2, type: 'transfer:cancel', transferId: batch.transferId })
        finishIncomingBatch(entry, batch, 'timed-out')
      }, DECISION_TIMEOUT_MS)
      incomingFileBatches.set(key, batch)
      emit({ type: 'transfer:file-requested', peerId: entry.peerId, transferId: batch.transferId, files: files.map(file => ({ ...file })) })
      return
    }

    if (message.type === 'transfer:decision') {
      const transfer = outgoingTransfers.get(message.transferId)
      if (!transfer || transfer.kind !== 'file') return
      const peer = transfer.peers.get(entry.peerId)
      if (!peer || peer.terminal || peer.state !== 'awaiting-decision') return
      clearOwnedTimer(peer)
      emit({ type: 'transfer:file-decision', peerId: entry.peerId, transferId: message.transferId, decision: message.decision })
      if (message.decision === 'reject') {
        finishFilePeer(message.transferId, transfer, entry.peerId, 'rejected')
      } else {
        peer.state = 'sending'
        void pumpFilePeer(message.transferId, transfer, entry, peer)
      }
      return
    }

    if (message.type === 'transfer:file-start') {
      const batch = incomingFileBatches.get(compoundKey(entry.peerId, message.transferId))
      const descriptor = batch?.descriptors[batch.fileIndex]
      if (
        !batch
        || !descriptor
        || batch.state !== 'accepted'
        || message.fileId !== descriptor.fileId
        || message.streamId !== descriptor.streamId
      ) {
        if (batch) failIncomingBatch(entry, batch, 'File start does not match the expected descriptor')
        else sendFrame(entry, { v: 2, type: 'transfer:error', transferId: message.transferId, code: 'INVALID_STATE' })
        return
      }
      batch.state = 'receiving'
      batch.nextChunkIndex = 0
      batch.fileBytes = 0
      batch.parts = []
      resetIncomingInactivity(entry, batch)
      return
    }

    if (message.type === 'transfer:file-end') {
      const batch = incomingFileBatches.get(compoundKey(entry.peerId, message.transferId))
      const descriptor = batch?.descriptors[batch.fileIndex]
      if (
        !batch
        || !descriptor
        || batch.state !== 'receiving'
        || message.fileId !== descriptor.fileId
        || message.streamId !== descriptor.streamId
        || message.chunkCount !== descriptor.chunkCount
        || message.byteLength !== descriptor.byteLength
        || batch.nextChunkIndex !== descriptor.chunkCount
        || batch.fileBytes !== descriptor.byteLength
      ) {
        if (batch) failIncomingBatch(entry, batch, 'File end totals do not match the descriptor')
        else sendFrame(entry, { v: 2, type: 'transfer:error', transferId: message.transferId, code: 'INVALID_STATE' })
        return
      }

      clearOwnedTimer(batch)
      const received: ReceivedFile = {
        fileId: descriptor.fileId,
        name: descriptor.name,
        mimeType: descriptor.mimeType,
        byteLength: descriptor.byteLength,
        lastModified: descriptor.lastModified,
        blob: new Blob(batch.parts, { type: descriptor.mimeType }),
      }
      batch.completedFiles.push(received)
      batch.parts = []
      if (!sendFrame(entry, {
        v: 2,
        type: 'transfer:receipt',
        transferId: batch.transferId,
        kind: 'file',
        fileId: descriptor.fileId,
        status: 'received',
      })) {
        finishIncomingBatch(entry, batch, 'failed')
        return
      }

      batch.fileIndex += 1
      if (batch.fileIndex === batch.descriptors.length) {
        batch.state = 'received'
        emit({ type: 'transfer:files-received', peerId: entry.peerId, transferId: batch.transferId, files: [...batch.completedFiles] })
        finishIncomingBatch(entry, batch, 'completed')
      } else {
        batch.state = 'accepted'
        batch.nextChunkIndex = 0
        batch.fileBytes = 0
        resetIncomingInactivity(entry, batch)
      }
      return
    }

    if (message.type === 'transfer:receipt') {
      const transfer = outgoingTransfers.get(message.transferId)
      if (!transfer) return
      if (message.kind === 'text') {
        if (transfer.kind !== 'text') return
        const peer = transfer.peers.get(entry.peerId)
        if (!peer || peer.terminal || peer.state !== 'awaiting-receipt') return
        finishTextPeer(message.transferId, transfer, entry.peerId, 'completed')
        return
      }
      if (transfer.kind !== 'file') return
      const peer = transfer.peers.get(entry.peerId)
      if (
        !peer
        || peer.terminal
        || peer.state !== 'awaiting-file-receipt'
        || peer.receipt?.fileId !== message.fileId
      ) return
      clearOwnedTimer(peer)
      const waiter = peer.receipt
      peer.receipt = undefined
      emit({ type: 'transfer:file-receipt', peerId: entry.peerId, transferId: message.transferId, fileId: message.fileId })
      waiter.resolve()
      return
    }

    if (message.type === 'transfer:cancel') {
      const transfer = outgoingTransfers.get(message.transferId)
      if (transfer?.kind === 'text') finishTextPeer(message.transferId, transfer, entry.peerId, 'cancelled')
      if (transfer?.kind === 'file') finishFilePeer(message.transferId, transfer, entry.peerId, 'cancelled')
      const textKey = compoundKey(entry.peerId, message.transferId)
      const text = incomingTexts.get(textKey)
      if (text) {
        clearOwnedTimer(text)
        incomingTexts.delete(textKey)
      }
      const batch = incomingFileBatches.get(textKey)
      if (batch) finishIncomingBatch(entry, batch, 'cancelled')
      return
    }

    if (message.type === 'transfer:error') {
      const transfer = outgoingTransfers.get(message.transferId)
      if (transfer?.kind === 'text') finishTextPeer(message.transferId, transfer, entry.peerId, 'failed')
      if (transfer?.kind === 'file') finishFilePeer(message.transferId, transfer, entry.peerId, 'failed')
      const key = compoundKey(entry.peerId, message.transferId)
      const text = incomingTexts.get(key)
      if (text) {
        clearOwnedTimer(text)
        incomingTexts.delete(key)
      }
      const batch = incomingFileBatches.get(key)
      if (batch) finishIncomingBatch(entry, batch, 'failed')
      emitError('Remote peer reported a transfer error', entry.peerId, message.transferId, 'TRANSFER_ERROR')
    }
  }

  const cancelPeerTransfers = (entry: PeerEntry) => {
    for (const [transferId, transfer] of outgoingTransfers) {
      if (transfer.kind === 'text') finishTextPeer(transferId, transfer, entry.peerId, 'cancelled')
      else finishFilePeer(transferId, transfer, entry.peerId, 'cancelled')
    }
    const prefix = entry.peerId + '\u0000'
    for (const [key, text] of incomingTexts) {
      if (!key.startsWith(prefix)) continue
      clearOwnedTimer(text)
      incomingTexts.delete(key)
    }
    for (const batch of Array.from(incomingFileBatches.values())) {
      if (batch.peerId === entry.peerId) finishIncomingBatch(entry, batch, 'cancelled')
    }
  }

  const closePeer = (peerId: string) => {
    const entry = peers.get(peerId)
    if (!entry || entry.closed) return
    entry.closed = true
    if (entry.disconnectTimer !== undefined) clearTimer(entry.disconnectTimer)
    cancelPeerTransfers(entry)
    entry.channel?.close()
    entry.connection.close()
    entry.tombstones.clear()
    if (peers.get(peerId) === entry) peers.delete(peerId)
    earlyIce.delete(compoundKey(peerId, entry.peerSessionId))
    emit({ type: 'peer:state', peerId, state: 'closed' })
  }

  const bindChannel = (entry: PeerEntry, channel: DataChannelLike) => {
    if (channel.label !== CHANNEL_LABEL || channel.protocol !== CHANNEL_PROTOCOL) {
      channel.close()
      emitError('Unsupported peer data channel', entry.peerId, undefined, 'PROTOCOL_ERROR')
      return
    }
    const previousChannel = entry.channel
    if (previousChannel && previousChannel !== channel) {
      cancelPeerTransfers(entry)
      previousChannel.onopen = null
      previousChannel.onclose = null
      previousChannel.onerror = null
      previousChannel.onmessage = null
      previousChannel.onbufferedamountlow = null
      previousChannel.close()
    }
    entry.channel = channel
    channel.binaryType = 'arraybuffer'
    channel.onopen = () => {
      if (peers.get(entry.peerId) === entry && !entry.closed && entry.channel === channel) {
        emit({ type: 'peer:state', peerId: entry.peerId, state: 'ready' })
      }
    }
    channel.onclose = () => {
      if (peers.get(entry.peerId) === entry && !entry.closed && entry.channel === channel) {
        closePeer(entry.peerId)
      }
    }
    channel.onerror = () => {
      if (peers.get(entry.peerId) !== entry || entry.closed || entry.channel !== channel) return
      emitError('Peer data channel failed', entry.peerId)
      closePeer(entry.peerId)
    }
    channel.onmessage = event => {
      if (peers.get(entry.peerId) !== entry || entry.closed || entry.channel !== channel) return
      if (typeof event.data === 'string') {
        const parsed = parseTransferMessage(event.data)
        if (!parsed.ok) emitError(parsed.error.message, entry.peerId, undefined, 'PROTOCOL_ERROR')
        else onControlFrame(entry, parsed.message)
        return
      }
      if (event.data instanceof ArrayBuffer) {
        onBinaryFrame(entry, event.data)
        return
      }
      emitError('Unsupported data channel payload', entry.peerId, undefined, 'PROTOCOL_ERROR')
    }
    if (channel.readyState === 'open') channel.onopen()
  }

  const createEntry = (peerId: string, peerSessionId: string) => {
    const connection = createPeerConnection(rtcConfiguration)
    const entry: PeerEntry = {
      peerId,
      peerSessionId,
      connection,
      pendingIce: earlyIce.get(compoundKey(peerId, peerSessionId)) ?? [],
      remoteDescriptionSet: false,
      tombstones: createStreamTombstones({ setTimer, clearTimer }),
      nextStreamId: 1,
      closed: false,
    }
    earlyIce.delete(compoundKey(peerId, peerSessionId))
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
      sendSignal({ type: 'signal:ice', roomCode, to: peerId, peerSessionId, candidate })
    }
    connection.ondatachannel = event => {
      if (peers.get(peerId) !== entry || entry.closed) event.channel.close()
      else bindChannel(entry, event.channel)
    }
    connection.onconnectionstatechange = () => {
      if (peers.get(peerId) !== entry || entry.closed) return
      if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
        closePeer(peerId)
      } else if (connection.connectionState === 'disconnected') {
        if (entry.disconnectTimer === undefined) {
          entry.disconnectTimer = setTimer(() => {
            entry.disconnectTimer = undefined
            if (connection.connectionState === 'disconnected') closePeer(peerId)
          }, DISCONNECT_GRACE_MS)
        }
      } else if (entry.disconnectTimer !== undefined) {
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
    bindChannel(entry, entry.connection.createDataChannel(CHANNEL_LABEL, { ordered: true, protocol: CHANNEL_PROTOCOL }))
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
        emitError('Failed to create peer connection', peerId)
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
      if (role === 'receiver' && (!entry || entry.peerSessionId !== message.peerSessionId)) {
        const key = compoundKey(message.from, message.peerSessionId)
        const candidates = earlyIce.get(key) ?? []
        candidates.push(message.candidate)
        earlyIce.set(key, candidates)
      }
      return
    }
    if (!entry.remoteDescriptionSet) entry.pendingIce.push(message.candidate)
    else await entry.connection.addIceCandidate(message.candidate)
  }

  const assertCanOffer = () => {
    if (role !== 'sender') throw new Error('Only senders can start a transfer')
    if (outgoingTransfers.size > 0) throw new Error('Another transfer is already active')
  }

  const readyEntries = () => Array.from(peers.values()).filter(isOpen)

  return {
    syncRoom(room) {
      if (closed || room.code !== roomCode) return
      const expectedPeers = new Set(room.participants
        .filter(participant => participant.visitor.id !== selfId)
        .filter(participant => role === 'sender' ? participant.role === 'receiver' : participant.role === 'sender')
        .map(participant => participant.visitor.id))
      for (const peerId of peers.keys()) if (!expectedPeers.has(peerId)) closePeer(peerId)
      if (role === 'sender') for (const peerId of expectedPeers) createOfferer(peerId)
    },
    handleSignal(message) {
      signalQueue = signalQueue.then(() => handleSignalNow(message)).catch(() => {
        emitError('Failed to process WebRTC signaling', message.from)
      })
      return signalQueue
    },
    offerText(text) {
      assertCanOffer()
      if (!text || text.length > MAX_TEXT_CHARACTERS) {
        throw new Error(`Text must contain 1 to ${String(MAX_TEXT_CHARACTERS)} characters`)
      }
      const entries = readyEntries()
      if (entries.length === 0) throw new Error('No connected receivers')
      const transferId = createId('transfer')
      const transfer: OutgoingTextTransfer = { kind: 'text', peers: new Map() }
      for (const entry of entries) {
        transfer.peers.set(entry.peerId, {
          state: 'awaiting-receipt',
          terminal: false,
        })
      }
      outgoingTransfers.set(transferId, transfer)
      for (const entry of entries) {
        const peer = transfer.peers.get(entry.peerId) as OutgoingTextPeer
        peer.timer = setTimer(() => {
          if (peer.terminal) return
          sendFrame(entry, { v: 2, type: 'transfer:cancel', transferId })
          finishTextPeer(transferId, transfer, entry.peerId, 'timed-out')
        }, RECEIPT_TIMEOUT_MS)
        if (!sendFrame(entry, { v: 2, type: 'transfer:text', transferId, text })) {
          finishTextPeer(transferId, transfer, entry.peerId, 'failed')
        }
      }
      return { transferId, peerIds: entries.map(entry => entry.peerId), peerCount: entries.length, unsupportedPeerIds: [] }
    },
    acknowledgeText(peerId, transferId) {
      const key = compoundKey(peerId, transferId)
      const incoming = incomingTexts.get(key)
      const entry = peers.get(peerId)
      if (!incoming || incoming.state !== 'awaiting-ui' || !entry) return false
      clearOwnedTimer(incoming)
      incomingTexts.delete(key)
      return sendFrame(entry, { v: 2, type: 'transfer:receipt', transferId, kind: 'text', status: 'received' })
    },
    discardText(peerId, transferId) {
      const key = compoundKey(peerId, transferId)
      const incoming = incomingTexts.get(key)
      const entry = peers.get(peerId)
      if (!incoming || incoming.state !== 'awaiting-ui' || !entry) return false
      clearOwnedTimer(incoming)
      incomingTexts.delete(key)
      return sendFrame(entry, { v: 2, type: 'transfer:error', transferId, code: 'INVALID_STATE' })
    },
    offerFiles(files) {
      assertCanOffer()
      if (files.length === 0 || files.length > MAX_FILE_COUNT) throw new Error('File batch count is invalid')
      const batchTotalBytes = files.reduce((total, selection) => total + selection.file.size, 0)
      if (!Number.isSafeInteger(batchTotalBytes) || batchTotalBytes > MAX_FILE_BATCH_BYTES) {
        throw new Error('File batch is too large')
      }
      const entries = readyEntries()
      if (entries.length === 0) throw new Error('No connected receivers')
      const transferId = createId('transfer')
      const transfer: OutgoingFileTransfer = { kind: 'file', selections: [...files], peers: new Map(), batchTotalBytes }
      const unsupportedPeerIds: string[] = []
      const offeredPeerIds: string[] = []
      for (const entry of entries) {
        const maximum = entry.connection.sctp?.maxMessageSize
        const chunkResult = resolveFileChunkSize(maximum !== undefined && Number.isFinite(maximum) ? maximum : undefined)
        if (!chunkResult.ok) {
          unsupportedPeerIds.push(entry.peerId)
          continue
        }
        const streamIds = allocateStreamIds(entry, files.length)
        const descriptors = files.map((selection, index): FileDescriptor => ({
          fileId: selection.fileId,
          streamId: streamIds[index] as number,
          name: sanitizeFileName(selection.file.name),
          mimeType: selection.file.type,
          byteLength: selection.file.size,
          lastModified: selection.file.lastModified,
          chunkSize: chunkResult.chunkSize,
          chunkCount: Math.ceil(selection.file.size / chunkResult.chunkSize),
        }))
        const peer: OutgoingFilePeer = {
          state: 'awaiting-decision',
          fileIndex: 0,
          descriptors,
          abortController: new AbortController(),
          terminal: false,
        }
        transfer.peers.set(entry.peerId, peer)
      }
      if (transfer.peers.size > 0) outgoingTransfers.set(transferId, transfer)
      for (const entry of entries) {
        const peer = transfer.peers.get(entry.peerId)
        if (!peer) continue
        const descriptors = peer.descriptors
        peer.timer = setTimer(() => {
          if (peer.terminal || peer.state !== 'awaiting-decision') return
          sendFrame(entry, { v: 2, type: 'transfer:cancel', transferId })
          finishFilePeer(transferId, transfer, entry.peerId, 'timed-out')
        }, DECISION_TIMEOUT_MS)
        if (!sendFrame(entry, { v: 2, type: 'transfer:file-request', transferId, files: descriptors })) {
          finishFilePeer(transferId, transfer, entry.peerId, 'failed')
          continue
        }
        offeredPeerIds.push(entry.peerId)
      }
      if (transfer.peers.size === 0 || Array.from(transfer.peers.values()).every(peer => peer.terminal)) {
        outgoingTransfers.delete(transferId)
      }
      return {
        transferId,
        peerIds: entries.map(entry => entry.peerId),
        peerCount: offeredPeerIds.length,
        unsupportedPeerIds,
      }
    },
    acceptFiles(peerId, transferId) {
      const entry = peers.get(peerId)
      const batch = incomingFileBatches.get(compoundKey(peerId, transferId))
      if (!entry || !batch || batch.state !== 'pending') return false
      clearOwnedTimer(batch)
      batch.state = 'accepted'
      if (!sendFrame(entry, { v: 2, type: 'transfer:decision', transferId, decision: 'accept' })) {
        finishIncomingBatch(entry, batch, 'failed')
        return false
      }
      resetIncomingInactivity(entry, batch)
      return true
    },
    rejectFiles(peerId, transferId) {
      const entry = peers.get(peerId)
      const batch = incomingFileBatches.get(compoundKey(peerId, transferId))
      if (!entry || !batch || batch.state !== 'pending') return false
      clearOwnedTimer(batch)
      const sent = sendFrame(entry, { v: 2, type: 'transfer:decision', transferId, decision: 'reject' })
      finishIncomingBatch(entry, batch, 'rejected')
      return sent
    },
    cancelTransfer(transferId) {
      let cancelled = false
      const transfer = outgoingTransfers.get(transferId)
      if (transfer) {
        for (const [peerId, peer] of transfer.peers) {
          if (peer.terminal) continue
          const entry = peers.get(peerId)
          if (entry) sendFrame(entry, { v: 2, type: 'transfer:cancel', transferId })
          if (transfer.kind === 'text') finishTextPeer(transferId, transfer, peerId, 'cancelled')
          else finishFilePeer(transferId, transfer, peerId, 'cancelled')
          cancelled = true
        }
      }
      for (const [key, text] of Array.from(incomingTexts)) {
        if (!key.endsWith('\u0000' + transferId)) continue
        const peerId = key.slice(0, key.indexOf('\u0000'))
        clearOwnedTimer(text)
        incomingTexts.delete(key)
        const entry = peers.get(peerId)
        if (entry) sendFrame(entry, { v: 2, type: 'transfer:cancel', transferId })
        cancelled = true
      }
      for (const batch of Array.from(incomingFileBatches.values())) {
        if (batch.transferId !== transferId) continue
        const entry = peers.get(batch.peerId)
        if (!entry) continue
        sendFrame(entry, { v: 2, type: 'transfer:cancel', transferId })
        finishIncomingBatch(entry, batch, 'cancelled')
        cancelled = true
      }
      return cancelled
    },
    readyPeerCount() {
      return readyEntries().length
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      if (closed) return
      closed = true
      for (const peerId of Array.from(peers.keys())) closePeer(peerId)
      for (const text of incomingTexts.values()) clearOwnedTimer(text)
      for (const batch of incomingFileBatches.values()) clearOwnedTimer(batch)
      incomingTexts.clear()
      incomingFileBatches.clear()
      outgoingTransfers.clear()
      earlyIce.clear()
      fileEngine.close()
      listeners.clear()
    },
  }
}
