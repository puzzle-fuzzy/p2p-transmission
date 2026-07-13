import { describe, expect, test } from 'vitest'
import type { RoomJoinRequestReceipt } from '../../shared/contracts'
import {
  initialJoinFlowState,
  joinFlowReducer,
  type JoinFlowState,
} from './join-state'

const receipt = (
  state: RoomJoinRequestReceipt['state'],
  expiresAt = 10_000,
): RoomJoinRequestReceipt => ({
  requestId: 'request-1',
  state,
  expiresAt,
})

describe('join flow reducer', () => {
  test.each(['invite', 'recovery'] as const)(
    'starts a %s join without retaining an earlier approval request',
    source => {
      const state = joinFlowReducer({
        status: { kind: 'idle' },
        receipt: receipt('approved'),
      }, {
        type: 'join:start',
        source,
      })

      expect(state).toEqual({
        status: { kind: 'joining', source },
      })
    },
  )

  test('moves a manual intent through requesting and awaiting approval', () => {
    const requesting = joinFlowReducer(initialJoinFlowState, {
      type: 'manual:requesting',
      roomCode: '123456',
    })

    expect(requesting).toEqual({
      status: { kind: 'requestingApproval', roomCode: '123456' },
    })

    const pending = receipt('pending')
    const awaiting = joinFlowReducer(requesting, {
      type: 'manual:awaiting',
      roomCode: '123456',
      receipt: pending,
    })

    expect(awaiting).toEqual({
      status: {
        kind: 'awaitingApproval',
        roomCode: '123456',
        requestId: 'request-1',
        expiresAt: 10_000,
      },
      receipt: pending,
    })
  })

  test('updates pending receipts and retains an approved request for finalize', () => {
    const initial: JoinFlowState = {
      status: {
        kind: 'awaitingApproval',
        roomCode: '123456',
        requestId: 'request-1',
        expiresAt: 10_000,
      },
      receipt: receipt('pending'),
    }
    const refreshed = joinFlowReducer(initial, {
      type: 'manual:receipt',
      receipt: receipt('pending', 12_000),
    })

    expect(refreshed.status).toEqual({
      kind: 'awaitingApproval',
      roomCode: '123456',
      requestId: 'request-1',
      expiresAt: 12_000,
    })

    const approvedReceipt = receipt('approved', 30_000)
    const approved = joinFlowReducer(refreshed, {
      type: 'manual:receipt',
      receipt: approvedReceipt,
    })

    expect(approved.status).toEqual({
      kind: 'awaitingApproval',
      roomCode: '123456',
      requestId: 'request-1',
      expiresAt: 30_000,
    })
    expect(approved.receipt).toEqual(approvedReceipt)
  })

  test('ignores a late receipt bound to a different request', () => {
    const current: JoinFlowState = {
      status: {
        kind: 'awaitingApproval',
        roomCode: '123456',
        requestId: 'request-1',
        expiresAt: 10_000,
      },
      receipt: receipt('pending'),
    }
    const lateReceipt = {
      ...receipt('approved', 30_000),
      requestId: 'request-2',
    }

    expect(joinFlowReducer(current, {
      type: 'manual:receipt',
      receipt: lateReceipt,
    })).toBe(current)
  })

  test('retains the authoritative approved receipt across a retryable finalize error', () => {
    const approvedReceipt = receipt('approved', 30_000)
    const approved: JoinFlowState = {
      status: {
        kind: 'awaitingApproval',
        roomCode: '123456',
        requestId: 'request-1',
        expiresAt: 30_000,
      },
      receipt: approvedReceipt,
    }

    const failed = joinFlowReducer(approved, {
      type: 'join:error',
      code: 'NETWORK_ERROR',
      message: '网络连接失败，请重试',
      retryable: true,
    })

    expect(failed).toEqual({
      status: {
        kind: 'error',
        roomCode: '123456',
        code: 'NETWORK_ERROR',
        message: '网络连接失败，请重试',
        retryable: true,
      },
      receipt: approvedReceipt,
    })
  })

  test.each(['rejected', 'cancelled', 'expired', 'finalized'] as const)(
    'clears a %s terminal receipt',
    state => {
      const current: JoinFlowState = {
        status: {
          kind: 'awaitingApproval',
          roomCode: '123456',
          requestId: 'request-1',
          expiresAt: 10_000,
        },
        receipt: receipt('pending'),
      }

      expect(joinFlowReducer(current, {
        type: 'manual:receipt',
        receipt: receipt(state),
      })).toEqual(initialJoinFlowState)
    },
  )

  test('clears request authorization on deterministic errors, success, and reset', () => {
    const current: JoinFlowState = {
      status: {
        kind: 'awaitingApproval',
        roomCode: '123456',
        requestId: 'request-1',
        expiresAt: 10_000,
      },
      receipt: receipt('approved'),
    }
    const denied = joinFlowReducer(current, {
      type: 'join:error',
      roomCode: '123456',
      code: 'ROOM_ACCESS_DENIED',
      message: '无法加入房间',
      retryable: false,
    })

    expect(denied.receipt).toBeUndefined()
    expect(joinFlowReducer(current, { type: 'join:success' })).toEqual(initialJoinFlowState)
    expect(joinFlowReducer(current, { type: 'join:reset' })).toEqual(initialJoinFlowState)
  })
})
