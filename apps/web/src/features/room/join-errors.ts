import { ApiClientError } from '../../lib/api-client'

export type JoinErrorContext =
  | 'invite'
  | 'recovery'
  | 'manualRequest'
  | 'requestStatus'
  | 'finalize'
  | 'cancel'
  | 'decision'

export type JoinFailure = {
  code: string
  message: string
  retryable: boolean
  clearRecovery: boolean
  attemptStrictRecovery: boolean
}

const deterministicJoinRequestCodes = new Set([
  'ROOM_REQUEST_UNAVAILABLE',
  'ROOM_JOIN_REQUEST_REJECTED',
  'ROOM_JOIN_REQUEST_NOT_APPROVED',
  'ROOM_JOIN_REQUEST_CANCELLED',
  'ROOM_JOIN_REQUEST_EXPIRED',
  'CAPACITY_EXCEEDED',
])

const staleRecoveryCodes = new Set([
  'ROOM_NOT_FOUND',
  'ROOM_EXPIRED',
  'ROOM_MEMBERSHIP_REQUIRED',
  'INVALID_STATE',
])

const failure = (
  code: string,
  message: string,
  overrides: Partial<Omit<JoinFailure, 'code' | 'message'>> = {},
): JoinFailure => ({
  code,
  message,
  retryable: false,
  clearRecovery: false,
  attemptStrictRecovery: false,
  ...overrides,
})

export const mapJoinError = (
  error: unknown,
  context: JoinErrorContext,
): JoinFailure => {
  if (!(error instanceof ApiClientError)) {
    return failure('NETWORK_ERROR', '网络连接失败，请稍后重试', {
      retryable: true,
    })
  }

  if (error.code === 'ROOM_ACCESS_DENIED') {
    return failure(error.code, error.message, {
      clearRecovery: context === 'invite' || context === 'recovery',
    })
  }

  if (error.code === 'VISITOR_NOT_FOUND') {
    if (context === 'invite') {
      return failure(error.code, error.message, { retryable: true })
    }
    return failure(error.code, error.message, {
      clearRecovery: context === 'recovery',
    })
  }

  if (error.code === 'ROOM_JOIN_REQUEST_NOT_FOUND') {
    return failure(error.code, error.message, {
      attemptStrictRecovery: context === 'finalize',
    })
  }

  if (staleRecoveryCodes.has(error.code)) {
    return failure(error.code, error.message, {
      clearRecovery: context === 'recovery',
    })
  }

  if (deterministicJoinRequestCodes.has(error.code)) {
    return failure(error.code, error.message)
  }

  if (
    error.code === 'RATE_LIMITED'
    || error.code === 'UNKNOWN_API_ERROR'
    || error.status >= 500
  ) {
    return failure(error.code, error.message, { retryable: true })
  }

  return failure(error.code, error.message)
}
