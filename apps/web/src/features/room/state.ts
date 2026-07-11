import type {
  ParticipantRole,
  PublicRoom,
  ServerRealtimeMessage,
  VisitorSession,
} from '../../shared/contracts'

export type RoomPhase = 'booting' | 'lobby' | 'joining' | 'room' | 'connecting' | 'ready' | 'error'

export type RoomFlowState = {
  phase: RoomPhase
  session?: VisitorSession
  room?: PublicRoom
  role?: ParticipantRole
  readyPeerCount: number
  error: string
}

export type RoomFlowAction =
  | { type: 'visitor:ready'; session: VisitorSession }
  | { type: 'room:joining' }
  | { type: 'room:created'; room: PublicRoom }
  | { type: 'room:joined'; room: PublicRoom }
  | { type: 'realtime:connected' }
  | { type: 'realtime:disconnected' }
  | { type: 'peer:ready-count'; count: number }
  | { type: 'server:message'; message: ServerRealtimeMessage }
  | { type: 'error'; message: string }

export const initialRoomFlowState: RoomFlowState = {
  phase: 'booting',
  readyPeerCount: 0,
  error: '',
}

const readyPhaseFor = (readyPeerCount: number): RoomPhase =>
  readyPeerCount > 0 ? 'ready' : 'connecting'

const removeParticipant = (room: PublicRoom, visitorId: string): PublicRoom => ({
  ...room,
  receivers: room.receivers.filter(id => id !== visitorId),
  participants: room.participants.filter(participant => participant.visitor.id !== visitorId),
})

export const roomFlowReducer = (
  state: RoomFlowState,
  action: RoomFlowAction,
): RoomFlowState => {
  if (action.type === 'visitor:ready') {
    return {
      ...state,
      phase: 'lobby',
      session: action.session,
      room: undefined,
      role: undefined,
      readyPeerCount: 0,
      error: '',
    }
  }

  if (action.type === 'room:joining') {
    return {
      ...state,
      phase: 'joining',
      readyPeerCount: 0,
      error: '',
    }
  }

  if (action.type === 'room:created') {
    return {
      ...state,
      phase: 'room',
      room: action.room,
      role: 'sender',
      readyPeerCount: 0,
      error: '',
    }
  }

  if (action.type === 'room:joined') {
    return {
      ...state,
      phase: 'room',
      room: action.room,
      role: 'receiver',
      readyPeerCount: 0,
      error: '',
    }
  }

  if (action.type === 'realtime:connected') {
    return {
      ...state,
      phase: 'connecting',
      readyPeerCount: 0,
      error: '',
    }
  }

  if (action.type === 'realtime:disconnected') {
    return {
      ...state,
      phase: state.room ? 'connecting' : state.phase,
      readyPeerCount: 0,
    }
  }

  if (action.type === 'peer:ready-count') {
    const readyPeerCount = Math.max(0, Math.trunc(action.count))

    return {
      ...state,
      phase: readyPhaseFor(readyPeerCount),
      readyPeerCount,
      error: '',
    }
  }

  if (action.type === 'error') {
    return {
      ...state,
      phase: 'error',
      error: action.message,
    }
  }

  const { message } = action

  if (message.type === 'room:participants') {
    return {
      ...state,
      room: message.room,
      error: '',
    }
  }

  if (message.type === 'participant:left' && state.room) {
    const room = removeParticipant(state.room, message.visitorId)

    return {
      ...state,
      room,
      error: '',
    }
  }

  if (message.type === 'error') {
    return {
      ...state,
      phase: 'error',
      error: message.message,
    }
  }

  return state
}
