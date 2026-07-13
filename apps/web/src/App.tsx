import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react'
import IncomingFileRequestDialog, {
  type DownloadableReceivedFile,
  type IncomingFileRequestDialogState,
  type IncomingFileRequestItem,
} from './components/IncomingFileRequestDialog'
import AboutDialog from './components/AboutDialog'
import Loading from './components/Loading'
import ManualJoinWaiting from './components/ManualJoinWaiting'
import ReceivedTextDialog, {
  type ReceivedTextCopyStatus,
} from './components/ReceivedTextDialog'
import ReceiverPanel, {
  type ReceiverPanelState,
} from './components/ReceiverPanel'
import RoomCodeCopyButton from './components/RoomCodeCopyButton'
import RoomExpiryCountdown from './components/RoomExpiryCountdown'
import RoomJoin from './components/RoomJoin'
import RoomRecoveryPrompt from './components/RoomRecoveryPrompt'
import ShareDialog from './components/ShareDialog'
import SenderJoinRequestDialog from './components/SenderJoinRequestDialog'
import TransferPanel from './components/TransferPanel'
import ToastViewport from './components/ui/Toast'
import { useToast } from './components/ui/useToast'
import {
  initialRoomFlowState,
  roomFlowReducer,
} from './features/room/state'
import {
  initialJoinFlowState,
  joinFlowReducer,
} from './features/room/join-state'
import { mapJoinError } from './features/room/join-errors'
import {
  createJoinRequestPoller,
  type JoinRequestPoller,
} from './features/room/join-request-poller'
import {
  initialRoomAccessState,
  roomAccessReducer,
} from './features/room/room-access-state'
import type { RoomNavigationSnapshot } from './features/room/room-navigation'
import {
  createRoomSessionLifecycle,
  type RoomSessionLifecycle,
} from './features/room/session-lifecycle'
import { buildRoomInviteUrl } from './features/room/room-invite'
import {
  addFileSelections,
  removeFileSelection,
  type FileSelection,
} from './features/transfer/file-selection'
import {
  createPeerSession,
  type PeerSession,
  type PeerSessionEvent,
} from './features/transfer/peer-session'
import {
  createProgressFrameScheduler,
  type ProgressFrameScheduler,
} from './features/transfer/progress-frame'
import {
  createSpeedTracker,
  type SpeedTracker,
} from './features/transfer/transfer-speed-tracker'
import {
  createActivity,
  initialTransferUiState,
  planIncomingText,
  transferUiReducer,
  type IncomingTextEvent,
  type OutgoingActivity,
  type TransferUiAction,
  type TransferUiState,
} from './features/transfer/ui-state'
import {
  ApiClientError,
  cancelRoomJoinRequest,
  createRealtimeTicket,
  createRoom,
  createRoomJoinRequest,
  createVisitor,
  decideRoomJoinRequest,
  finalizeRoomJoinRequest,
  getRoomJoinRequest,
  joinRoom,
} from './lib/api-client'
import {
  getClientIceMode,
  resolveBootstrapRtcConfiguration,
  roomIceMode,
} from './lib/config'
import { appVersion } from './lib/app-meta'
import {
  createRealtimeClient,
  type RealtimeClient,
} from './lib/realtime-client'
import {
  clearRoomSession,
  loadRoomSession,
  saveRoomSession,
} from './lib/room-session'
import {
  sendNotification,
  setupNotificationPermissionPrompt,
} from './lib/notifications'
import {
  clearVisitorSession,
  loadVisitorSession,
  saveVisitorSession,
} from './lib/visitor-session'
import type {
  ParticipantRole,
  PublicRoom,
  PublicVisitor,
  RoomInviteCapability,
  RoomJoinRequestReceipt,
  RoomSessionBootstrap,
  VisitorSession,
} from './shared/contracts'

type IncomingText = IncomingTextEvent & {
  sender: PublicVisitor
}

type IncomingFileTransfer = {
  peerId: string
  transferId: string
  sender: PublicVisitor
  files: IncomingFileRequestItem[]
  state: IncomingFileRequestDialogState
}

type FileProgressEvent = Extract<
  PeerSessionEvent,
  { type: 'transfer:file-progress' }
>

type FileSpeedData = Record<string, { speed: number; eta: number | undefined }>

type OutgoingPayload =
  | { kind: 'text'; text: string; peerIds: string[] }
  | { kind: 'file'; selections: FileSelection[]; peerIds: string[] }

const speedSampleKey = (
  direction: FileProgressEvent['direction'],
  transferId: string,
  peerId: string,
  fileId: string,
) => [direction, transferId, peerId, fileId].join('\u0000')

const outgoingFileSpeedData = (
  activity: OutgoingActivity,
  tracker: SpeedTracker,
): FileSpeedData => {
  if (activity.kind !== 'file' || isTerminalActivity(activity)) return {}

  return Object.fromEntries(Object.keys(activity.files).flatMap(fileId => {
    const file = activity.files[fileId]
    if (!file) return []
    const samples = activity.peerIds.flatMap(peerId => {
      const activityPeer = activity.peers[peerId]
      const filePeer = file.peers[peerId]
      if (!activityPeer?.accepted || activityPeer.outcome || !filePeer || filePeer.outcome) {
        return []
      }
      const key = speedSampleKey('sending', activity.transferId, peerId, fileId)
      const speed = tracker.getSpeed(key)
      if (speed <= 0) return []
      return [{ speed, eta: tracker.getEta(key) }]
    })
    if (samples.length === 0) return []
    const finiteEtas = samples.flatMap(sample =>
      sample.eta !== undefined && Number.isFinite(sample.eta) ? [sample.eta] : [])
    return [[fileId, {
      speed: Math.min(...samples.map(sample => sample.speed)),
      eta: finiteEtas.length > 0 ? Math.max(...finiteEtas) : undefined,
    }]]
  }))
}

const senderFromRoom = (room?: PublicRoom) =>
  room?.participants.find(participant => participant.role === 'sender')?.visitor

const visitorFromRoom = (room: PublicRoom | undefined, visitorId: string) =>
  room?.participants.find(participant => participant.visitor.id === visitorId)?.visitor

const receiversFromRoom = (room?: PublicRoom) =>
  room?.participants.flatMap(participant =>
    participant.role === 'receiver' ? [participant.visitor] : []) ?? []

const removeParticipant = (room: PublicRoom, visitorId: string): PublicRoom => ({
  ...room,
  receivers: room.receivers.filter(id => id !== visitorId),
  participants: room.participants.filter(participant =>
    participant.visitor.id !== visitorId),
})

const isTerminalActivity = (activity?: OutgoingActivity) =>
  activity?.phase === 'complete' || activity?.phase === 'error'

const createFileId = () => `file_${crypto.randomUUID()}`

const assertBootstrapMembership = (
  bootstrap: RoomSessionBootstrap,
  visitorId: string,
  role: ParticipantRole,
) => {
  const participant = bootstrap.room.participants.find(candidate => (
    candidate.visitor.id === visitorId
  ))
  const roleMatchesRoom = role === 'sender'
    ? bootstrap.room.senderId === visitorId
    : bootstrap.room.receivers.includes(visitorId)
  if (
    !participant
    || participant.role !== role
    || participant.status === 'left'
    || !roleMatchesRoom
  ) {
    throw new Error('服务端返回的房间成员关系无效')
  }
}

type AppProps = {
  initialNavigation: RoomNavigationSnapshot
}

type OwnerInvite = {
  roomCode: string
  capability: RoomInviteCapability
}

type ShareDialogState = {
  roomCode: string
  roomUrl: string
}

type ManualJoinIntent = {
  roomCode: string
  generation: number
  session?: VisitorSession
  requestId?: string
  expiresAt?: number
  strictRecoveryAttempted: boolean
}

type ReceiverRecoveryIntent = {
  roomCode: string
  session: VisitorSession
}

function App({ initialNavigation }: AppProps) {
  const [state, dispatch] = useReducer(roomFlowReducer, initialRoomFlowState)
  const [bootAttempt, setBootAttempt] = useState(0)
  const [joinFlow, dispatchJoinFlow] = useReducer(
    joinFlowReducer,
    initialJoinFlowState,
  )
  const [roomAccess, dispatchRoomAccess] = useReducer(
    roomAccessReducer,
    initialRoomAccessState,
  )
  const [transferUiState, setTransferUiState] = useState<TransferUiState>(
    initialTransferUiState,
  )
  const [fileSelections, setFileSelections] = useState<FileSelection[]>([])
  const [selectionError, setSelectionError] = useState('')
  const [incomingTexts, setIncomingTexts] = useState<IncomingText[]>([])
  const [textCopyStatus, setTextCopyStatus] = useState<ReceivedTextCopyStatus>('idle')
  const [incomingFile, setIncomingFile] = useState<IncomingFileTransfer>()
  const [receiverPanelState, setReceiverPanelState] = useState<ReceiverPanelState>({
    status: 'waiting',
  })
  const [fileSpeedData, setFileSpeedData] = useState<FileSpeedData>({})
  const initialInvite = initialNavigation.fragment.kind === 'invite'
    ? initialNavigation.fragment.intent
    : undefined
  const [joinMode, setJoinMode] = useState<'invite' | 'manual'>(
    initialInvite ? 'invite' : 'manual',
  )
  const [joinError, setJoinError] = useState(
    initialNavigation.fragment.kind === 'invalid'
      ? '邀请链接无效或已过期'
      : '',
  )
  const [ownerInviteRoomCode, setOwnerInviteRoomCode] = useState<string>()
  const [shareDialog, setShareDialog] = useState<ShareDialogState>()
  const [aboutOpen, setAboutOpen] = useState(false)
  const [manualActionBusy, setManualActionBusy] = useState(false)
  const [manualReceipt, setManualReceipt] = useState<RoomJoinRequestReceipt>()
  const [receiverRecoveryIntent, setReceiverRecoveryIntent] = useState<
    ReceiverRecoveryIntent | undefined
  >()
  const [manualRoomCode, setManualRoomCode] = useState(
    initialNavigation.legacyRoomCode ?? '',
  )
  const {
    toast: toastState,
    show: showToast,
    dismiss: dismissToast,
  } = useToast()

  const realtimeRef = useRef<RealtimeClient | undefined>(undefined)
  const peerSessionRef = useRef<PeerSession | undefined>(undefined)
  const roomLifecycleRef = useRef<RoomSessionLifecycle | undefined>(undefined)
  const roomVisibilityCleanupRef = useRef<(() => void) | undefined>(undefined)
  const roomRef = useRef<PublicRoom | undefined>(undefined)
  const transferUiStateRef = useRef<TransferUiState>(initialTransferUiState)
  const fileSelectionsRef = useRef<FileSelection[]>([])
  const incomingTextsRef = useRef<IncomingText[]>([])
  const incomingFileRef = useRef<IncomingFileTransfer | undefined>(undefined)
  const progressSchedulerRef = useRef<ProgressFrameScheduler<FileProgressEvent> | undefined>(undefined)
  const terminalHoldTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const terminalHoldIdentityRef = useRef<string | undefined>(undefined)
  const objectUrlsRef = useRef(new Set<string>())
  const textCopyOperationRef = useRef(0)
  const operationGenerationRef = useRef(0)
  const transferGenerationRef = useRef(0)
  const outgoingOfferInFlightRef = useRef(false)
  const pendingOutgoingEventsRef = useRef<PeerSessionEvent[]>([])
  const outgoingPayloadRef = useRef<OutgoingPayload | undefined>(undefined)
  const peerRetryCountsRef = useRef(new Map<string, number>())
  const peerRetryTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>())
  const visitorBootstrapPromiseRef = useRef<Promise<VisitorSession> | undefined>(undefined)
  const roomRecoveryAttemptedRef = useRef(false)
  const bootLoadedVisitorRef = useRef(false)
  const navigationSuppressesRecoveryRef = useRef(
    initialNavigation.fragment.kind !== 'absent',
  )
  const inviteIntentRef = useRef(initialInvite)
  const inviteJoinSessionRef = useRef<VisitorSession | undefined>(undefined)
  const inviteVisitorReplacementAttemptedRef = useRef(false)
  const ownerInviteRef = useRef<OwnerInvite | undefined>(undefined)
  const manualJoinIntentRef = useRef<ManualJoinIntent | undefined>(undefined)
  const joinRequestPollerRef = useRef<JoinRequestPoller | undefined>(undefined)
  const applyManualReceiptRef = useRef<(
    receipt: RoomJoinRequestReceipt,
    intent: ManualJoinIntent,
  ) => void>(() => undefined)
  const finalizeManualRef = useRef<(
    intent: ManualJoinIntent,
    receipt: RoomJoinRequestReceipt,
  ) => void>(() => undefined)
  const recoverManualRef = useRef<(
    intent: ManualJoinIntent,
    receipt: RoomJoinRequestReceipt,
  ) => void>(() => undefined)
  const startManualPollerRef = useRef<(
    intent: ManualJoinIntent,
  ) => void>(() => undefined)
  const speedTrackerRef = useRef<SpeedTracker>(createSpeedTracker())

  const replaceFileSelections = useCallback((selections: FileSelection[]) => {
    fileSelectionsRef.current = selections
    setFileSelections(selections)
  }, [])

  const invalidatePendingOperations = useCallback(() => {
    operationGenerationRef.current += 1
  }, [])

  const replaceIncomingTexts = useCallback((texts: IncomingText[]) => {
    incomingTextsRef.current = texts
    setIncomingTexts(texts)
  }, [])

  const replaceIncomingFile = useCallback((file?: IncomingFileTransfer) => {
    incomingFileRef.current = file
    setIncomingFile(file)
  }, [])

  const clearFileSpeedPresentation = useCallback(() => {
    speedTrackerRef.current.clear()
    setFileSpeedData({})
  }, [])

  const syncOutgoingFileSpeedPresentation = useCallback((activity?: OutgoingActivity) => {
    if (!activity || activity.kind !== 'file' || isTerminalActivity(activity)) {
      progressSchedulerRef.current?.clear()
      clearFileSpeedPresentation()
      return
    }
    setFileSpeedData(outgoingFileSpeedData(activity, speedTrackerRef.current))
  }, [clearFileSpeedPresentation])

  const applyTransferAction = useCallback((action: TransferUiAction) => {
    const next = transferUiReducer(transferUiStateRef.current, action)
    transferUiStateRef.current = next
    setTransferUiState(next)
    return next
  }, [])

  const clearTerminalHold = useCallback(() => {
    if (terminalHoldTimerRef.current !== undefined) {
      clearTimeout(terminalHoldTimerRef.current)
      terminalHoldTimerRef.current = undefined
    }
    terminalHoldIdentityRef.current = undefined
  }, [])

  const revokeObjectUrl = useCallback((url: string) => {
    if (!objectUrlsRef.current.delete(url)) return
    URL.revokeObjectURL(url)
  }, [])

  const revokeAllObjectUrls = useCallback(() => {
    const urls = Array.from(objectUrlsRef.current)
    objectUrlsRef.current.clear()
    for (const url of urls) URL.revokeObjectURL(url)
  }, [])

  const flushProgressEvents = useCallback((events: readonly FileProgressEvent[]) => {
    let nextTransferState = transferUiStateRef.current
    const tracker = speedTrackerRef.current
    for (const event of events) {
      nextTransferState = transferUiReducer(nextTransferState, {
        type: 'peer-session:event',
        event,
      })
      tracker.record(
        speedSampleKey(event.direction, event.transferId, event.peerId, event.fileId),
        event.fileBytes,
        event.fileTotalBytes,
      )
    }
    if (nextTransferState !== transferUiStateRef.current) {
      transferUiStateRef.current = nextTransferState
      setTransferUiState(nextTransferState)
    }

    const current = incomingFileRef.current
    if (current?.state.status === 'receiving') {
      const progressByFileId = { ...current.state.progressByFileId }
      const knownFileIds = new Set(current.files.map(file => file.fileId))
      let changed = false

      for (const event of events) {
        if (
          event.direction !== 'receiving'
          || event.peerId !== current.peerId
          || event.transferId !== current.transferId
          || !knownFileIds.has(event.fileId)
        ) {
          continue
        }

        const ratio = event.fileTotalBytes <= 0
          ? 1
          : event.fileBytes / event.fileTotalBytes
        const next = Number.isFinite(ratio)
          ? Math.min(1, Math.max(0, ratio))
          : 0
        const previous = progressByFileId[event.fileId] ?? 0
        if (next <= previous) continue

        progressByFileId[event.fileId] = next
        changed = true
      }

      if (changed) {
        replaceIncomingFile({
          ...current,
          state: { status: 'receiving', progressByFileId },
        })
      }
    }

    const activity = nextTransferState.activity
    if (current?.state.status === 'receiving') {
      const nextSpeedData = Object.fromEntries(current.files.flatMap(file => {
        const key = speedSampleKey(
          'receiving',
          current.transferId,
          current.peerId,
          file.fileId,
        )
        const speed = tracker.getSpeed(key)
        return speed > 0
          ? [[file.fileId, { speed, eta: tracker.getEta(key) }]]
          : []
      }))
      setFileSpeedData(nextSpeedData)
    } else if (activity?.kind === 'file') {
      setFileSpeedData(outgoingFileSpeedData(activity, tracker))
    }
  }, [replaceIncomingFile])

  const getProgressScheduler = useCallback(() => {
    if (!progressSchedulerRef.current) {
      progressSchedulerRef.current = createProgressFrameScheduler<FileProgressEvent>({
        requestFrame: callback => window.requestAnimationFrame(callback),
        cancelFrame: frame => window.cancelAnimationFrame(frame),
        onFlush: flushProgressEvents,
      })
    }
    return progressSchedulerRef.current
  }, [flushProgressEvents])

  const armTerminalHold = useCallback((activity?: OutgoingActivity) => {
    if (!isTerminalActivity(activity) || !activity) return

    progressSchedulerRef.current?.clear()
    const identity = `${String(activity.generation)}\u0000${activity.transferId}`
    clearTerminalHold()
    terminalHoldIdentityRef.current = identity
  }, [clearTerminalHold])

  const resetTransferPresentation = useCallback((
    action: Extract<TransferUiAction, { type: 'room:reset' | 'realtime:disconnected' }>,
  ) => {
    clearTerminalHold()
    progressSchedulerRef.current?.clear()
    revokeAllObjectUrls()
    textCopyOperationRef.current += 1
    outgoingOfferInFlightRef.current = false
    pendingOutgoingEventsRef.current = []
    outgoingPayloadRef.current = undefined
    replaceIncomingTexts([])
    replaceIncomingFile()
    replaceFileSelections([])
    setSelectionError('')
    setTextCopyStatus('idle')
    setReceiverPanelState({ status: 'waiting' })
    clearFileSpeedPresentation()
    applyTransferAction(action)
  }, [
    applyTransferAction,
    clearFileSpeedPresentation,
    clearTerminalHold,
    replaceFileSelections,
    replaceIncomingFile,
    replaceIncomingTexts,
    revokeAllObjectUrls,
  ])

  const disposeBrowserTransferResources = useCallback(() => {
    clearTerminalHold()
    progressSchedulerRef.current?.clear()
    revokeAllObjectUrls()
    textCopyOperationRef.current += 1
    outgoingPayloadRef.current = undefined
  }, [clearTerminalHold, revokeAllObjectUrls])

  const disposePeerSession = useCallback(() => {
    for (const timer of peerRetryTimersRef.current) clearTimeout(timer)
    peerRetryTimersRef.current.clear()
    peerRetryCountsRef.current.clear()
    const peerSession = peerSessionRef.current
    peerSessionRef.current = undefined
    peerSession?.close()
  }, [])

  const disposeRoomLifecycle = useCallback(() => {
    roomVisibilityCleanupRef.current?.()
    roomVisibilityCleanupRef.current = undefined
    roomLifecycleRef.current?.stop()
    roomLifecycleRef.current = undefined
  }, [])

  const clearOwnerInvite = useCallback(() => {
    ownerInviteRef.current = undefined
    setOwnerInviteRoomCode(undefined)
    setShareDialog(undefined)
  }, [])

  const resetManualIntent = useCallback(() => {
    joinRequestPollerRef.current?.stop()
    joinRequestPollerRef.current = undefined
    manualJoinIntentRef.current = undefined
    setManualActionBusy(false)
    setManualReceipt(undefined)
    dispatchJoinFlow({ type: 'join:reset' })
  }, [])

  const abandonReceiverRecovery = useCallback(() => {
    if (!receiverRecoveryIntent) return

    setReceiverRecoveryIntent(undefined)
    clearRoomSession()
  }, [receiverRecoveryIntent])

  const disposeRoomResources = useCallback(() => {
    disposeRoomLifecycle()
    const realtime = realtimeRef.current
    realtimeRef.current = undefined
    realtime?.close()
    disposePeerSession()
    roomRef.current = undefined
    clearOwnerInvite()
    resetManualIntent()
    setReceiverRecoveryIntent(undefined)
    dispatchRoomAccess({ type: 'reset' })
    clearRoomSession()
    resetTransferPresentation({ type: 'room:reset' })
  }, [clearOwnerInvite, disposePeerSession, disposeRoomLifecycle, resetManualIntent, resetTransferPresentation])

  useEffect(() => {
    const bootGeneration = operationGenerationRef.current
    const cleanupNotificationPrompt = setupNotificationPermissionPrompt()
    const boot = async () => {
      try {
        const existingSession = loadVisitorSession()
        if (existingSession) {
          bootLoadedVisitorRef.current = true
          if (operationGenerationRef.current !== bootGeneration) return
          dispatch({ type: 'visitor:ready', session: existingSession })
          return
        }

        bootLoadedVisitorRef.current = false
        const pendingSession = visitorBootstrapPromiseRef.current ?? createVisitor()
        visitorBootstrapPromiseRef.current = pendingSession
        const session = await pendingSession
        if (operationGenerationRef.current !== bootGeneration) return
        saveVisitorSession(session)
        dispatch({ type: 'visitor:ready', session })
      } catch {
        if (operationGenerationRef.current !== bootGeneration) return
        showToast('连接服务器失败，请检查网络后重试')
        dispatch({ type: 'error', message: '连接服务器失败' })
      }
    }

    void boot()

    return () => {
      cleanupNotificationPrompt()
      invalidatePendingOperations()
      const realtime = realtimeRef.current
      realtimeRef.current = undefined
      realtime?.close()
      disposeRoomLifecycle()
      disposePeerSession()
      disposeBrowserTransferResources()
      joinRequestPollerRef.current?.stop()
      joinRequestPollerRef.current = undefined
      manualJoinIntentRef.current = undefined
      ownerInviteRef.current = undefined
    }
  }, [
    bootAttempt,
    disposeBrowserTransferResources,
    disposePeerSession,
    disposeRoomLifecycle,
    invalidatePendingOperations,
    showToast,
  ])

  const connectRealtime = useCallback((
    session: VisitorSession,
    bootstrap: RoomSessionBootstrap,
    role: ParticipantRole,
    rtcConfiguration: RTCConfiguration,
    roomGeneration: number,
  ) => {
    const initialRoom = bootstrap.room
    disposeRoomResources()
    roomRef.current = initialRoom
    setReceiverPanelState({ status: 'waiting' })

    const client = createRealtimeClient({
      token: session.token,
      getRealtimeTicket: async () => (await createRealtimeTicket(session.token)).ticket,
    })
    realtimeRef.current = client
    let hasOpened = false

    const lifecycle = createRoomSessionLifecycle({
      expiresAt: initialRoom.expiresAt,
      isCurrent: () => (
        operationGenerationRef.current === roomGeneration
        && realtimeRef.current === client
        && roomLifecycleRef.current === lifecycle
      ),
      onExpire: () => {
        if (operationGenerationRef.current !== roomGeneration) return
        ++operationGenerationRef.current
        disposeRoomResources()
        dispatch({ type: 'visitor:ready', session })
        showToast('房间已到期，请重新创建或加入新房间', 'info')
      },
    })
    roomLifecycleRef.current = lifecycle
    const handleVisibilityChange = () => {
      lifecycle.onVisibilityChange()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    roomVisibilityCleanupRef.current = () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }

    const createActivePeerSession = () => {
      if (!lifecycle.isActive()) return
      disposePeerSession()
      const peerSession = createPeerSession({
        selfId: session.visitor.id,
        roomCode: initialRoom.code,
        role,
        rtcConfiguration,
        sendSignal: message => client.send(message),
      })
      peerSessionRef.current = peerSession

      const applyOutgoingEvent = (event: PeerSessionEvent) => {
        if (
          outgoingOfferInFlightRef.current
          && !transferUiStateRef.current.activity
        ) {
          pendingOutgoingEventsRef.current.push(event)
          return
        }
        const previousActivity = transferUiStateRef.current.activity
        const next = applyTransferAction({ type: 'peer-session:event', event })
        armTerminalHold(next.activity)
        if (previousActivity?.kind === 'file' || next.activity?.kind === 'file') {
          syncOutgoingFileSpeedPresentation(next.activity)
        }
      }

      const failIncomingFile = (peerId: string, transferId: string, message?: string) => {
        const current = incomingFileRef.current
        if (
          !current
          || current.peerId !== peerId
          || current.transferId !== transferId
          || current.state.status === 'received'
        ) {
          return
        }
        progressSchedulerRef.current?.clear()
        clearFileSpeedPresentation()
        replaceIncomingFile({
          ...current,
          state: { status: 'error', message },
        })
        setReceiverPanelState({ status: 'error', message })
      }

      const onPeerEvent = (event: PeerSessionEvent) => {
        if (peerSessionRef.current !== peerSession) return

        if (event.type === 'peer:state') {
          dispatch({
            type: 'peer:ready-ids',
            peerIds: peerSession.readyPeerIds(),
          })
          if (event.state === 'ready') {
            peerRetryCountsRef.current.delete(event.peerId)
          }
          if (event.state === 'closed') {
            if (role === 'receiver') progressSchedulerRef.current?.clear()
            applyOutgoingEvent(event)
            const currentFile = incomingFileRef.current
            if (currentFile?.peerId === event.peerId) {
              failIncomingFile(
                currentFile.peerId,
                currentFile.transferId,
                '发送者离开了页面，文件传输已中断。请让对方重新发送。',
              )
            }
          }
          if (event.state === 'closed' && role === 'sender') {
            const activeRoom = roomRef.current
            const stillPresent = activeRoom?.participants.some(participant =>
              participant.visitor.id === event.peerId
              && participant.role === 'receiver')
            const retries = peerRetryCountsRef.current.get(event.peerId) ?? 0
            if (stillPresent && retries < 2) {
              peerRetryCountsRef.current.set(event.peerId, retries + 1)
              const timer = setTimeout(() => {
                peerRetryTimersRef.current.delete(timer)
                if (
                  lifecycle.beforePeerRetry()
                  &&
                  peerSessionRef.current === peerSession
                  && roomRef.current?.participants.some(participant =>
                    participant.visitor.id === event.peerId
                    && participant.role === 'receiver')
                ) {
                  peerSession.syncRoom(roomRef.current)
                }
              }, 750 * (retries + 1))
              peerRetryTimersRef.current.add(timer)
            }
          }
          return
        }

        if (event.type === 'transfer:text-received') {
          const sender = visitorFromRoom(roomRef.current, event.peerId)
          if (!sender) {
            peerSession.discardText(event.peerId, event.transferId)
            return
          }

          const planned = planIncomingText(incomingTextsRef.current, {
            ...event,
            sender,
          }, 5)
          replaceIncomingTexts(planned.queue)
          sendNotification({
            title: '收到文本',
            body: `来自 ${sender.displayName}：${event.text.slice(0, 60)}${event.text.length > 60 ? '…' : ''}`,
            tag: `text-${event.transferId}`,
          })
          if (planned.disposition === 'acknowledge') {
            peerSession.acknowledgeText(event.peerId, event.transferId)
          } else {
            peerSession.discardText(event.peerId, event.transferId)
            showToast('接收队列已满，新的文本未显示', 'info')
          }
          return
        }

        if (event.type === 'transfer:file-requested') {
          const sender = visitorFromRoom(roomRef.current, event.peerId)
          if (!sender || incomingFileRef.current) {
            peerSession.rejectFiles(event.peerId, event.transferId)
            if (incomingFileRef.current) {
              showToast('正在处理当前文件请求，新的请求暂不接收', 'info')
            }
            return
          }

          const fileNames = event.files.map(f => f.name)
          clearFileSpeedPresentation()
          replaceIncomingFile({
            peerId: event.peerId,
            transferId: event.transferId,
            sender,
            files: event.files.map(file => ({
              fileId: file.fileId,
              name: file.name,
              byteLength: file.byteLength,
            })),
            state: { status: 'pending' },
          })
          sendNotification({
            title: '收到文件请求',
            body: `来自 ${sender.displayName}：${fileNames.length > 1 ? `${fileNames[0]} 等 ${String(fileNames.length)} 个文件` : fileNames[0]}`,
            tag: `file-${event.transferId}`,
          })
          return
        }

        if (event.type === 'transfer:file-progress') {
          getProgressScheduler().push(event)
          return
        }

        if (
          event.type === 'transfer:file-decision'
          || event.type === 'transfer:file-receipt'
        ) {
          applyOutgoingEvent(event)
          return
        }

        if (event.type === 'transfer:files-received') {
          const current = incomingFileRef.current
          if (
            !current
            || current.peerId !== event.peerId
            || current.transferId !== event.transferId
            || current.state.status === 'received'
          ) {
            return
          }

          const createdUrls: string[] = []
          try {
            const files: DownloadableReceivedFile[] = event.files.map(file => {
              const url = URL.createObjectURL(file.blob)
              createdUrls.push(url)
              objectUrlsRef.current.add(url)
              return {
                fileId: file.fileId,
                name: file.name,
                byteLength: file.byteLength,
                url,
              }
            })
            progressSchedulerRef.current?.clear()
            clearFileSpeedPresentation()
            replaceIncomingFile({
              ...current,
              state: { status: 'received', files },
            })
            setReceiverPanelState({ status: 'waiting' })
            showToast('文件接收完成', 'success')
            sendNotification({
              title: '文件接收完成',
              body: `来自 ${current.sender.displayName} 的 ${String(event.files.length)} 个文件已就绪`,
              tag: `file-received-${event.transferId}`,
            })
          } catch {
            for (const url of createdUrls) revokeObjectUrl(url)
            failIncomingFile(event.peerId, event.transferId, '文件下载准备失败，请让发送者重新发送。')
          }
          return
        }

        if (event.type === 'transfer:terminal') {
          if (role === 'receiver') {
            progressSchedulerRef.current?.clear()
            clearFileSpeedPresentation()
          }
          applyOutgoingEvent(event)
          if (event.outcome !== 'completed') {
            failIncomingFile(event.peerId, event.transferId)
          }
          return
        }

        if (event.peerId && event.transferId) {
          failIncomingFile(event.peerId, event.transferId, event.message)
        }
        showToast(event.message)
      }

      peerSession.subscribe(onPeerEvent)
      peerSession.syncRoom(roomRef.current ?? initialRoom)
    }

    client.subscribe(message => {
      if (realtimeRef.current !== client) return

      if (message.type === 'visitor:ready') return

      if (message.type === 'room:join-requests') {
        if (role === 'sender' && message.roomCode === initialRoom.code) {
          dispatchRoomAccess({ type: 'snapshot', requests: message.requests })
        }
        return
      }

      if (message.type === 'room:join-requested') {
        if (role === 'sender' && message.request.roomCode === initialRoom.code) {
          dispatchRoomAccess({ type: 'requested', request: message.request })
        }
        return
      }

      if (message.type === 'room:join-request-resolved') {
        if (role === 'sender' && message.roomCode === initialRoom.code) {
          dispatchRoomAccess({ type: 'resolved', requestId: message.requestId })
        }
        return
      }

      if (
        message.type === 'signal:offer'
        || message.type === 'signal:answer'
        || message.type === 'signal:ice'
      ) {
        void peerSessionRef.current?.handleSignal(message)
        return
      }

      if (message.type === 'room:participants') {
        roomRef.current = message.room
        dispatch({ type: 'server:message', message })
        peerSessionRef.current?.syncRoom(message.room)
        return
      }

      if (message.type === 'participant:left') {
        const currentRoom = roomRef.current
        if (
          role === 'receiver'
          && currentRoom?.code === message.roomCode
          && currentRoom.senderId === message.visitorId
        ) {
          ++operationGenerationRef.current
          disposeRoomResources()
          dispatch({ type: 'visitor:ready', session })
          showToast('发送者已退出，房间自动关闭', 'info')
          return
        }
        if (currentRoom?.code === message.roomCode) {
          const nextRoom = removeParticipant(currentRoom, message.visitorId)
          roomRef.current = nextRoom
          peerSessionRef.current?.syncRoom(nextRoom)
        }
        dispatch({ type: 'server:message', message })
        return
      }

      if (
        message.code === 'ROOM_NOT_FOUND'
        || message.code === 'ROOM_EXPIRED'
        || message.code === 'ROOM_MEMBERSHIP_REQUIRED'
      ) {
        ++operationGenerationRef.current
        disposeRoomResources()
        dispatch({ type: 'visitor:ready', session })
        showToast(
          message.code === 'ROOM_MEMBERSHIP_REQUIRED'
            ? '房间连接已失效，请重新加入'
            : '房间已到期，请重新创建或加入',
          'info',
        )
        return
      }

      if (message.code === 'VISITOR_NOT_FOUND') {
        const recoveryGeneration = ++operationGenerationRef.current
        disposeRoomResources()
        clearVisitorSession()
        void createVisitor()
          .then(freshSession => {
            if (operationGenerationRef.current !== recoveryGeneration) return
            saveVisitorSession(freshSession)
            dispatch({ type: 'visitor:ready', session: freshSession })
            showToast('身份信息已更新，请重新加入房间', 'info')
          })
          .catch(() => {
            if (operationGenerationRef.current !== recoveryGeneration) return
            dispatch({ type: 'visitor:ready', session })
            showToast('身份信息恢复失败，请刷新页面重试')
          })
        return
      }

      showToast(message.message)
    })

    client.subscribeStatus(status => {
      if (realtimeRef.current !== client) return

      if (status === 'open') {
        if (!lifecycle.onReconnect()) return
        client.send({
          type: 'room:attach',
          roomCode: initialRoom.code,
          role,
        })
        dispatch({ type: 'realtime:connected' })
        createActivePeerSession()
        if (hasOpened) showToast('信令连接已恢复', 'success')
        hasOpened = true
        return
      }

      if (status === 'reconnecting') {
        disposePeerSession()
        resetTransferPresentation({ type: 'realtime:disconnected' })
        dispatch({ type: 'realtime:disconnected' })
        showToast('连接中断，正在重新连接…', 'info')
        return
      }

      if (status === 'closed') {
        ++operationGenerationRef.current
        disposeRoomResources()
        dispatch({ type: 'visitor:ready', session })
        showToast(
          hasOpened
            ? '网络连接断开，请重新创建或加入房间继续传输'
            : '无法建立连接，请稍后刷新页面重试',
        )
      }
    })

    lifecycle.start()
    if (!lifecycle.isActive()) return
    client.connect()
  }, [
    applyTransferAction,
    armTerminalHold,
    clearFileSpeedPresentation,
    disposePeerSession,
    disposeRoomResources,
    getProgressScheduler,
    replaceIncomingFile,
    replaceIncomingTexts,
    resetTransferPresentation,
    revokeObjectUrl,
    showToast,
    syncOutgoingFileSpeedPresentation,
  ])

  const runWithFreshSession = useCallback(async <T,>(
    session: VisitorSession,
    operation: (activeSession: VisitorSession) => Promise<T>,
    operationGeneration: number,
  ) => {
    try {
      const value = await operation(session)
      if (operationGenerationRef.current !== operationGeneration) return undefined
      return {
        session,
        value,
      }
    } catch (error) {
      if (!(error instanceof ApiClientError) || error.code !== 'VISITOR_NOT_FOUND') {
        throw error
      }
    }

    if (operationGenerationRef.current !== operationGeneration) return undefined
    clearVisitorSession()
    const freshSession = await createVisitor()
    if (operationGenerationRef.current !== operationGeneration) return undefined
    saveVisitorSession(freshSession)
    if (operationGenerationRef.current !== operationGeneration) return undefined
    const value = await operation(freshSession)
    if (operationGenerationRef.current !== operationGeneration) return undefined

    return {
      session: freshSession,
      value,
    }
  }, [])

  const handleCreateRoom = useCallback(async () => {
    if (!state.session) return
    resetManualIntent()
    abandonReceiverRecovery()
    const operationGeneration = ++operationGenerationRef.current
    dispatch({ type: 'room:joining' })

    try {
      const iceMode = getClientIceMode()
      const result = await runWithFreshSession(
        state.session,
        activeSession => createRoom(activeSession.token, roomIceMode(iceMode)),
        operationGeneration,
      )
      if (!result) return
      if (operationGenerationRef.current !== operationGeneration) return
      if (result.session.token !== state.session.token) {
        dispatch({ type: 'visitor:ready', session: result.session })
      }
      const rtcConfiguration = resolveBootstrapRtcConfiguration(iceMode, result.value)
      assertBootstrapMembership(result.value, result.session.visitor.id, 'sender')
      roomRef.current = result.value.room
      dispatch({ type: 'room:created', room: result.value.room })
      connectRealtime(
        result.session,
        result.value,
        'sender',
        rtcConfiguration,
        operationGeneration,
      )
      ownerInviteRef.current = {
        roomCode: result.value.room.code,
        capability: result.value.invite,
      }
      setOwnerInviteRoomCode(result.value.room.code)
    } catch (error) {
      if (operationGenerationRef.current !== operationGeneration) return
      const message = error instanceof Error ? error.message : '创建房间失败'
      showToast(message)
      dispatch({ type: 'error', message })
    }
  }, [
    abandonReceiverRecovery,
    connectRealtime,
    resetManualIntent,
    runWithFreshSession,
    showToast,
    state.session,
  ])

  const clearInviteIntent = useCallback(() => {
    inviteIntentRef.current = undefined
    inviteJoinSessionRef.current = undefined
    inviteVisitorReplacementAttemptedRef.current = false
    setJoinMode('manual')
  }, [])

  const handleRoomCodeEdited = useCallback(() => {
    clearInviteIntent()
    setJoinError('')
  }, [clearInviteIntent])

  const joinInvitedRoom = useCallback(async (code: string) => {
    const intent = inviteIntentRef.current
    if (!state.session || !intent || intent.roomCode !== code) return
    const operationGeneration = ++operationGenerationRef.current
    dispatch({ type: 'room:joining' })
    setJoinError('')

    try {
      let joinSession = inviteJoinSessionRef.current
      if (!joinSession) {
        joinSession = await createVisitor()
        if (operationGenerationRef.current !== operationGeneration) return
        inviteJoinSessionRef.current = joinSession
        saveVisitorSession(joinSession)
        dispatch({ type: 'visitor:ready', session: joinSession })
      }
      const iceMode = getClientIceMode()
      const admission = {
        kind: 'invite' as const,
        inviteToken: intent.inviteToken,
      }
      let bootstrap: RoomSessionBootstrap
      try {
        bootstrap = await joinRoom({
          roomCode: code,
          visitorToken: joinSession.token,
          iceMode: roomIceMode(iceMode),
          admission,
        })
      } catch (error) {
        if (
          !(error instanceof ApiClientError)
          || error.code !== 'VISITOR_NOT_FOUND'
          || inviteVisitorReplacementAttemptedRef.current
        ) throw error

        inviteVisitorReplacementAttemptedRef.current = true
        clearVisitorSession()
        inviteJoinSessionRef.current = undefined
        joinSession = await createVisitor()
        if (operationGenerationRef.current !== operationGeneration) return
        inviteJoinSessionRef.current = joinSession
        saveVisitorSession(joinSession)
        dispatch({ type: 'visitor:ready', session: joinSession })
        bootstrap = await joinRoom({
          roomCode: code,
          visitorToken: joinSession.token,
          iceMode: roomIceMode(iceMode),
          admission,
        })
      }
      if (operationGenerationRef.current !== operationGeneration) return
      const rtcConfiguration = resolveBootstrapRtcConfiguration(iceMode, bootstrap)
      assertBootstrapMembership(bootstrap, joinSession.visitor.id, 'receiver')
      roomRef.current = bootstrap.room
      dispatch({ type: 'room:joined', room: bootstrap.room })
      connectRealtime(
        joinSession,
        bootstrap,
        'receiver',
        rtcConfiguration,
        operationGeneration,
      )
      saveRoomSession({
        roomCode: bootstrap.room.code,
        role: 'receiver',
        expiresAt: bootstrap.room.expiresAt,
      })
      clearInviteIntent()
      setJoinError('')
    } catch (error) {
      if (operationGenerationRef.current !== operationGeneration) return
      const denied = error instanceof ApiClientError
        && error.code === 'ROOM_ACCESS_DENIED'
      if (denied) clearInviteIntent()
      const message = denied
        ? '邀请链接无效或已过期'
        : error instanceof Error ? error.message : '加入房间失败'
      setJoinError(message)
      showToast(message)
      dispatch({ type: 'error', message })
    }
  }, [clearInviteIntent, connectRealtime, showToast, state.session])

  const recoverReceiverRoom = useCallback(async (
    session: VisitorSession,
    roomCode: string,
  ) => {
    const operationGeneration = ++operationGenerationRef.current
    dispatch({ type: 'room:joining' })
    setJoinError('')

    try {
      const iceMode = getClientIceMode()
      const bootstrap = await joinRoom({
        roomCode,
        visitorToken: session.token,
        iceMode: roomIceMode(iceMode),
        admission: { kind: 'recovery' },
      })
      if (operationGenerationRef.current !== operationGeneration) return
      const rtcConfiguration = resolveBootstrapRtcConfiguration(iceMode, bootstrap)
      assertBootstrapMembership(bootstrap, session.visitor.id, 'receiver')
      roomRef.current = bootstrap.room
      dispatch({ type: 'room:joined', room: bootstrap.room })
      connectRealtime(
        session,
        bootstrap,
        'receiver',
        rtcConfiguration,
        operationGeneration,
      )
      saveRoomSession({
        roomCode: bootstrap.room.code,
        role: 'receiver',
        expiresAt: bootstrap.room.expiresAt,
      })
      setReceiverRecoveryIntent(undefined)
    } catch (error) {
      if (operationGenerationRef.current !== operationGeneration) return
      const failure = mapJoinError(error, 'recovery')
      if (failure.clearRecovery) {
        setReceiverRecoveryIntent(undefined)
        clearRoomSession()
        if (failure.code === 'VISITOR_NOT_FOUND') clearVisitorSession()
      } else if (failure.retryable) {
        setReceiverRecoveryIntent({ roomCode, session })
      } else {
        setReceiverRecoveryIntent(undefined)
      }
      setJoinError(failure.message)
      showToast(failure.message)
      dispatch({ type: 'error', message: failure.message })
    }
  }, [connectRealtime, showToast])

  const retryReceiverRecovery = useCallback(() => {
    if (!receiverRecoveryIntent || state.phase === 'joining') return

    void recoverReceiverRoom(
      receiverRecoveryIntent.session,
      receiverRecoveryIntent.roomCode,
    )
  }, [receiverRecoveryIntent, recoverReceiverRoom, state.phase])

  useEffect(() => {
    if (state.phase !== 'lobby' || !state.session) return
    if (roomRecoveryAttemptedRef.current) return
    roomRecoveryAttemptedRef.current = true

    const roomSession = loadRoomSession()
    if (!roomSession) return

    if (navigationSuppressesRecoveryRef.current || !bootLoadedVisitorRef.current) {
      clearRoomSession()
      return
    }

    if (Date.now() >= roomSession.expiresAt) {
      clearRoomSession()
      showToast('上次的房间已到期，请创建或加入新房间', 'info')
      return
    }

    showToast('检测到上次加入的房间，正在重新连接…', 'info')
    void recoverReceiverRoom(state.session, roomSession.roomCode)
  }, [state.phase, state.session, recoverReceiverRoom, showToast])

  const returnToManualForm = useCallback((
    intent: ManualJoinIntent,
    message = '',
  ) => {
    if (manualJoinIntentRef.current !== intent) return
    joinRequestPollerRef.current?.stop()
    joinRequestPollerRef.current = undefined
    manualJoinIntentRef.current = undefined
    setManualActionBusy(false)
    setManualReceipt(undefined)
    dispatchJoinFlow({ type: 'join:reset' })
    setJoinError(message)
    if (intent.session) dispatch({ type: 'visitor:ready', session: intent.session })
  }, [])

  const completeManualJoin = useCallback((
    intent: ManualJoinIntent,
    bootstrap: RoomSessionBootstrap,
  ) => {
    const session = intent.session
    if (
      !session
      || manualJoinIntentRef.current !== intent
      || operationGenerationRef.current !== intent.generation
    ) return
    const iceMode = getClientIceMode()
    const rtcConfiguration = resolveBootstrapRtcConfiguration(iceMode, bootstrap)
    assertBootstrapMembership(bootstrap, session.visitor.id, 'receiver')
    roomRef.current = bootstrap.room
    dispatch({ type: 'room:joined', room: bootstrap.room })
    connectRealtime(
      session,
      bootstrap,
      'receiver',
      rtcConfiguration,
      intent.generation,
    )
    saveRoomSession({
      roomCode: bootstrap.room.code,
      role: 'receiver',
      expiresAt: bootstrap.room.expiresAt,
    })
    setJoinError('')
  }, [connectRealtime])

  const failManualOperation = useCallback((
    intent: ManualJoinIntent,
    receipt: RoomJoinRequestReceipt | undefined,
    error: unknown,
  ) => {
    if (manualJoinIntentRef.current !== intent) return
    const message = error instanceof Error ? error.message : '加入房间失败'
    const retryable = !(error instanceof ApiClientError)
      || error.code === 'UNKNOWN_API_ERROR'
      || error.status === 429
      || error.status >= 500
    if (!retryable) {
      returnToManualForm(intent, message)
      showToast(message)
      return
    }
    if (receipt) setManualReceipt(receipt)
    if (receipt) dispatchJoinFlow({ type: 'manual:receipt', receipt })
    dispatchJoinFlow({
      type: 'join:error',
      roomCode: intent.roomCode,
      code: error instanceof ApiClientError ? error.code : 'NETWORK_ERROR',
      message,
      retryable: true,
    })
    setManualActionBusy(false)
    setJoinError(message)
    showToast(message)
  }, [returnToManualForm, showToast])

  const recoverFinalizedManualJoin = useCallback(async (
    intent: ManualJoinIntent,
    receipt: RoomJoinRequestReceipt,
  ) => {
    const session = intent.session
    if (
      !session
      || manualJoinIntentRef.current !== intent
      || intent.strictRecoveryAttempted
    ) return
    intent.strictRecoveryAttempted = true
    setManualActionBusy(true)
    try {
      const iceMode = getClientIceMode()
      const bootstrap = await joinRoom({
        roomCode: intent.roomCode,
        visitorToken: session.token,
        iceMode: roomIceMode(iceMode),
        admission: { kind: 'recovery' },
      })
      completeManualJoin(intent, bootstrap)
    } catch (error) {
      if (manualJoinIntentRef.current !== intent) return
      const retryable = !(error instanceof ApiClientError)
        || error.code === 'UNKNOWN_API_ERROR'
        || error.status === 429
        || error.status >= 500
      if (retryable) intent.strictRecoveryAttempted = false
      failManualOperation(intent, receipt, error)
    }
  }, [completeManualJoin, failManualOperation])
  recoverManualRef.current = (intent, receipt) => {
    void recoverFinalizedManualJoin(intent, receipt)
  }

  const finalizeManualJoin = useCallback(async (
    intent: ManualJoinIntent,
    receipt: RoomJoinRequestReceipt,
  ) => {
    const session = intent.session
    if (!session || manualJoinIntentRef.current !== intent) return
    joinRequestPollerRef.current?.stop()
    joinRequestPollerRef.current = undefined
    setManualActionBusy(true)
    try {
      const iceMode = getClientIceMode()
      const bootstrap = await finalizeRoomJoinRequest({
        roomCode: intent.roomCode,
        requestId: receipt.requestId,
        visitorToken: session.token,
        iceMode: roomIceMode(iceMode),
      })
      completeManualJoin(intent, bootstrap)
    } catch (error) {
      if (manualJoinIntentRef.current !== intent) return
      if (
        error instanceof ApiClientError
        && error.code === 'ROOM_JOIN_REQUEST_NOT_FOUND'
        && !intent.strictRecoveryAttempted
      ) {
        recoverManualRef.current(intent, {
          ...receipt,
          state: 'finalized',
        })
        return
      }
      failManualOperation(intent, receipt, error)
    }
  }, [completeManualJoin, failManualOperation])
  finalizeManualRef.current = (intent, receipt) => {
    void finalizeManualJoin(intent, receipt)
  }

  const applyManualReceipt = useCallback((
    receipt: RoomJoinRequestReceipt,
    intent: ManualJoinIntent,
  ) => {
    if (manualJoinIntentRef.current !== intent) return
    const wasBound = intent.requestId !== undefined
    intent.requestId = receipt.requestId
    intent.expiresAt = receipt.expiresAt
    setManualReceipt(receipt)
    dispatchJoinFlow(wasBound
      ? { type: 'manual:receipt', receipt }
      : { type: 'manual:awaiting', roomCode: intent.roomCode, receipt })
    setManualActionBusy(false)

    if (receipt.state === 'pending') {
      if (!joinRequestPollerRef.current) startManualPollerRef.current(intent)
      return
    }
    if (receipt.state === 'approved') {
      finalizeManualRef.current(intent, receipt)
      return
    }
    if (receipt.state === 'finalized') {
      recoverManualRef.current(intent, receipt)
      return
    }
    const message = receipt.state === 'rejected'
      ? '发送者拒绝了加入申请'
      : receipt.state === 'expired'
        ? '加入申请已过期'
        : '加入申请已取消'
    returnToManualForm(intent, message)
    showToast(message, 'info')
  }, [returnToManualForm, showToast])
  applyManualReceiptRef.current = applyManualReceipt

  const startManualPoller = useCallback((intent: ManualJoinIntent) => {
    const session = intent.session
    const requestId = intent.requestId
    if (!session || !requestId || manualJoinIntentRef.current !== intent) return
    joinRequestPollerRef.current?.stop()
    const poller = createJoinRequestPoller({
      read: () => getRoomJoinRequest({
        roomCode: intent.roomCode,
        requestId,
        visitorToken: session.token,
      }),
      onReceipt: receipt => applyManualReceiptRef.current(receipt, intent),
      onError: error => failManualOperation(
        intent,
        {
          requestId,
          state: 'pending',
          expiresAt: intent.expiresAt ?? Date.now(),
        },
        error,
      ),
    })
    joinRequestPollerRef.current = poller
    poller.start()
  }, [failManualOperation])
  startManualPollerRef.current = startManualPoller

  const requestManualJoin = useCallback(async (code: string) => {
    if (!state.session) return
    abandonReceiverRecovery()
    setManualRoomCode(code)
    setJoinError('')
    let intent = manualJoinIntentRef.current
    if (!intent || intent.roomCode !== code) {
      resetManualIntent()
      intent = {
        roomCode: code,
        generation: ++operationGenerationRef.current,
        strictRecoveryAttempted: false,
      }
      manualJoinIntentRef.current = intent
    }
    dispatchJoinFlow({ type: 'manual:requesting', roomCode: code })
    setManualActionBusy(true)
    try {
      if (!intent.session) {
        const session = await createVisitor()
        if (manualJoinIntentRef.current !== intent) return
        intent.session = session
        saveVisitorSession(session)
        dispatch({ type: 'visitor:ready', session })
      }
      const receipt = await createRoomJoinRequest({
        roomCode: code,
        visitorToken: intent.session.token,
      })
      applyManualReceiptRef.current(receipt, intent)
    } catch (error) {
      failManualOperation(intent, undefined, error)
    }
  }, [
    abandonReceiverRecovery,
    failManualOperation,
    resetManualIntent,
    state.session,
  ])

  const handleJoinRoom = useCallback((code: string) => {
    if (inviteIntentRef.current) return joinInvitedRoom(code)
    return requestManualJoin(code)
  }, [joinInvitedRoom, requestManualJoin])

  const retryManualJoin = useCallback(() => {
    const intent = manualJoinIntentRef.current
    if (!intent) return
    setJoinError('')
    const receipt = manualReceipt
    if (!receipt) {
      void requestManualJoin(intent.roomCode)
      return
    }
    if (receipt.state === 'pending') {
      startManualPollerRef.current(intent)
      return
    }
    if (receipt.state === 'approved') {
      finalizeManualRef.current(intent, receipt)
      return
    }
    if (receipt.state === 'finalized') {
      recoverManualRef.current(intent, receipt)
    }
  }, [manualReceipt, requestManualJoin])

  const cancelManualJoin = useCallback(async (changeRoom: boolean) => {
    const intent = manualJoinIntentRef.current
    const session = intent?.session
    const receipt = manualReceipt
    if (!intent || !session || !receipt) return
    joinRequestPollerRef.current?.stop()
    setManualActionBusy(true)
    try {
      const cancelled = await cancelRoomJoinRequest({
        roomCode: intent.roomCode,
        requestId: receipt.requestId,
        visitorToken: session.token,
      })
      if (manualJoinIntentRef.current !== intent) return
      if (cancelled.state === 'cancelled') {
        if (changeRoom) setManualRoomCode('')
        returnToManualForm(intent)
        return
      }
      applyManualReceiptRef.current(cancelled, intent)
    } catch (error) {
      if (manualJoinIntentRef.current !== intent) return
      const message = error instanceof Error ? error.message : '取消加入申请失败'
      dispatchJoinFlow({
        type: 'join:error',
        roomCode: intent.roomCode,
        code: error instanceof ApiClientError ? error.code : 'NETWORK_ERROR',
        message,
        retryable: true,
      })
      setManualActionBusy(false)
      setJoinError(message)
      showToast(message)
    }
  }, [manualReceipt, returnToManualForm, showToast])

  const startActivity = useCallback((activity: OutgoingActivity) => {
    clearTerminalHold()
    let next = applyTransferAction({ type: 'activity:start', activity })
    const pendingEvents = pendingOutgoingEventsRef.current
    pendingOutgoingEventsRef.current = []
    for (const event of pendingEvents) {
      if (!('transferId' in event) || event.transferId !== activity.transferId) {
        continue
      }
      next = applyTransferAction({ type: 'peer-session:event', event })
    }
    armTerminalHold(next.activity)
  }, [applyTransferAction, armTerminalHold, clearTerminalHold])

  const handleSendText = useCallback(async (
    text: string,
    peerIds: readonly string[],
  ) => {
    const peerSession = peerSessionRef.current
    if (!peerSession) throw new Error('点对点连接尚未就绪')
    outgoingOfferInFlightRef.current = true
    pendingOutgoingEventsRef.current = []
    let result: ReturnType<PeerSession['offerText']>
    try {
      result = peerSession.offerText(text, peerIds)
    } catch (error) {
      pendingOutgoingEventsRef.current = []
      throw error
    } finally {
      outgoingOfferInFlightRef.current = false
    }
    outgoingPayloadRef.current = {
      kind: 'text',
      text,
      peerIds: result.peerIds,
    }
    startActivity(createActivity({
      generation: ++transferGenerationRef.current,
      transferId: result.transferId,
      kind: 'text',
      peerIds: result.peerIds,
      unsupportedPeerIds: result.unsupportedPeerIds,
    }))
    showToast(
      result.peerCount === 1
        ? '已向 1 位接收者发送文本'
        : `已向 ${String(result.peerCount)} 位接收者发送文本`,
      'info',
    )
  }, [showToast, startActivity])

  const handleFilesAdded = useCallback((files: readonly File[]) => {
    if (transferUiStateRef.current.activity) return
    const result = addFileSelections(
      fileSelectionsRef.current,
      files,
      createFileId,
    )
    if (!result.ok) {
      setSelectionError(result.message)
      return
    }
    replaceFileSelections(result.selections)
    setSelectionError('')
  }, [replaceFileSelections])

  const handleFileRemoved = useCallback((fileId: string) => {
    if (transferUiStateRef.current.activity) return
    replaceFileSelections(removeFileSelection(fileSelectionsRef.current, fileId))
    setSelectionError('')
  }, [replaceFileSelections])

  const handleSendFiles = useCallback(async (peerIds: readonly string[]) => {
    const peerSession = peerSessionRef.current
    if (!peerSession) throw new Error('点对点连接尚未就绪')
    const selections = fileSelectionsRef.current
    if (selections.length === 0) throw new Error('请先选择文件')
    clearFileSpeedPresentation()
    outgoingOfferInFlightRef.current = true
    pendingOutgoingEventsRef.current = []
    let result: ReturnType<PeerSession['offerFiles']>
    try {
      result = peerSession.offerFiles(selections, peerIds)
    } catch (error) {
      pendingOutgoingEventsRef.current = []
      throw error
    } finally {
      outgoingOfferInFlightRef.current = false
    }
    outgoingPayloadRef.current = {
      kind: 'file',
      selections,
      peerIds: result.peerIds,
    }
    startActivity(createActivity({
      generation: ++transferGenerationRef.current,
      transferId: result.transferId,
      kind: 'file',
      peerIds: result.peerIds,
      unsupportedPeerIds: result.unsupportedPeerIds,
      fileIds: selections.map(selection => selection.fileId),
    }))
    showToast(
      result.peerCount === 1
        ? '已向 1 位接收者发送文件请求'
        : `已向 ${String(result.peerCount)} 位接收者发送文件请求`,
      'info',
    )
  }, [clearFileSpeedPresentation, showToast, startActivity])

  const retryOutgoingTransfer = useCallback(async () => {
    const payload = outgoingPayloadRef.current
    const peerSession = peerSessionRef.current
    if (!payload || !peerSession) throw new Error('没有可重试的传输')

    const readyPeerIds = new Set(peerSession.readyPeerIds())
    const targetPeerIds = payload.peerIds.filter(peerId => readyPeerIds.has(peerId))
    if (targetPeerIds.length === 0) {
      throw new Error('选中的接收者已断开，请重新选择')
    }

    clearFileSpeedPresentation()
    outgoingOfferInFlightRef.current = true
    pendingOutgoingEventsRef.current = []
    try {
      if (payload.kind === 'text') {
        const result = peerSession.offerText(payload.text, targetPeerIds)
        outgoingPayloadRef.current = {
          kind: 'text',
          text: payload.text,
          peerIds: result.peerIds,
        }
        startActivity(createActivity({
          generation: ++transferGenerationRef.current,
          transferId: result.transferId,
          kind: 'text',
          peerIds: result.peerIds,
          unsupportedPeerIds: result.unsupportedPeerIds,
        }))
        return
      }

      const result = peerSession.offerFiles(payload.selections, targetPeerIds)
      outgoingPayloadRef.current = {
        kind: 'file',
        selections: payload.selections,
        peerIds: result.peerIds,
      }
      startActivity(createActivity({
        generation: ++transferGenerationRef.current,
        transferId: result.transferId,
        kind: 'file',
        peerIds: result.peerIds,
        unsupportedPeerIds: result.unsupportedPeerIds,
        fileIds: payload.selections.map(selection => selection.fileId),
      }))
    } catch (error) {
      pendingOutgoingEventsRef.current = []
      throw error
    } finally {
      outgoingOfferInFlightRef.current = false
    }
  }, [clearFileSpeedPresentation, startActivity])

  const dismissTransferResult = useCallback(() => {
    const activity = transferUiStateRef.current.activity
    if (!isTerminalActivity(activity) || !activity) return
    clearTerminalHold()
    outgoingPayloadRef.current = undefined
    clearFileSpeedPresentation()
    applyTransferAction({
      type: 'terminal:clear',
      generation: activity.generation,
      transferId: activity.transferId,
    })
  }, [applyTransferAction, clearFileSpeedPresentation, clearTerminalHold])

  const handleCancelTransfer = useCallback(() => {
    const activity = transferUiStateRef.current.activity
    if (!activity) return
    if (!peerSessionRef.current?.cancelTransfer(activity.transferId)) {
      showToast('无法取消当前传输')
      return
    }
    progressSchedulerRef.current?.clear()
    clearFileSpeedPresentation()
  }, [clearFileSpeedPresentation, showToast])

  const handleCloseText = useCallback(() => {
    if (incomingTextsRef.current.length === 0) return
    textCopyOperationRef.current += 1
    replaceIncomingTexts(incomingTextsRef.current.slice(1))
    setTextCopyStatus('idle')
  }, [replaceIncomingTexts])

  const handleCopyText = useCallback(async () => {
    const current = incomingTextsRef.current[0]
    if (!current) return
    const operation = ++textCopyOperationRef.current
    setTextCopyStatus('copying')

    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(current.text)
      if (
        textCopyOperationRef.current === operation
        && incomingTextsRef.current[0] === current
      ) {
        setTextCopyStatus('copied')
      }
    } catch {
      if (
        textCopyOperationRef.current === operation
        && incomingTextsRef.current[0] === current
      ) {
        setTextCopyStatus('error')
        showToast('无法复制文本，请手动复制')
      }
    }
  }, [showToast])

  const handleAcceptFiles = useCallback(() => {
    const current = incomingFileRef.current
    if (!current || current.state.status !== 'pending') return
    const accepted = peerSessionRef.current?.acceptFiles(
      current.peerId,
      current.transferId,
    )
    if (!accepted) {
      clearFileSpeedPresentation()
      replaceIncomingFile({
        ...current,
        state: { status: 'error', message: '连接已断开，请退出后重新加入房间接收文件。' },
      })
      setReceiverPanelState({
        status: 'error',
        message: '连接已断开，请退出后重新加入房间接收文件。',
      })
      return
    }
    replaceIncomingFile({
      ...current,
      state: {
        status: 'receiving',
        progressByFileId: Object.fromEntries(
          current.files.map(file => [
            file.fileId,
            file.byteLength === 0 ? 1 : 0,
          ]),
        ),
      },
    })
    setReceiverPanelState({ status: 'receiving' })
  }, [clearFileSpeedPresentation, replaceIncomingFile])

  const handleRejectFiles = useCallback(() => {
    const current = incomingFileRef.current
    if (!current || current.state.status !== 'pending') return
    const { peerId, transferId } = current
    clearFileSpeedPresentation()
    replaceIncomingFile()
    setReceiverPanelState({ status: 'waiting' })
    peerSessionRef.current?.rejectFiles(peerId, transferId)
  }, [clearFileSpeedPresentation, replaceIncomingFile])

  const handleCancelFiles = useCallback(() => {
    const current = incomingFileRef.current
    if (!current || current.state.status !== 'receiving') return
    const { transferId } = current
    progressSchedulerRef.current?.clear()
    clearFileSpeedPresentation()
    replaceIncomingFile()
    setReceiverPanelState({ status: 'waiting' })
    peerSessionRef.current?.cancelTransfer(transferId)
  }, [clearFileSpeedPresentation, replaceIncomingFile])

  const handleCloseFiles = useCallback(() => {
    const current = incomingFileRef.current
    if (!current) return
    if (current.state.status === 'received') {
      for (const file of current.state.files) revokeObjectUrl(file.url)
    }
    clearFileSpeedPresentation()
    replaceIncomingFile()
    setReceiverPanelState({ status: 'waiting' })
  }, [clearFileSpeedPresentation, replaceIncomingFile, revokeObjectUrl])

  const handleLeaveRoom = useCallback(() => {
    const session = state.session
    const room = roomRef.current
    if (!session || !room) return

    const activity = transferUiStateRef.current.activity
    if (activity) {
      peerSessionRef.current?.cancelTransfer(activity.transferId)
    }

    const activeIncomingFile = incomingFileRef.current
    if (activeIncomingFile?.state.status === 'pending') {
      peerSessionRef.current?.rejectFiles(
        activeIncomingFile.peerId,
        activeIncomingFile.transferId,
      )
    } else if (activeIncomingFile?.state.status === 'receiving') {
      peerSessionRef.current?.cancelTransfer(activeIncomingFile.transferId)
    }

    realtimeRef.current?.send({
      type: 'room:leave',
      roomCode: room.code,
    })
    ++operationGenerationRef.current
    disposeRoomResources()
    dispatch({ type: 'visitor:ready', session })
    showToast(
      state.role === 'sender' ? '房间已关闭' : '已退出房间',
      'info',
    )
  }, [disposeRoomResources, showToast, state.role, state.session])

  const handleCopyRoomCode = useCallback(async (value: string) => {
    const isRoomCode = /^[0-9]{6}$/u.test(value)
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(value)
      showToast(isRoomCode ? '房间码已复制' : '房间链接已复制', 'success')
    } catch {
      showToast(isRoomCode ? '无法复制房间码，请手动复制' : '无法复制房间链接，请手动复制')
      throw new Error('room share copy failed')
    }
  }, [showToast])

  const decideSenderJoinRequest = useCallback(async (
    requestId: string,
    decision: 'approve' | 'reject',
  ) => {
    const session = state.session
    const room = roomRef.current
    if (!session || !room || state.role !== 'sender' || roomAccess.decision) return
    dispatchRoomAccess({ type: 'decision:start', requestId, decision })
    try {
      const receipt = await decideRoomJoinRequest({
        roomCode: room.code,
        requestId,
        visitorToken: session.token,
        decision,
      })
      if (
        roomRef.current?.code !== room.code
        || state.role !== 'sender'
      ) return
      if (receipt.state === 'pending') {
        dispatchRoomAccess({ type: 'decision:finish', requestId })
      } else {
        dispatchRoomAccess({ type: 'resolved', requestId })
      }
    } catch (error) {
      dispatchRoomAccess({ type: 'decision:finish', requestId })
      showToast(error instanceof Error ? error.message : '处理加入申请失败')
    }
  }, [roomAccess.decision, showToast, state.role, state.session])

  const handleOpenShare = useCallback(() => {
    const room = roomRef.current
    const ownerInvite = ownerInviteRef.current
    if (
      !room
      || !ownerInvite
      || ownerInvite.roomCode !== room.code
      || ownerInvite.capability.expiresAt !== room.expiresAt
    ) return

    setShareDialog({
      roomCode: room.code,
      roomUrl: buildRoomInviteUrl(
        window.location.href,
        room.code,
        ownerInvite.capability.token,
      ),
    })
  }, [])

  const roomView = state.session && state.room && state.phase !== 'lobby'
    ? { session: state.session, room: state.room }
    : undefined
  const activeText = incomingTexts[0]
  const receiverSender = senderFromRoom(roomView?.room)
  const roomReceivers = receiversFromRoom(roomView?.room)
  const readyPeerIdSet = new Set(state.readyPeerIds)
  const connectedReceivers = roomReceivers.filter(receiver => readyPeerIdSet.has(receiver.id))
  const activeInviteCode = joinMode === 'invite'
    ? inviteIntentRef.current?.roomCode
    : undefined
  const initialJoinCode = activeInviteCode ?? manualRoomCode
  const canShareOwnerInvite = state.role === 'sender'
    && ownerInviteRoomCode === roomView?.room.code
  const manualWaitingReceipt = manualReceipt
  const manualWaitingVisitor = manualJoinIntentRef.current?.session?.visitor
    ?? state.session?.visitor
  const senderJoinRequest = roomAccess.requests[0]

  return (
    <div className="min-h-svh bg-surface px-4 py-6 text-amber-50 sm:flex sm:items-center sm:justify-center">
      <main className="mx-auto flex min-h-[calc(100svh-3rem)] w-full items-center justify-center sm:min-h-0">
        {state.phase === 'booting' && <Loading />}

        {!roomView
          && state.phase !== 'booting'
          && manualWaitingReceipt
          && manualWaitingVisitor && (
          <ManualJoinWaiting
            visitor={manualWaitingVisitor}
            roomCode={manualJoinIntentRef.current?.roomCode ?? manualRoomCode}
            expiresAt={manualWaitingReceipt.expiresAt}
            busy={manualActionBusy}
            error={joinFlow.status.kind === 'error'
              ? joinFlow.status.message
              : undefined}
            onCancel={() => { void cancelManualJoin(false) }}
            onChangeRoom={() => { void cancelManualJoin(true) }}
            onRetry={joinFlow.status.kind === 'error' ? retryManualJoin : undefined}
          />
        )}

        {!roomView
          && state.phase !== 'booting'
          && state.session
          && !manualWaitingReceipt && (
          <div className="flex w-full max-w-sm flex-col">
            {receiverRecoveryIntent && (
              <RoomRecoveryPrompt
                roomCode={receiverRecoveryIntent.roomCode}
                busy={state.phase === 'joining'}
                onRetry={retryReceiverRecovery}
              />
            )}
            <RoomJoin
              busy={state.phase === 'joining' || manualActionBusy}
              initialCode={initialJoinCode}
              mode={joinMode}
              error={joinError || state.error || undefined}
             onCreateRoom={handleCreateRoom}
             onSubmit={handleJoinRoom}
             onCodeEdited={handleRoomCodeEdited}
           />
            <button
              type="button"
              className="mt-5 min-h-11 self-center px-3 text-xs text-amber-50/50 transition-colors hover:text-amber-50/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => setAboutOpen(true)}
            >
              关于 P2P Transmission
            </button>
          </div>
        )}

        {!roomView && !state.session && state.phase === 'error' && (
          <section className="flex w-full max-w-sm flex-col items-center text-center" aria-labelledby="boot-error-title">
            <span className="material-symbols-outlined text-amber-50/40" style={{ fontSize: '28px' }} aria-hidden="true">cloud_off</span>
            <h1 id="boot-error-title" className="mt-4 text-sm font-normal text-amber-50/80">暂时无法连接服务器</h1>
            <p role="alert" className="mt-2 text-xs leading-5 text-amber-50/60">请检查网络后重试；当前页面不会创建未建立的会话。</p>
            <button
              type="button"
              className="mt-5 min-h-11 w-full rounded-xl border border-accent bg-accent px-4 text-sm tracking-wider text-white/90 transition-[filter] hover:brightness-110 active:brightness-90 focus-visible:outline-none"
              onClick={() => {
                dispatch({ type: 'boot:retry' })
                setBootAttempt(attempt => attempt + 1)
              }}
            >
              重试连接
            </button>
          </section>
        )}

        {roomView && (
          <div className="flex w-[calc(100vw-2rem)] max-w-xl flex-col gap-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-amber-50/50">房间码</span>
                  <RoomExpiryCountdown
                    expiresAt={roomView.room.expiresAt}
                  />
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <RoomCodeCopyButton
                    code={roomView.room.code}
                    onCopy={handleCopyRoomCode}
                  />
                  {canShareOwnerInvite && (
                    <button
                      type="button"
                       className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-transparent text-amber-50/50 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
                      onClick={handleOpenShare}
                      aria-label="分享房间"
                      title="分享房间"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: '17px' }} aria-hidden="true">qr_code_scanner</span>
                    </button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 text-right text-xs">
                <div>
                  <div className="text-amber-50/50">
                    {state.role === 'sender' ? '发送者' : '接收者'}
                  </div>
                   <div className="mt-0.5 text-amber-50/60">
                     {state.readyPeerIds.length > 0 ? '点对点已连接' : '正在建立点对点连接'}
                   </div>
                 </div>
                 <button
                   type="button"
                   className="flex size-11 shrink-0 items-center justify-center rounded-full border border-transparent text-amber-50/50 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
                   onClick={() => setAboutOpen(true)}
                   aria-label="关于 P2P Transmission"
                   title="关于 P2P Transmission"
                 >
                   <span className="material-symbols-outlined" style={{ fontSize: '17px' }} aria-hidden="true">info</span>
                 </button>
                 {state.role === 'receiver' && (
                  <button
                    type="button"
                     className="flex size-11 shrink-0 items-center justify-center rounded-full border border-transparent text-amber-50/50 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
                    onClick={handleLeaveRoom}
                    aria-label="退出房间"
                    title="退出房间"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '17px' }} aria-hidden="true">logout</span>
                  </button>
                )}
              </div>
            </div>

            {state.role === 'sender' ? (
              <TransferPanel
                visitor={roomView.session.visitor}
                receivers={connectedReceivers}
                activity={transferUiState.activity}
                files={fileSelections}
                selectionError={selectionError}
                fileSpeedData={fileSpeedData}
                onFilesAdded={handleFilesAdded}
                onFileRemoved={handleFileRemoved}
                onSendText={handleSendText}
                onSendFiles={handleSendFiles}
                onCancel={handleCancelTransfer}
                onRetry={retryOutgoingTransfer}
                onDismissActivity={dismissTransferResult}
              />
            ) : (
              <ReceiverPanel
                visitor={roomView.session.visitor}
                sender={receiverSender}
                receivers={roomReceivers}
                state={receiverPanelState}
              />
            )}
          </div>
        )}
      </main>

      {activeText && (
        <ReceivedTextDialog
          sender={activeText.sender}
          text={activeText.text}
          copyStatus={textCopyStatus}
          onCopy={() => { void handleCopyText() }}
          onClose={handleCloseText}
        />
      )}

      {incomingFile && (
        <IncomingFileRequestDialog
          sender={incomingFile.sender}
          files={incomingFile.files}
          state={incomingFile.state}
          fileSpeedData={fileSpeedData}
          onAccept={handleAcceptFiles}
          onReject={handleRejectFiles}
          onCancel={handleCancelFiles}
          onClose={handleCloseFiles}
        />
      )}

      <ToastViewport toast={toastState} onDismiss={dismissToast} />

      {shareDialog && (
        <ShareDialog
          roomCode={shareDialog.roomCode}
          roomUrl={shareDialog.roomUrl}
          onCopy={handleCopyRoomCode}
          onClose={() => setShareDialog(undefined)}
        />
      )}

      {aboutOpen && (
        <AboutDialog
          version={appVersion}
          onClose={() => setAboutOpen(false)}
        />
      )}

      {roomView?.room.code === senderJoinRequest?.roomCode
        && state.role === 'sender'
        && senderJoinRequest && (
        <SenderJoinRequestDialog
          request={senderJoinRequest}
          remainingCount={Math.max(0, roomAccess.requests.length - 1)}
          pendingDecision={roomAccess.decision?.requestId === senderJoinRequest.requestId
            ? roomAccess.decision.decision
            : undefined}
          onApprove={requestId => {
            void decideSenderJoinRequest(requestId, 'approve')
          }}
          onReject={requestId => {
            void decideSenderJoinRequest(requestId, 'reject')
          }}
        />
      )}
    </div>
  )
}

export default App
