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
  createSpeedTracker,
  formatEta as formatSpeedEta,
  formatSpeed,
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
  clearRoomSession,
  loadRoomSession,
  saveRoomSession,
} from './lib/room-session'
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
  const [fileSpeedData, setFileSpeedData] = useState<Record<string, { speed: number; eta: number | undefined }>>({})
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
  const visitorBootstrapPromiseRef = useRef<Promise<VisitorSession> | undefined>(undefined)
  const roomRecoveryAttemptedRef = useRef(false)
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
      // Track speed for outgoing file transfers
      if (event.direction === 'sending') {
        tracker.record(event.fileId, event.fileBytes, event.fileTotalBytes)
      }
    }
    if (nextTransferState !== transferUiStateRef.current) {
      transferUiStateRef.current = nextTransferState
      setTransferUiState(nextTransferState)
    }

    const current = incomingFileRef.current
    if (!current || current.state.status !== 'receiving') return

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

      // Track speed for incoming files
      tracker.record(event.fileId, event.fileBytes, event.fileTotalBytes)

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

    // Update speed/ETA data for file progress display
    const newSpeedData: Record<string, { speed: number; eta: number | undefined }> = {}
    for (const event of events) {
      const speed = tracker.getSpeed(event.fileId)
      if (speed > 0) {
        const file = current?.files.find(f => f.fileId === event.fileId)
        const totalBytes = file?.byteLength ?? event.fileTotalBytes
        newSpeedData[event.fileId] = {
          speed,
          eta: tracker.getEta(event.fileId, totalBytes),
        }
      }
    }
    if (Object.keys(newSpeedData).length > 0) {
      setFileSpeedData(prev => ({ ...prev, ...newSpeedData }))
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
    setFileSpeedData({})
    speedTrackerRef.current.clear()
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
    clearRoomSession()
    resetTransferPresentation({ type: 'room:reset' })
  }, [disposePeerSession, disposeRoomLifecycle, resetTransferPresentation])

  useEffect(() => {
    const bootGeneration = operationGenerationRef.current
    const boot = async () => {
      try {
        const existingSession = loadVisitorSession()
        if (existingSession) {
          if (operationGenerationRef.current !== bootGeneration) return
          dispatch({ type: 'visitor:ready', session: existingSession })
          return
        }

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
      invalidatePendingOperations()
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
    invalidatePendingOperations,
    showToast,
  ])

  useEffect(() => {
    if (state.phase !== 'lobby' || !state.session) return
    if (roomRecoveryAttemptedRef.current) return
    roomRecoveryAttemptedRef.current = true

    const roomSession = loadRoomSession()
    if (!roomSession) return

    if (Date.now() > roomSession.expiresAt) {
      clearRoomSession()
      showToast('上次的房间已到期，请创建或加入新房间', 'info')
      return
    }

    if (roomSession.role === 'receiver') {
      showToast('检测到上次加入的房间，正在重新连接…', 'info')
      const code = roomSession.roomCode
      // Clear before joining to prevent loops
      clearRoomSession()
      handleJoinRoom(code)
    }
  }, [state.phase, state.session, handleJoinRoom, showToast])

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
            type: 'peer:ready-ids',
            peerIds: peerSession.readyPeerIds(),
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
            failIncomingFile(event.peerId, event.transferId, '文件下载准备失败，请让发送者重新发送。')
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
      saveRoomSession({
        roomCode: result.value.room.code,
        role: 'sender',
        expiresAt: result.value.room.expiresAt,
      })
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
      const joinSession = await createVisitor()
      if (operationGenerationRef.current !== operationGeneration) return
      saveVisitorSession(joinSession)
      if (joinSession.token !== state.session.token) {
        dispatch({ type: 'visitor:ready', session: joinSession })
      }
      const iceMode = getClientIceMode()
      const result = await runWithFreshSession(
        joinSession,
        activeSession => joinRoom(
          code,
          activeSession.token,
          'receiver',
          roomIceMode(iceMode),
        ),
        operationGeneration,
      )
      if (!result) return
      if (operationGenerationRef.current !== operationGeneration) return
      if (result.session.token !== state.session.token) {
        dispatch({ type: 'visitor:ready', session: result.session })
      }
      const rtcConfiguration = resolveBootstrapRtcConfiguration(iceMode, result.value)
      assertBootstrapMembership(result.value, result.session.visitor.id, 'receiver')
      roomRef.current = result.value.room
      saveRoomSession({
        roomCode: result.value.room.code,
        role: 'receiver',
        expiresAt: result.value.room.expiresAt,
      })
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
  }, [replaceIncomingFile])

  const handleRejectFiles = useCallback(() => {
    const current = incomingFileRef.current
    if (!current || current.state.status !== 'pending') return
    const { peerId, transferId } = current
    replaceIncomingFile()
    setReceiverPanelState({ status: 'waiting' })
    peerSessionRef.current?.rejectFiles(peerId, transferId)
  }, [replaceIncomingFile])

  const handleCancelFiles = useCallback(() => {
    const current = incomingFileRef.current
    if (!current || current.state.status !== 'receiving') return
    const { transferId } = current
    progressSchedulerRef.current?.clear()
    replaceIncomingFile()
    setReceiverPanelState({ status: 'waiting' })
    peerSessionRef.current?.cancelTransfer(transferId)
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
  const readyPeerIdSet = new Set(state.readyPeerIds)
  const connectedReceivers = roomReceivers.filter(receiver => readyPeerIdSet.has(receiver.id))

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
                <div className="mt-1">
                  <RoomCodeCopyButton
                    code={roomView.room.code}
                    onCopy={handleCopyRoomCode}
                  />
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
                {state.role === 'receiver' && (
                  <button
                    type="button"
                    className="flex size-9 shrink-0 items-center justify-center rounded-full border border-transparent text-amber-50/50 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
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
    </div>
  )
}

export default App
