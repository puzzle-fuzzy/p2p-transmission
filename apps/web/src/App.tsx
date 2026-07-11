import { useCallback, useEffect, useReducer, useRef } from 'react'
import Loading from './components/Loading'
import RoomJoin from './components/RoomJoin'
import TransferPanel from './components/TransferPanel'
import ToastViewport from './components/ui/Toast'
import { useToast } from './components/ui/useToast'
import {
  initialRoomFlowState,
  roomFlowReducer,
} from './features/room/state'
import { createRoom, createVisitor, joinRoom } from './lib/api-client'
import { createRealtimeClient, type RealtimeClient } from './lib/realtime-client'
import {
  loadVisitorSession,
  saveVisitorSession,
} from './lib/visitor-session'
import type { ParticipantRole, PublicRoom, VisitorSession } from './shared/contracts'

function App() {
  const [state, dispatch] = useReducer(roomFlowReducer, initialRoomFlowState)
  const {
    toast: toastState,
    show: showToast,
    dismiss: dismissToast,
  } = useToast()
  const realtimeRef = useRef<RealtimeClient | undefined>(undefined)
  const bootedRef = useRef(false)

  useEffect(() => {
    if (bootedRef.current) return
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

    return () => {
      realtimeRef.current?.close()
    }
  }, [showToast])

  const connectRealtime = useCallback((
    session: VisitorSession,
    room: PublicRoom,
    role: ParticipantRole,
  ) => {
    realtimeRef.current?.close()

    const client = createRealtimeClient({ token: session.token })
    client.subscribe(message => {
      if (message.type === 'visitor:ready') return
      if (message.type === 'error') {
        showToast(message.message)
      }
      dispatch({ type: 'server:message', message })
    })
    client.connect()
    client.send({ type: 'room:join', roomCode: room.code, role })
    realtimeRef.current = client
    dispatch({ type: 'realtime:connected' })
  }, [showToast])

  const handleCreateRoom = useCallback(async () => {
    if (!state.session) return

    dispatch({ type: 'room:joining' })

    try {
      const room = await createRoom(state.session.token)
      dispatch({ type: 'room:created', room })
      connectRealtime(state.session, room, 'sender')
    } catch (error) {
      const message = error instanceof Error ? error.message : '创建房间失败'
      showToast(message)
      dispatch({
        type: 'error',
        message,
      })
    }
  }, [connectRealtime, state.session, showToast])

  const handleJoinRoom = useCallback(async (code: string) => {
    if (!state.session) return

    dispatch({ type: 'room:joining' })

    try {
      const room = await joinRoom(code, state.session.token, 'receiver')
      dispatch({ type: 'room:joined', room })
      connectRealtime(state.session, room, 'receiver')
    } catch (error) {
      const message = error instanceof Error ? error.message : '加入房间失败'
      showToast(message)
      dispatch({
        type: 'error',
        message,
      })
    }
  }, [connectRealtime, state.session, showToast])

  const roomView = state.session && state.room && state.phase !== 'lobby'
    ? { session: state.session, room: state.room }
    : undefined

  return (
    <div className="h-svh bg-[#2d2d2d] flex justify-center items-center">
      {state.phase === 'booting' && <Loading />}

      {!roomView && state.phase !== 'booting' && (
        <RoomJoin
          busy={state.phase === 'joining'}
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
        />
      )}

      {roomView && (
        <div className="flex flex-col gap-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-amber-50/30 text-xs">房间码</div>
              <div className="text-amber-50/80 text-xl font-mono tracking-[0.2em] tabular-nums">
                {roomView.room.code}
              </div>
            </div>
            <div className="text-right text-xs">
              <div className="text-amber-50/40">{state.role === 'sender' ? '发送者' : '接收者'}</div>
              <div className="text-amber-50/20">
                {state.phase === 'ready' ? '已连接' : '等待连接'}
              </div>
            </div>
          </div>
          <TransferPanel
            visitor={roomView.session.visitor}
            room={roomView.room}
            realtimeReady={state.phase === 'ready'}
          />
        </div>
      )}

      <ToastViewport toast={toastState} onDismiss={dismissToast} />
    </div>
  )
}

export default App
