import type { RoomJoinRequestReceipt } from '../../shared/contracts'

export type JoinStatus =
  | { kind: 'idle' }
  | { kind: 'joining'; source: 'invite' | 'recovery' }
  | { kind: 'requestingApproval'; roomCode: string }
  | {
      kind: 'awaitingApproval'
      roomCode: string
      requestId: string
      expiresAt: number
    }
  | {
      kind: 'error'
      roomCode?: string
      code: string
      message: string
      retryable: boolean
    }

export type JoinFlowState = {
  status: JoinStatus
  receipt?: RoomJoinRequestReceipt
}

export type JoinFlowAction =
  | { type: 'join:start'; source: 'invite' | 'recovery' }
  | { type: 'manual:requesting'; roomCode: string }
  | {
      type: 'manual:awaiting'
      roomCode: string
      receipt: RoomJoinRequestReceipt
    }
  | { type: 'manual:receipt'; receipt: RoomJoinRequestReceipt }
  | {
      type: 'join:error'
      roomCode?: string
      code: string
      message: string
      retryable: boolean
    }
  | { type: 'join:success' }
  | { type: 'join:reset' }

export const initialJoinFlowState: JoinFlowState = {
  status: { kind: 'idle' },
}

const roomCodeFromStatus = (status: JoinStatus): string | undefined => {
  if (
    status.kind === 'requestingApproval'
    || status.kind === 'awaitingApproval'
    || status.kind === 'error'
  ) {
    return status.roomCode
  }

  return undefined
}

const applyReceipt = (
  roomCode: string,
  receipt: RoomJoinRequestReceipt,
): JoinFlowState => {
  if (receipt.state !== 'pending' && receipt.state !== 'approved') {
    return initialJoinFlowState
  }

  return {
    status: {
      kind: 'awaitingApproval',
      roomCode,
      requestId: receipt.requestId,
      expiresAt: receipt.expiresAt,
    },
    receipt,
  }
}

export const joinFlowReducer = (
  state: JoinFlowState,
  action: JoinFlowAction,
): JoinFlowState => {
  if (action.type === 'join:start') {
    return {
      status: { kind: 'joining', source: action.source },
    }
  }

  if (action.type === 'manual:requesting') {
    return {
      status: {
        kind: 'requestingApproval',
        roomCode: action.roomCode,
      },
    }
  }

  if (action.type === 'manual:awaiting') {
    return applyReceipt(action.roomCode, action.receipt)
  }

  if (action.type === 'manual:receipt') {
    const roomCode = roomCodeFromStatus(state.status)
    if (!roomCode) return state
    const currentRequestId = state.receipt?.requestId
      ?? (state.status.kind === 'awaitingApproval'
        ? state.status.requestId
        : undefined)
    if (
      currentRequestId !== undefined
      && action.receipt.requestId !== currentRequestId
    ) {
      return state
    }
    return applyReceipt(roomCode, action.receipt)
  }

  if (action.type === 'join:error') {
    const roomCode = action.roomCode ?? roomCodeFromStatus(state.status)
    const status: JoinStatus = {
      kind: 'error',
      code: action.code,
      message: action.message,
      retryable: action.retryable,
      ...(roomCode ? { roomCode } : {}),
    }

    return {
      status,
      ...(action.retryable && state.receipt ? { receipt: state.receipt } : {}),
    }
  }

  return initialJoinFlowState
}
