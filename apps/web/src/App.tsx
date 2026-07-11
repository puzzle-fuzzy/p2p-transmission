import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react'
import IncomingTextRequestDialog, {
  type IncomingTextRequest,
} from './components/IncomingTextRequestDialog'
import Loading from './components/Loading'
import ReceivedTextView, {
  type ReceivedTextViewState,
} from './components/ReceivedTextView'
import RoomJoin from './components/RoomJoin'
import TransferPanel from './components/TransferPanel'
import ToastViewport from './components/ui/Toast'
import { useToast } from './components/ui/useToast'
import {
  initialRoomFlowState,
  roomFlowReducer,
} from './features/room/state'
import {
  createPeerSession,
  type PeerSession,
  type PeerSessionEvent,
} from './features/transfer/peer-session'
import {
  ApiClientError,
  createRoom,
  createVisitor,
  joinRoom,
} from './lib/api-client'
import { getRtcConfiguration } from './lib/config'
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
  VisitorSession,
} from './shared/contracts'

type QueuedTextRequest = IncomingTextRequest & {
  peerId: string
}

const requestKey = (peerId: string, transferId: string) =>
  peerId + '\u0000' + transferId

const senderFromRoom = (room?: PublicRoom) =>
  room?.participants.find(participant => participant.role === 'sender')?.visitor

const removeParticipant = (room: PublicRoom, visitorId: string): PublicRoom => ({
  ...room,
  receivers: room.receivers.filter(id => id !== visitorId),
  participants: room.participants.filter(participant =>
    participant.visitor.id !== visitorId),
})

function App() {
  const [state, dispatch] = useReducer(roomFlowReducer, initialRoomFlowState)
  const [incomingRequests, setIncomingRequests] = useState<QueuedTextRequest[]>([])
  const [receivingRequestKey, setReceivingRequestKey] = useState<string>()
  const [receiverView, setReceiverView] = useState<ReceivedTextViewState>({
    status: 'waiting',
  })
  const {
    toast: toastState,
    show: showToast,
    dismiss: dismissToast,
  } = useToast()
  const realtimeRef = useRef<RealtimeClient | undefined>(undefined)
  const peerSessionRef = useRef<PeerSession | undefined>(undefined)
  const roomRef = useRef<PublicRoom | undefined>(undefined)
  const incomingRequestsRef = useRef<QueuedTextRequest[]>([])
  const receivingRequestKeyRef = useRef<string | undefined>(undefined)
  const operationGenerationRef = useRef(0)
  const peerRetryCountsRef = useRef(new Map<string, number>())
  const peerRetryTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>())
  const bootedRef = useRef(false)

  const replaceIncomingRequests = useCallback((requests: QueuedTextRequest[]) => {
    incomingRequestsRef.current = requests
    setIncomingRequests(requests)
  }, [])

  const setReceivingRequest = useCallback((key?: string) => {
    receivingRequestKeyRef.current = key
    setReceivingRequestKey(key)
  }, [])

  const removeIncomingRequest = useCallback((peerId: string, transferId: string) => {
    replaceIncomingRequests(incomingRequestsRef.current.filter(request =>
      request.peerId !== peerId || request.transferId !== transferId))
  }, [replaceIncomingRequests])

  const disposePeerSession = useCallback(() => {
    for (const timer of peerRetryTimersRef.current) clearTimeout(timer)
    peerRetryTimersRef.current.clear()
    peerRetryCountsRef.current.clear()
    const peerSession = peerSessionRef.current
    peerSessionRef.current = undefined
    peerSession?.close()
  }, [])

  const disposeRoomResources = useCallback(() => {
    const realtime = realtimeRef.current
    realtimeRef.current = undefined
    realtime?.close()
    disposePeerSession()
    roomRef.current = undefined
    replaceIncomingRequests([])
    setReceivingRequest()
  }, [disposePeerSession, replaceIncomingRequests, setReceivingRequest])

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
      const peerSession = peerSessionRef.current
      peerSessionRef.current = undefined
      peerSession?.close()
    }
  }, [showToast])

  const connectRealtime = useCallback((
    session: VisitorSession,
    initialRoom: PublicRoom,
    role: ParticipantRole,
  ) => {
    disposeRoomResources()
    roomRef.current = initialRoom
    setReceiverView({
      status: 'waiting',
      sender: senderFromRoom(initialRoom),
    })

    const client = createRealtimeClient({ token: session.token })
    realtimeRef.current = client
    let hasOpened = false

    const createActivePeerSession = () => {
      disposePeerSession()
      const peerSession = createPeerSession({
        selfId: session.visitor.id,
        roomCode: initialRoom.code,
        role,
        rtcConfiguration: getRtcConfiguration(),
        sendSignal: message => client.send(message),
      })
      peerSessionRef.current = peerSession

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

        if (event.type === 'transfer:request') {
          const sender = roomRef.current?.participants
            .find(participant => participant.visitor.id === event.peerId)
            ?.visitor
          if (!sender) {
            peerSession.rejectText(event.peerId, event.request.transferId)
            return
          }

          const duplicate = incomingRequestsRef.current.some(request =>
            request.peerId === event.peerId
            && request.transferId === event.request.transferId)
          if (duplicate) return
          if (incomingRequestsRef.current.length >= 5) {
            peerSession.rejectText(event.peerId, event.request.transferId)
            showToast('接收队列已满，已拒绝新的传输请求', 'info')
            return
          }

          replaceIncomingRequests([
            ...incomingRequestsRef.current,
            {
              ...event.request,
              peerId: event.peerId,
              sender,
            },
          ])
          return
        }

        if (event.type === 'transfer:received') {
          const sender = roomRef.current?.participants
            .find(participant => participant.visitor.id === event.peerId)
            ?.visitor
          removeIncomingRequest(event.peerId, event.transferId)
          if (receivingRequestKeyRef.current === requestKey(event.peerId, event.transferId)) {
            setReceivingRequest()
          }
          setReceiverView({
            status: 'received',
            sender,
            text: event.text,
          })
          showToast('文本接收完成', 'success')
          return
        }

        if (event.type === 'transfer:decision') {
          showToast(
            event.decision === 'accept'
              ? '接收者已确认，正在发送文本'
              : '一位接收者拒绝了本次传输',
            event.decision === 'accept' ? 'info' : 'error',
          )
          return
        }

        if (event.type === 'transfer:receipt') {
          showToast('文本已送达一位接收者', 'success')
          return
        }

        if (event.type === 'transfer:cancelled') {
          const key = requestKey(event.peerId, event.transferId)
          const wasReceiving = receivingRequestKeyRef.current === key
          removeIncomingRequest(event.peerId, event.transferId)
          if (wasReceiving) {
            setReceivingRequest()
            setReceiverView({
              status: 'error',
              sender: senderFromRoom(roomRef.current),
              message: event.reason === 'peer-closed'
                ? '发送者已离开，传输已取消。'
                : '传输请求已失效，请让对方重新发送。',
            })
          } else if (role === 'sender') {
            showToast(
              event.reason === 'timeout'
                ? '接收者未响应，传输请求已失效'
                : '一位接收者已断开',
              'error',
            )
          }
          return
        }

        if (event.peerId && event.transferId) {
          const key = requestKey(event.peerId, event.transferId)
          if (receivingRequestKeyRef.current === key) {
            removeIncomingRequest(event.peerId, event.transferId)
            setReceivingRequest()
            setReceiverView({
              status: 'error',
              sender: senderFromRoom(roomRef.current),
              message: event.message,
            })
          }
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
        if (role === 'receiver') {
          const sender = senderFromRoom(message.room)
          setReceiverView(current => ({
            ...current,
            sender: sender ?? current.sender,
          }))
        }
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

      showToast(message.message)
      if (message.code === 'ROOM_NOT_FOUND' || message.code === 'VISITOR_NOT_FOUND') {
        const recoveryGeneration = ++operationGenerationRef.current
        disposeRoomResources()
        if (message.code === 'ROOM_NOT_FOUND') {
          dispatch({ type: 'visitor:ready', session })
          return
        }

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
      }
    })

    client.subscribeStatus(status => {
      if (realtimeRef.current !== client) return

      if (status === 'open') {
        client.send({
          type: 'room:join',
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
        replaceIncomingRequests([])
        setReceivingRequest()
        dispatch({ type: 'realtime:disconnected' })
        if (role === 'receiver') {
          setReceiverView(current =>
            current.status === 'received'
              ? current
              : {
                  status: 'waiting',
                  sender: senderFromRoom(roomRef.current),
                })
        }
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

    client.connect()
  }, [
    disposePeerSession,
    disposeRoomResources,
    removeIncomingRequest,
    replaceIncomingRequests,
    setReceivingRequest,
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
      const result = await runWithFreshSession(
        state.session,
        activeSession => createRoom(activeSession.token),
      )
      if (operationGenerationRef.current !== operationGeneration) return
      if (result.session.token !== state.session.token) {
        dispatch({ type: 'visitor:ready', session: result.session })
      }
      roomRef.current = result.value
      dispatch({ type: 'room:created', room: result.value })
      connectRealtime(result.session, result.value, 'sender')
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
      const result = await runWithFreshSession(
        state.session,
        activeSession => joinRoom(code, activeSession.token, 'receiver'),
      )
      if (operationGenerationRef.current !== operationGeneration) return
      if (result.session.token !== state.session.token) {
        dispatch({ type: 'visitor:ready', session: result.session })
      }
      roomRef.current = result.value
      dispatch({ type: 'room:joined', room: result.value })
      connectRealtime(result.session, result.value, 'receiver')
    } catch (error) {
      if (operationGenerationRef.current !== operationGeneration) return
      const message = error instanceof Error ? error.message : '加入房间失败'
      showToast(message)
      dispatch({ type: 'error', message })
    }
  }, [connectRealtime, runWithFreshSession, showToast, state.session])

  const handleSendText = useCallback(async (text: string) => {
    const result = peerSessionRef.current?.offerText(text)
    if (!result) throw new Error('点对点连接尚未就绪')
    showToast(
      result.peerCount === 1
        ? '已向 1 位接收者发出请求'
        : '已向 ' + String(result.peerCount) + ' 位接收者发出请求',
      'info',
    )
  }, [showToast])

  const activeRequest = incomingRequests[0]
  const activeRequestKey = activeRequest
    ? requestKey(activeRequest.peerId, activeRequest.transferId)
    : undefined

  const handleAcceptRequest = useCallback(() => {
    const request = incomingRequestsRef.current[0]
    if (!request) return
    const key = requestKey(request.peerId, request.transferId)
    const accepted = peerSessionRef.current?.acceptText(
      request.peerId,
      request.transferId,
    )
    if (!accepted) {
      removeIncomingRequest(request.peerId, request.transferId)
      setReceiverView({
        status: 'error',
        sender: request.sender,
        message: '连接已中断，无法接收这段文本。',
      })
      return
    }
    setReceivingRequest(key)
    setReceiverView({
      status: 'receiving',
      sender: request.sender,
    })
  }, [removeIncomingRequest, setReceivingRequest])

  const handleRejectRequest = useCallback(() => {
    const request = incomingRequestsRef.current[0]
    if (!request) return
    peerSessionRef.current?.rejectText(request.peerId, request.transferId)
    removeIncomingRequest(request.peerId, request.transferId)
  }, [removeIncomingRequest])

  const handleCopyText = useCallback(async (text: string) => {
    if (!navigator.clipboard) throw new Error('当前浏览器不支持剪贴板')
    await navigator.clipboard.writeText(text)
  }, [])

  const roomView = state.session && state.room && state.phase !== 'lobby'
    ? { session: state.session, room: state.room }
    : undefined
  const receiverSender: PublicVisitor | undefined =
    receiverView.sender ?? senderFromRoom(roomView?.room)

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
                <div className="text-xl font-mono tracking-[0.2em] text-amber-50/80 tabular-nums">
                  {roomView.room.code}
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
                readyPeerCount={state.readyPeerCount}
                onSendText={handleSendText}
              />
            ) : (
              <ReceivedTextView
                state={{
                  ...receiverView,
                  sender: receiverSender,
                }}
                onCopy={handleCopyText}
              />
            )}
          </div>
        )}
      </main>

      {activeRequest && (
        <IncomingTextRequestDialog
          request={activeRequest}
          status={receivingRequestKey === activeRequestKey ? 'receiving' : 'pending'}
          onAccept={handleAcceptRequest}
          onReject={handleRejectRequest}
        />
      )}

      <ToastViewport toast={toastState} onDismiss={dismissToast} />
    </div>
  )
}

export default App
