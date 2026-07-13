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
  readyPeerIds: readonly string[]
  error: string
}

export type RoomFlowAction =
  | { type: 'boot:retry' }
  | { type: 'visitor:ready'; session: VisitorSession }
  | { type: 'room:joining' }
  | { type: 'room:created'; room: PublicRoom }
  | { type: 'room:joined'; room: PublicRoom }
  | { type: 'realtime:connected' }
  | { type: 'realtime:disconnected' }
  | { type: 'peer:ready-ids'; peerIds: readonly string[] }
  | { type: 'server:message'; message: ServerRealtimeMessage }
  | { type: 'error'; message: string }

export const initialRoomFlowState: RoomFlowState = {
  phase: 'booting',
  readyPeerIds: [],
  error: '',
}

const readyPhaseFor = (readyPeerIds: readonly string[]): RoomPhase =>
  readyPeerIds.length > 0 ? 'ready' : 'connecting'

const removeParticipant = (room: PublicRoom, visitorId: string): PublicRoom => ({
  ...room,
  receivers: room.receivers.filter(id => id !== visitorId),
  participants: room.participants.filter(participant => participant.visitor.id !== visitorId),
})

export const roomFlowReducer = (
  state: RoomFlowState,
  action: RoomFlowAction,
): RoomFlowState => {
  if (action.type === 'boot:retry') {
    return {
      ...state,
      phase: 'booting',
      error: '',
    }
  }

  if (action.type === 'visitor:ready') {
    return {
      ...state,
      phase: 'lobby',
      session: action.session,
      room: undefined,
      role: undefined,
      readyPeerIds: [],
      error: '',
    }
  }

  if (action.type === 'room:joining') {
    return {
      ...state,
      phase: 'joining',
      readyPeerIds: [],
      error: '',
    }
  }

  if (action.type === 'room:created') {
    return {
      ...state,
      phase: 'room',
      room: action.room,
      role: 'sender',
      readyPeerIds: [],
      error: '',
    }
  }

  if (action.type === 'room:joined') {
    return {
      ...state,
      phase: 'room',
      room: action.room,
      role: 'receiver',
      readyPeerIds: [],
      error: '',
    }
  }

  if (action.type === 'realtime:connected') {
    return {
      ...state,
      phase: 'connecting',
      readyPeerIds: [],
      error: '',
    }
  }

  if (action.type === 'realtime:disconnected') {
    return {
      ...state,
      phase: state.room ? 'connecting' : state.phase,
      readyPeerIds: [],
    }
  }

  if (action.type === 'peer:ready-ids') {
    const readyPeerIds = Array.from(new Set(action.peerIds))

    return {
      ...state,
      phase: readyPhaseFor(readyPeerIds),
      readyPeerIds,
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
