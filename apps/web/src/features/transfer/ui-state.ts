import type { PeerSessionEvent } from './peer-session'

export type TransferPhase =
  | 'idle'
  | 'requesting'
  | 'transferring'
  | 'complete'
  | 'error'

export type TransferPeerOutcome =
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'failed'
  | 'timed-out'

export type OutgoingPeerUiState = {
  accepted: boolean
  progress: number
  outcome?: TransferPeerOutcome
}

export type OutgoingFilePeerUiState = {
  progress: number
  outcome?: TransferPeerOutcome
}

export type OutgoingFileUiState = {
  state: 'queued' | 'transferring' | 'completed' | 'error'
  progress: number
  peers: Record<string, OutgoingFilePeerUiState>
}

export type OutgoingActivity = {
  generation: number
  transferId: string
  kind: 'text' | 'file'
  phase: Exclude<TransferPhase, 'idle'>
  peerIds: string[]
  peers: Record<string, OutgoingPeerUiState>
  files: Record<string, OutgoingFileUiState>
}

export type TransferUiState = {
  activity?: OutgoingActivity
}

export type TransferUiAction =
  | { type: 'activity:start'; activity: OutgoingActivity }
  | { type: 'peer-session:event'; event: PeerSessionEvent }
  | { type: 'terminal:clear'; generation: number; transferId: string }
  | { type: 'room:reset' }
  | { type: 'realtime:disconnected' }

export type CreateActivityInput = {
  generation: number
  transferId: string
  kind: 'text' | 'file'
  peerIds: readonly string[]
  unsupportedPeerIds?: readonly string[]
  fileIds?: readonly string[]
}

export type IncomingTextEvent = {
  type: 'transfer:text-received'
  peerId: string
  transferId: string
  text: string
}

export type IncomingTextPlan<Event extends IncomingTextEvent> = {
  queue: Event[]
  disposition: 'acknowledge' | 'discard'
}

export const initialTransferUiState: TransferUiState = {}

const clampProgress = (value: number) => {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

const ratio = (bytes: number, totalBytes: number) => {
  if (totalBytes <= 0) return 0
  return clampProgress(bytes / totalBytes)
}

const isTerminal = (peer: OutgoingPeerUiState) => peer.outcome !== undefined

const isErrorOutcome = (outcome?: TransferPeerOutcome) =>
  outcome === 'cancelled'
  || outcome === 'failed'
  || outcome === 'timed-out'

const derivePhase = (activity: OutgoingActivity): OutgoingActivity['phase'] => {
  const peers = activity.peerIds.flatMap(peerId => {
    const peer = activity.peers[peerId]
    return peer ? [peer] : []
  })
  const allTerminal = peers.length === activity.peerIds.length
    && peers.every(isTerminal)

  if (allTerminal) {
    const completed = peers.some(peer => peer.outcome === 'completed')
    const hasError = peers.some(peer => isErrorOutcome(peer.outcome))
    return completed && !hasError ? 'complete' : 'error'
  }

  if (activity.kind === 'text') return 'transferring'
  return peers.some(peer => peer.accepted) ? 'transferring' : 'requesting'
}

const allActivityPeersTerminal = (activity: OutgoingActivity) =>
  activity.peerIds.every(peerId => activity.peers[peerId]?.outcome !== undefined)

export const aggregateProgress = (activity: OutgoingActivity) => {
  const activeAccepted = activity.peerIds.flatMap(peerId => {
    const peer = activity.peers[peerId]
    return peer?.accepted && !peer.outcome ? [peer.progress] : []
  })

  if (activeAccepted.length > 0) return Math.min(...activeAccepted)

  const hasAccepted = activity.peerIds.some(peerId => activity.peers[peerId]?.accepted)
  return hasAccepted || allActivityPeersTerminal(activity) ? 1 : 0
}

export const aggregateFileProgress = (
  activity: OutgoingActivity,
  fileId: string,
) => {
  const file = activity.files[fileId]
  if (!file) return 0

  const activeAccepted = activity.peerIds.flatMap(peerId => {
    const peer = activity.peers[peerId]
    const filePeer = file.peers[peerId]
    return peer?.accepted && filePeer && !filePeer.outcome
      ? [filePeer.progress]
      : []
  })

  if (activeAccepted.length > 0) return Math.min(...activeAccepted)

  const hasAccepted = activity.peerIds.some(peerId => activity.peers[peerId]?.accepted)
  return hasAccepted || allActivityPeersTerminal(activity) ? 1 : 0
}

const deriveFileState = (
  activity: OutgoingActivity,
  file: OutgoingFileUiState,
): OutgoingFileUiState['state'] => {
  const filePeers = activity.peerIds.flatMap(peerId => {
    const peer = file.peers[peerId]
    return peer ? [peer] : []
  })
  const unresolved = activity.peerIds.some(peerId => {
    const peer = activity.peers[peerId]
    const filePeer = file.peers[peerId]
    if (!peer || !filePeer) return false
    if (peer.accepted) return filePeer.outcome === undefined
    return peer.outcome === undefined
  })
  const hasStarted = filePeers.some(peer =>
    peer.progress > 0 || peer.outcome === 'completed')

  if (unresolved) return hasStarted ? 'transferring' : 'queued'

  const completed = filePeers.some(peer => peer.outcome === 'completed')
  const hasError = filePeers.some(peer => isErrorOutcome(peer.outcome))
  return completed && !hasError ? 'completed' : 'error'
}

const refreshFiles = (activity: OutgoingActivity): OutgoingActivity => {
  const files = Object.fromEntries(
    Object.entries(activity.files).map(([fileId, file]) => [
      fileId,
      {
        ...file,
        state: deriveFileState(activity, file),
        progress: aggregateFileProgress(activity, fileId),
      },
    ]),
  )

  return { ...activity, files }
}

const finishPeer = (
  activity: OutgoingActivity,
  peerId: string,
  outcome: TransferPeerOutcome,
) => {
  const currentPeer = activity.peers[peerId]
  if (!currentPeer || currentPeer.outcome) return activity

  const peer: OutgoingPeerUiState = {
    ...currentPeer,
    accepted: outcome === 'completed'
      ? true
      : outcome === 'rejected'
        ? false
        : currentPeer.accepted,
    progress: outcome === 'completed' ? 1 : currentPeer.progress,
    outcome,
  }
  const files = Object.fromEntries(
    Object.entries(activity.files).map(([fileId, file]) => {
      const currentFilePeer = file.peers[peerId]
      if (!currentFilePeer || currentFilePeer.outcome === 'completed') {
        return [fileId, file]
      }

      return [
        fileId,
        {
          ...file,
          peers: {
            ...file.peers,
            [peerId]: {
              ...currentFilePeer,
              progress: outcome === 'completed' ? 1 : currentFilePeer.progress,
              outcome,
            },
          },
        },
      ]
    }),
  )
  let next: OutgoingActivity = {
    ...activity,
    peers: { ...activity.peers, [peerId]: peer },
    files,
  }
  next = refreshFiles(next)
  return { ...next, phase: derivePhase(next) }
}

const applyDecision = (
  activity: OutgoingActivity,
  event: Extract<PeerSessionEvent, { type: 'transfer:file-decision' }>,
) => {
  const peer = activity.peers[event.peerId]
  if (activity.kind !== 'file' || !peer || peer.outcome) return activity
  if (event.decision === 'reject') {
    return finishPeer(activity, event.peerId, 'rejected')
  }

  const next: OutgoingActivity = {
    ...activity,
    peers: {
      ...activity.peers,
      [event.peerId]: { ...peer, accepted: true },
    },
  }
  return { ...next, phase: derivePhase(next) }
}

const applyProgress = (
  activity: OutgoingActivity,
  event: Extract<PeerSessionEvent, { type: 'transfer:file-progress' }>,
) => {
  const peer = activity.peers[event.peerId]
  const file = activity.files[event.fileId]
  const filePeer = file?.peers[event.peerId]
  if (!peer || peer.outcome || !file || !filePeer || filePeer.outcome) return activity

  const nextPeer: OutgoingPeerUiState = {
    ...peer,
    accepted: true,
    progress: Math.max(peer.progress, ratio(event.batchBytes, event.batchTotalBytes)),
  }
  const nextFile: OutgoingFileUiState = {
    ...file,
    peers: {
      ...file.peers,
      [event.peerId]: {
        ...filePeer,
        progress: Math.max(filePeer.progress, ratio(event.fileBytes, event.fileTotalBytes)),
      },
    },
  }
  let next: OutgoingActivity = {
    ...activity,
    peers: { ...activity.peers, [event.peerId]: nextPeer },
    files: { ...activity.files, [event.fileId]: nextFile },
    phase: 'transferring',
  }
  next = refreshFiles(next)
  return next
}

const applyReceipt = (
  activity: OutgoingActivity,
  event: Extract<PeerSessionEvent, { type: 'transfer:file-receipt' }>,
) => {
  const peer = activity.peers[event.peerId]
  const file = activity.files[event.fileId]
  const filePeer = file?.peers[event.peerId]
  if (!peer || peer.outcome || !file || !filePeer || filePeer.outcome) return activity

  let next: OutgoingActivity = {
    ...activity,
    peers: {
      ...activity.peers,
      [event.peerId]: { ...peer, accepted: true },
    },
    files: {
      ...activity.files,
      [event.fileId]: {
        ...file,
        peers: {
          ...file.peers,
          [event.peerId]: {
            ...filePeer,
            progress: 1,
            outcome: 'completed',
          },
        },
      },
    },
  }
  next = refreshFiles(next)
  return next
}

const applyPeerSessionEvent = (
  activity: OutgoingActivity,
  event: PeerSessionEvent,
) => {
  if (event.type === 'peer:state') {
    return event.state === 'closed'
      ? finishPeer(activity, event.peerId, 'cancelled')
      : activity
  }

  if (!('transferId' in event) || event.transferId !== activity.transferId) {
    return activity
  }

  if (event.type === 'transfer:file-decision') {
    return applyDecision(activity, event)
  }
  if (event.type === 'transfer:file-progress') {
    return applyProgress(activity, event)
  }
  if (event.type === 'transfer:file-receipt') {
    return applyReceipt(activity, event)
  }
  if (event.type === 'transfer:terminal') {
    return finishPeer(activity, event.peerId, event.outcome)
  }

  return activity
}

export const createActivity = ({
  generation,
  transferId,
  kind,
  peerIds,
  unsupportedPeerIds = [],
  fileIds = [],
}: CreateActivityInput): OutgoingActivity => {
  const uniquePeerIds = Array.from(new Set(peerIds))
  const uniqueFileIds = Array.from(new Set(fileIds))
  const unsupported = new Set(unsupportedPeerIds)
  const peers = Object.fromEntries(uniquePeerIds.map(peerId => [
    peerId,
    {
      accepted: kind === 'text' && !unsupported.has(peerId),
      progress: 0,
      ...(unsupported.has(peerId) ? { outcome: 'failed' as const } : {}),
    },
  ]))
  const files = Object.fromEntries(uniqueFileIds.map(fileId => [
    fileId,
    {
      state: 'queued' as const,
      progress: 0,
      peers: Object.fromEntries(uniquePeerIds.map(peerId => [
        peerId,
        {
          progress: 0,
          ...(unsupported.has(peerId) ? { outcome: 'failed' as const } : {}),
        },
      ])),
    },
  ]))
  const activity: OutgoingActivity = {
    generation,
    transferId,
    kind,
    phase: kind === 'text' ? 'transferring' : 'requesting',
    peerIds: uniquePeerIds,
    peers,
    files,
  }

  return { ...activity, phase: derivePhase(activity) }
}

export const clearTerminalHold = (
  activity: OutgoingActivity | undefined,
  identity: { generation: number; transferId: string },
) => {
  if (
    !activity
    || activity.generation !== identity.generation
    || activity.transferId !== identity.transferId
  ) {
    return activity
  }

  return undefined
}

export const isTransferLocked = (state: TransferUiState) =>
  state.activity !== undefined

export const planIncomingText = <Event extends IncomingTextEvent>(
  queue: Event[],
  event: Event,
  maximumQueued: number,
): IncomingTextPlan<Event> => {
  if (queue.length >= Math.max(0, Math.trunc(maximumQueued))) {
    return { queue, disposition: 'discard' }
  }

  return {
    queue: [...queue, event],
    disposition: 'acknowledge',
  }
}

export const transferUiReducer = (
  state: TransferUiState,
  action: TransferUiAction,
): TransferUiState => {
  if (action.type === 'activity:start') {
    return { activity: action.activity }
  }

  if (action.type === 'room:reset' || action.type === 'realtime:disconnected') {
    return state.activity ? initialTransferUiState : state
  }

  if (action.type === 'terminal:clear') {
    const activity = clearTerminalHold(state.activity, action)
    return activity === state.activity
      ? state
      : activity
        ? { activity }
        : initialTransferUiState
  }

  if (!state.activity) return state
  const activity = applyPeerSessionEvent(state.activity, action.event)
  return activity === state.activity ? state : { activity }
}
