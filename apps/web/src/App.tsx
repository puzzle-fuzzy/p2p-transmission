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
import Loading from './components/Loading'
import ReceivedTextDialog, {
  type ReceivedTextCopyStatus,
} from './components/ReceivedTextDialog'
import ReceiverPanel, {
  type ReceiverPanelState,
} from './components/ReceiverPanel'
import RoomCodeCopyButton from './components/RoomCodeCopyButton'
import RoomJoin from './components/RoomJoin'
import TransferPanel from './components/TransferPanel'
import ToastViewport from './components/ui/Toast'
import { useToast } from './components/ui/useToast'
import {
  initialRoomFlowState,
  roomFlowReducer,
} from './features/room/state'
import {
  createRoomSessionLifecycle,
  type RoomSessionLifecycle,
} from './features/room/session-lifecycle'
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
  createRoom,
  createVisitor,
  joinRoom,
} from './lib/api-client'
import {
  getClientIceMode,
  resolveBootstrapRtcConfiguration,
  roomIceMode,
} from './lib/config'
import {
  createRealtimeClient,
  type RealtimeClient,
} from './lib/realtime-client'
import {
  clearVisitorSession,
  loadVisitorSession,
  saveVisitorSession,
} from './lib/visitor-session'
import type {
  ParticipantRole,
  PublicRoom,
  PublicVisitor,
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

function App() {
  const [state, dispatch] = useReducer(roomFlowReducer, initialRoomFlowState)
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
  const peerRetryCountsRef = useRef(new Map<string, number>())
  const peerRetryTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>())
  const bootedRef = useRef(false)

  const replaceFileSelections = useCallback((selections: FileSelection[]) => {
    fileSelectionsRef.current = selections
    setFileSelections(selections)
  }, [])

  const replaceIncomingTexts = useCallback((texts: IncomingText[]) => {
    incomingTextsRef.current = texts
    setIncomingTexts(texts)
  }, [])

  const replaceIncomingFile = useCallback((file?: IncomingFileTransfer) => {
    incomingFileRef.current = file
    setIncomingFile(file)
  }, [])

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
    for (const event of events) {
      nextTransferState = transferUiReducer(nextTransferState, {
        type: 'peer-session:event',
        event,
      })
    }
    if (nextTransferState !== transferUiStateRef.current) {
      transferUiStateRef.current = nextTransferState
      setTransferUiState(nextTransferState)
    }

    const current = incomingFileRef.current
    if (!current || current.state.status !== 'receiving') return

    const progress = events.reduce((maximum, event) => {
      if (
        event.direction !== 'receiving'
        || event.peerId !== current.peerId
        || event.transferId !== current.transferId
      ) {
        return maximum
      }
      if (event.batchTotalBytes <= 0) return maximum
      return Math.max(maximum, event.batchBytes / event.batchTotalBytes * 100)
    }, current.state.progress)

    if (progress === current.state.progress) return
    replaceIncomingFile({
      ...current,
      state: { status: 'receiving', progress: Math.min(100, progress) },
    })
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
    if (
      terminalHoldIdentityRef.current === identity
      && terminalHoldTimerRef.current !== undefined
    ) {
      return
    }

    clearTerminalHold()
    terminalHoldIdentityRef.current = identity
    terminalHoldTimerRef.current = setTimeout(() => {
      terminalHoldTimerRef.current = undefined
      terminalHoldIdentityRef.current = undefined
      const current = transferUiStateRef.current.activity
      if (
        current?.generation !== activity.generation
        || current.transferId !== activity.transferId
      ) {
        return
      }
      applyTransferAction({
        type: 'terminal:clear',
        generation: activity.generation,
        transferId: activity.transferId,
      })
    }, 400)
  }, [applyTransferAction, clearTerminalHold])

  const resetTransferPresentation = useCallback((
    action: Extract<TransferUiAction, { type: 'room:reset' | 'realtime:disconnected' }>,
  ) => {
    clearTerminalHold()
    progressSchedulerRef.current?.clear()
    revokeAllObjectUrls()
    textCopyOperationRef.current += 1
    outgoingOfferInFlightRef.current = false
    pendingOutgoingEventsRef.current = []
    replaceIncomingTexts([])
    replaceIncomingFile()
    replaceFileSelections([])
    setSelectionError('')
    setTextCopyStatus('idle')
    setReceiverPanelState({ status: 'waiting' })
    applyTransferAction(action)
  }, [
    applyTransferAction,
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

  const disposeRoomResources = useCallback(() => {
    disposeRoomLifecycle()
    const realtime = realtimeRef.current
    realtimeRef.current = undefined
    realtime?.close()
    disposePeerSession()
    roomRef.current = undefined
    resetTransferPresentation({ type: 'room:reset' })
  }, [disposePeerSession, disposeRoomLifecycle, resetTransferPresentation])

  useEffect(() => {
    if (!bootedRef.current) {
      bootedRef.current = true

      const boot = async () => {
        try {
          const existingSession = loadVisitorSession()
          if (existingSession) {
            dispatch({ type: 'visitor:ready', session: existingSession })
            return
          }

          const session = await createVisitor()
          saveVisitorSession(session)
          dispatch({ type: 'visitor:ready', session })
        } catch {
          showToast('无法连接服务')
          dispatch({ type: 'error', message: '无法连接服务' })
        }
      }

      void boot()
    }

    return () => {
      const realtime = realtimeRef.current
      realtimeRef.current = undefined
      realtime?.close()
      disposeRoomLifecycle()
      disposePeerSession()
      disposeBrowserTransferResources()
    }
  }, [
    disposeBrowserTransferResources,
    disposePeerSession,
    disposeRoomLifecycle,
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

    const client = createRealtimeClient({ token: session.token })
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
        showToast('房间已到期，请重新创建或加入', 'info')
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
        const next = applyTransferAction({ type: 'peer-session:event', event })
        armTerminalHold(next.activity)
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
            type: 'peer:ready-count',
            count: peerSession.readyPeerCount(),
          })
          if (event.state === 'ready') {
            peerRetryCountsRef.current.delete(event.peerId)
          }
          if (event.state === 'closed') {
            progressSchedulerRef.current?.clear()
            applyOutgoingEvent(event)
            const currentFile = incomingFileRef.current
            if (currentFile?.peerId === event.peerId) {
              failIncomingFile(
                currentFile.peerId,
                currentFile.transferId,
                '发送者已离开，文件传输已取消。',
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
              showToast('已有文件请求正在处理，新的请求已拒绝', 'info')
            }
            return
          }

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
            replaceIncomingFile({
              ...current,
              state: { status: 'received', files },
            })
            setReceiverPanelState({ status: 'waiting' })
            showToast('文件接收完成', 'success')
          } catch {
            for (const url of createdUrls) revokeObjectUrl(url)
            failIncomingFile(event.peerId, event.transferId, '无法准备文件下载，请重新接收。')
          }
          return
        }

        if (event.type === 'transfer:terminal') {
          progressSchedulerRef.current?.clear()
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
            : '房间已过期，请重新创建或加入',
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
            showToast('访客会话已刷新，请重新加入房间', 'info')
          })
          .catch(() => {
            if (operationGenerationRef.current !== recoveryGeneration) return
            dispatch({ type: 'visitor:ready', session })
            showToast('无法恢复访客会话，请稍后重试')
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
            ? '连接已中断，请重新创建或加入房间'
            : '无法建立实时连接，请稍后重试',
        )
      }
    })

    lifecycle.start()
    if (!lifecycle.isActive()) return
    client.connect()
  }, [
    applyTransferAction,
    armTerminalHold,
    disposePeerSession,
    disposeRoomResources,
    getProgressScheduler,
    replaceIncomingFile,
    replaceIncomingTexts,
    resetTransferPresentation,
    revokeObjectUrl,
    showToast,
  ])

  const runWithFreshSession = useCallback(async <T,>(
    session: VisitorSession,
    operation: (activeSession: VisitorSession) => Promise<T>,
  ) => {
    try {
      return {
        session,
        value: await operation(session),
      }
    } catch (error) {
      if (!(error instanceof ApiClientError) || error.code !== 'VISITOR_NOT_FOUND') {
        throw error
      }
    }

    clearVisitorSession()
    const freshSession = await createVisitor()
    saveVisitorSession(freshSession)

    return {
      session: freshSession,
      value: await operation(freshSession),
    }
  }, [])

  const handleCreateRoom = useCallback(async () => {
    if (!state.session) return
    const operationGeneration = ++operationGenerationRef.current
    dispatch({ type: 'room:joining' })

    try {
      const iceMode = getClientIceMode()
      const result = await runWithFreshSession(
        state.session,
        activeSession => createRoom(activeSession.token, roomIceMode(iceMode)),
      )
      if (operationGenerationRef.current !== operationGeneration) return
      if (result.session.token !== state.session.token) {
        dispatch({ type: 'visitor:ready', session: result.session })
      }
      const rtcConfiguration = resolveBootstrapRtcConfiguration(iceMode, result.value)
      roomRef.current = result.value.room
      dispatch({ type: 'room:created', room: result.value.room })
      connectRealtime(
        result.session,
        result.value,
        'sender',
        rtcConfiguration,
        operationGeneration,
      )
    } catch (error) {
      if (operationGenerationRef.current !== operationGeneration) return
      const message = error instanceof Error ? error.message : '创建房间失败'
      showToast(message)
      dispatch({ type: 'error', message })
    }
  }, [connectRealtime, runWithFreshSession, showToast, state.session])

  const handleJoinRoom = useCallback(async (code: string) => {
    if (!state.session) return
    const operationGeneration = ++operationGenerationRef.current
    dispatch({ type: 'room:joining' })

    try {
      const iceMode = getClientIceMode()
      const result = await runWithFreshSession(
        state.session,
        activeSession => joinRoom(
          code,
          activeSession.token,
          'receiver',
          roomIceMode(iceMode),
        ),
      )
      if (operationGenerationRef.current !== operationGeneration) return
      if (result.session.token !== state.session.token) {
        dispatch({ type: 'visitor:ready', session: result.session })
      }
      const rtcConfiguration = resolveBootstrapRtcConfiguration(iceMode, result.value)
      roomRef.current = result.value.room
      dispatch({ type: 'room:joined', room: result.value.room })
      connectRealtime(
        result.session,
        result.value,
        'receiver',
        rtcConfiguration,
        operationGeneration,
      )
    } catch (error) {
      if (operationGenerationRef.current !== operationGeneration) return
      const message = error instanceof Error ? error.message : '加入房间失败'
      showToast(message)
      dispatch({ type: 'error', message })
    }
  }, [connectRealtime, runWithFreshSession, showToast, state.session])

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

  const handleSendText = useCallback(async (text: string) => {
    const peerSession = peerSessionRef.current
    if (!peerSession) throw new Error('点对点连接尚未就绪')
    outgoingOfferInFlightRef.current = true
    pendingOutgoingEventsRef.current = []
    let result: ReturnType<PeerSession['offerText']>
    try {
      result = peerSession.offerText(text)
    } catch (error) {
      pendingOutgoingEventsRef.current = []
      throw error
    } finally {
      outgoingOfferInFlightRef.current = false
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

  const handleSendFiles = useCallback(async () => {
    const peerSession = peerSessionRef.current
    if (!peerSession) throw new Error('点对点连接尚未就绪')
    const selections = fileSelectionsRef.current
    if (selections.length === 0) throw new Error('请先选择文件')
    outgoingOfferInFlightRef.current = true
    pendingOutgoingEventsRef.current = []
    let result: ReturnType<PeerSession['offerFiles']>
    try {
      result = peerSession.offerFiles(selections)
    } catch (error) {
      pendingOutgoingEventsRef.current = []
      throw error
    } finally {
      outgoingOfferInFlightRef.current = false
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
  }, [showToast, startActivity])

  const handleCancelTransfer = useCallback(() => {
    const activity = transferUiStateRef.current.activity
    if (!activity) return
    if (!peerSessionRef.current?.cancelTransfer(activity.transferId)) {
      showToast('无法取消当前传输')
    }
  }, [showToast])

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
      replaceIncomingFile({
        ...current,
        state: { status: 'error', message: '连接已中断，无法接收这些文件。' },
      })
      setReceiverPanelState({
        status: 'error',
        message: '连接已中断，无法接收这些文件。',
      })
      return
    }
    replaceIncomingFile({
      ...current,
      state: { status: 'receiving', progress: 0 },
    })
    setReceiverPanelState({ status: 'receiving' })
  }, [replaceIncomingFile])

  const handleRejectFiles = useCallback(() => {
    const current = incomingFileRef.current
    if (!current || current.state.status !== 'pending') return
    peerSessionRef.current?.rejectFiles(current.peerId, current.transferId)
    replaceIncomingFile()
    setReceiverPanelState({ status: 'waiting' })
  }, [replaceIncomingFile])

  const handleCloseFiles = useCallback(() => {
    const current = incomingFileRef.current
    if (!current) return
    if (current.state.status === 'received') {
      for (const file of current.state.files) revokeObjectUrl(file.url)
    }
    replaceIncomingFile()
    setReceiverPanelState({ status: 'waiting' })
  }, [replaceIncomingFile, revokeObjectUrl])

  const handleCopyRoomCode = useCallback(async (code: string) => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(code)
      showToast('房间码已复制', 'success')
    } catch {
      showToast('无法复制房间码，请手动复制')
      throw new Error('room code copy failed')
    }
  }, [showToast])

  const roomView = state.session && state.room && state.phase !== 'lobby'
    ? { session: state.session, room: state.room }
    : undefined
  const activeText = incomingTexts[0]
  const receiverSender = senderFromRoom(roomView?.room)
  const roomReceivers = receiversFromRoom(roomView?.room)
  const transferReceivers = transferUiState.activity
    ? transferUiState.activity.peerIds.flatMap(peerId => {
        const receiver = visitorFromRoom(roomView?.room, peerId)
        return receiver ? [receiver] : []
      })
    : roomReceivers

  return (
    <div className="min-h-svh bg-[#2d2d2d] px-4 py-6 text-amber-50 sm:flex sm:items-center sm:justify-center">
      <main className="mx-auto flex min-h-[calc(100svh-3rem)] w-full items-center justify-center sm:min-h-0">
        {state.phase === 'booting' && <Loading />}

        {!roomView && state.phase !== 'booting' && (
          <RoomJoin
            busy={state.phase === 'joining'}
            onCreateRoom={handleCreateRoom}
            onJoinRoom={handleJoinRoom}
          />
        )}

        {roomView && (
          <div className="flex w-[calc(100vw-2rem)] max-w-xl flex-col gap-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs text-amber-50/50">房间码</div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="text-xl font-mono tracking-[0.2em] text-amber-50/80 tabular-nums">
                    {roomView.room.code}
                  </div>
                  <RoomCodeCopyButton
                    code={roomView.room.code}
                    onCopy={handleCopyRoomCode}
                  />
                </div>
              </div>
              <div className="text-right text-xs">
                <div className="text-amber-50/50">
                  {state.role === 'sender' ? '发送者' : '接收者'}
                </div>
                <div className="mt-0.5 text-amber-50/60">
                  {state.readyPeerCount > 0 ? '点对点已连接' : '正在建立点对点连接'}
                </div>
              </div>
            </div>

            {state.role === 'sender' ? (
              <TransferPanel
                visitor={roomView.session.visitor}
                room={roomView.room}
                receivers={transferReceivers}
                readyPeerCount={state.readyPeerCount}
                activity={transferUiState.activity}
                files={fileSelections}
                selectionError={selectionError}
                onFilesAdded={handleFilesAdded}
                onFileRemoved={handleFileRemoved}
                onSendText={handleSendText}
                onSendFiles={handleSendFiles}
                onCancel={handleCancelTransfer}
              />
            ) : (
              <ReceiverPanel
                sender={receiverSender}
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
          onAccept={handleAcceptFiles}
          onReject={handleRejectFiles}
          onClose={handleCloseFiles}
        />
      )}

      <ToastViewport toast={toastState} onDismiss={dismissToast} />
    </div>
  )
}

export default App
