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
  error: string
}

export type RoomFlowAction =
  | { type: 'visitor:ready'; session: VisitorSession }
  | { type: 'room:joining' }
  | { type: 'room:created'; room: PublicRoom }
  | { type: 'room:joined'; room: PublicRoom }
  | { type: 'realtime:connected' }
  | { type: 'server:message'; message: ServerRealtimeMessage }
  | { type: 'error'; message: string }

export const initialRoomFlowState: RoomFlowState = {
  phase: 'booting',
  error: '',
}

const readyPhaseFor = (room: PublicRoom): RoomPhase =>
  room.participants.length >= 2 ? 'ready' : 'connecting'

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
      error: '',
    }
  }

  if (action.type === 'room:joining') {
    return {
      ...state,
      phase: 'joining',
      error: '',
    }
  }

  if (action.type === 'room:created') {
    return {
      ...state,
      phase: 'room',
      room: action.room,
      role: 'sender',
      error: '',
    }
  }

  if (action.type === 'room:joined') {
    return {
      ...state,
      phase: 'room',
      room: action.room,
      role: 'receiver',
      error: '',
    }
  }

  if (action.type === 'realtime:connected') {
    return {
      ...state,
      phase: 'connecting',
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
      phase: readyPhaseFor(message.room),
      room: message.room,
      error: '',
    }
  }

  if (message.type === 'participant:left' && state.room) {
    const room = removeParticipant(state.room, message.visitorId)

    return {
      ...state,
      phase: readyPhaseFor(room),
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
