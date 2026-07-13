import { describe, expect, test } from 'vitest'
import { ApiClientError } from '../../lib/api-client'
import { mapJoinError, type JoinErrorContext } from './join-errors'

const apiError = (code: string, status = 400, message = code) =>
  new ApiClientError(message, code, status)

describe('mapJoinError', () => {
  test('clears denied invitation and recovery authority without retrying', () => {
    for (const context of ['invite', 'recovery'] satisfies JoinErrorContext[]) {
      expect(mapJoinError(apiError(
        'ROOM_ACCESS_DENIED',
        404,
        '邀请链接无效或已过期',
      ), context)).toEqual({
        code: 'ROOM_ACCESS_DENIED',
        message: '邀请链接无效或已过期',
        retryable: false,
        clearRecovery: true,
        attemptStrictRecovery: false,
      })
    }
  })

  test('keeps a manually entered room code when requests are unavailable', () => {
    expect(mapJoinError(apiError(
      'ROOM_REQUEST_UNAVAILABLE',
      404,
      '房间不存在或暂时无法接收申请',
    ), 'manualRequest')).toMatchObject({
      code: 'ROOM_REQUEST_UNAVAILABLE',
      retryable: false,
      clearRecovery: false,
      attemptStrictRecovery: false,
    })
  })

  test.each([
    'ROOM_JOIN_REQUEST_REJECTED',
    'ROOM_JOIN_REQUEST_CANCELLED',
    'ROOM_JOIN_REQUEST_EXPIRED',
    'CAPACITY_EXCEEDED',
  ])('treats %s as deterministic', code => {
    expect(mapJoinError(apiError(code), 'finalize')).toMatchObject({
      code,
      retryable: false,
      clearRecovery: false,
      attemptStrictRecovery: false,
    })
  })

  test('preserves the active intent for rate limits, server errors, and network failures', () => {
    expect(mapJoinError(apiError('RATE_LIMITED', 429), 'manualRequest'))
      .toMatchObject({ retryable: true, clearRecovery: false })
    expect(mapJoinError(apiError('INTERNAL_ERROR', 503), 'finalize'))
      .toMatchObject({ retryable: true, clearRecovery: false })
    expect(mapJoinError(apiError('UNKNOWN_API_ERROR', 400), 'requestStatus'))
      .toMatchObject({ retryable: true, clearRecovery: false })
    expect(mapJoinError(new TypeError('Failed to fetch'), 'recovery')).toEqual({
      code: 'NETWORK_ERROR',
      message: '网络连接失败，请稍后重试',
      retryable: true,
      clearRecovery: false,
      attemptStrictRecovery: false,
    })
  })

  test('never mints a replacement identity for failed recovery', () => {
    expect(mapJoinError(apiError('VISITOR_NOT_FOUND', 401), 'recovery')).toMatchObject({
      code: 'VISITOR_NOT_FOUND',
      retryable: false,
      clearRecovery: true,
      attemptStrictRecovery: false,
    })
  })

  test('lets invitation admission perform its one App-level fresh-identity retry', () => {
    expect(mapJoinError(apiError('VISITOR_NOT_FOUND', 401), 'invite')).toMatchObject({
      code: 'VISITOR_NOT_FOUND',
      retryable: true,
      clearRecovery: false,
      attemptStrictRecovery: false,
    })
  })

  test('attempts strict recovery only for a missing request during finalize', () => {
    for (const context of [
      'invite',
      'recovery',
      'manualRequest',
      'requestStatus',
      'cancel',
      'decision',
    ] satisfies JoinErrorContext[]) {
      expect(mapJoinError(
        apiError('ROOM_JOIN_REQUEST_NOT_FOUND', 404),
        context,
      )).toMatchObject({ attemptStrictRecovery: false })
    }

    expect(mapJoinError(
      apiError('ROOM_JOIN_REQUEST_NOT_FOUND', 404),
      'finalize',
    )).toMatchObject({
      retryable: false,
      clearRecovery: false,
      attemptStrictRecovery: true,
    })
  })

  test.each([
    'ROOM_NOT_FOUND',
    'ROOM_EXPIRED',
    'ROOM_MEMBERSHIP_REQUIRED',
  ])('clears stale recovery for deterministic room error %s', code => {
    expect(mapJoinError(apiError(code, 404), 'recovery')).toMatchObject({
      retryable: false,
      clearRecovery: true,
    })
  })
})
