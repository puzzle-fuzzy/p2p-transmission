import type { RoomJoinRequestSummary } from '../../shared/contracts'

export type RoomAccessDecision = {
  requestId: string
  decision: 'approve' | 'reject'
}

export type RoomAccessState = {
  requests: readonly RoomJoinRequestSummary[]
  decision?: RoomAccessDecision
}

export type RoomAccessAction =
  | { type: 'snapshot'; requests: readonly RoomJoinRequestSummary[] }
  | { type: 'requested'; request: RoomJoinRequestSummary }
  | { type: 'resolved'; requestId: string }
  | {
      type: 'decision:start'
      requestId: string
      decision: RoomAccessDecision['decision']
    }
  | { type: 'decision:finish'; requestId: string }
  | { type: 'reset' }

export const initialRoomAccessState: RoomAccessState = {
  requests: [],
}

const compareRequests = (
  left: RoomJoinRequestSummary,
  right: RoomJoinRequestSummary,
) => left.createdAt - right.createdAt
  || (left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0)

const normalizeRequests = (
  requests: readonly RoomJoinRequestSummary[],
): readonly RoomJoinRequestSummary[] => {
  const byRequestId = new Map<string, RoomJoinRequestSummary>()
  for (const request of requests) {
    byRequestId.set(request.requestId, request)
  }

  return [...byRequestId.values()].sort(compareRequests)
}

export const roomAccessReducer = (
  state: RoomAccessState,
  action: RoomAccessAction,
): RoomAccessState => {
  if (action.type === 'snapshot') {
    const requests = normalizeRequests(action.requests)
    const decision = state.decision
      && requests.some(request => request.requestId === state.decision?.requestId)
      ? state.decision
      : undefined

    return {
      requests,
      ...(decision ? { decision } : {}),
    }
  }

  if (action.type === 'requested') {
    const requests = normalizeRequests([
      ...state.requests.filter(request => request.requestId !== action.request.requestId),
      action.request,
    ])

    return {
      requests,
      ...(state.decision ? { decision: state.decision } : {}),
    }
  }

  if (action.type === 'resolved') {
    const requests = state.requests.filter(
      request => request.requestId !== action.requestId,
    )
    const decision = state.decision?.requestId === action.requestId
      ? undefined
      : state.decision

    return {
      requests,
      ...(decision ? { decision } : {}),
    }
  }

  if (action.type === 'decision:start') {
    return {
      ...state,
      decision: {
        requestId: action.requestId,
        decision: action.decision,
      },
    }
  }

  if (action.type === 'decision:finish') {
    if (state.decision?.requestId !== action.requestId) return state
    return { requests: state.requests }
  }

  return initialRoomAccessState
}
