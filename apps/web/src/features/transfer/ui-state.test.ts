import { describe, expect, test } from 'vitest'
import type { PeerSessionEvent } from './peer-session'
import {
  aggregateFileProgress,
  aggregateProgress,
  clearTerminalHold,
  createActivity,
  initialTransferUiState,
  isTransferLocked,
  transferUiReducer,
} from './ui-state'
import type { TransferUiState } from './ui-state'

const event = <Event extends { type: string }>(value: Event) =>
  value as unknown as PeerSessionEvent

const reduceEvent = (
  state: ReturnType<typeof transferUiReducer>,
  value: PeerSessionEvent,
) => transferUiReducer(state, { type: 'peer-session:event', event: value })

describe('transfer UI state', () => {
  test('creates concrete file peer state', () => {
    const files = createActivity({
      generation: 1,
      transferId: 'files_1',
      kind: 'file',
      peerIds: ['peer_a', 'peer_b'],
      unsupportedPeerIds: ['peer_b'],
      fileIds: ['file_a', 'file_b'],
    })

    expect(files).toMatchObject({
      phase: 'requesting',
      peers: {
        peer_a: { accepted: false, progress: 0 },
        peer_b: { accepted: false, progress: 0, outcome: 'failed' },
      },
      files: {
        file_a: {
          state: 'queued',
          progress: 0,
          peers: {
            peer_a: { progress: 0 },
            peer_b: { progress: 0, outcome: 'failed' },
          },
        },
      },
    })
    expect(isTransferLocked({ activity: files })).toBe(true)
    expect(isTransferLocked(initialTransferUiState)).toBe(false)
  })

  test('an all-unsupported file activity immediately enters error hold', () => {
    const activity = createActivity({
      generation: 1,
      transferId: 'files_unsupported',
      kind: 'file',
      peerIds: ['peer_a', 'peer_b'],
      unsupportedPeerIds: ['peer_a', 'peer_b'],
      fileIds: ['file_a'],
    })

    expect(activity.phase).toBe('error')
    expect(aggregateProgress(activity)).toBe(1)
  })

  test('tracks accept and the slowest per-peer batch and file progress', () => {
    const activity = createActivity({
      generation: 1,
      transferId: 'files_1',
      kind: 'file',
      peerIds: ['peer_a', 'peer_b'],
      fileIds: ['file_a', 'file_b'],
    })
    let state = transferUiReducer(initialTransferUiState, {
      type: 'activity:start',
      activity,
    })
    state = reduceEvent(state, event({
      type: 'transfer:file-decision',
      peerId: 'peer_a',
      transferId: 'files_1',
      decision: 'accept',
    }))
    state = reduceEvent(state, event({
      type: 'transfer:file-decision',
      peerId: 'peer_b',
      transferId: 'files_1',
      decision: 'accept',
    }))
    state = reduceEvent(state, event({
      type: 'transfer:file-progress',
      peerId: 'peer_a',
      transferId: 'files_1',
      fileId: 'file_a',
      direction: 'sending',
      fileBytes: 50,
      fileTotalBytes: 100,
      batchBytes: 100,
      batchTotalBytes: 200,
    }))
    state = reduceEvent(state, event({
      type: 'transfer:file-progress',
      peerId: 'peer_b',
      transferId: 'files_1',
      fileId: 'file_a',
      direction: 'sending',
      fileBytes: 20,
      fileTotalBytes: 100,
      batchBytes: 40,
      batchTotalBytes: 200,
    }))

    const next = state.activity
    if (!next) throw new Error('expected active transfer')
    expect(next.phase).toBe('transferring')
    expect(next.peers.peer_a?.progress).toBe(0.5)
    expect(next.peers.peer_b?.progress).toBe(0.2)
    expect(next.files.file_a?.peers.peer_a?.progress).toBe(0.5)
    expect(next.files.file_a?.peers.peer_b?.progress).toBe(0.2)
    expect(aggregateProgress(next)).toBe(0.2)
    expect(aggregateFileProgress(next, 'file_a')).toBe(0.2)
    expect(next.files.file_a?.state).toBe('transferring')
    expect(next.files.file_b?.state).toBe('queued')
  })

  test('aggregates per-file receipts independently across peers', () => {
    let state: TransferUiState = {
      activity: createActivity({
        generation: 1,
        transferId: 'files_1',
        kind: 'file' as const,
        peerIds: ['peer_a', 'peer_b'],
        fileIds: ['file_a', 'file_b'],
      }),
    }
    for (const peerId of ['peer_a', 'peer_b']) {
      state = reduceEvent(state, event({
        type: 'transfer:file-decision',
        peerId,
        transferId: 'files_1',
        decision: 'accept',
      }))
    }
    state = reduceEvent(state, event({
      type: 'transfer:file-receipt',
      peerId: 'peer_a',
      transferId: 'files_1',
      fileId: 'file_a',
    }))

    expect(state.activity?.files.file_a?.state).toBe('transferring')
    expect(aggregateFileProgress(state.activity!, 'file_a')).toBe(0)

    state = reduceEvent(state, event({
      type: 'transfer:file-progress',
      peerId: 'peer_b',
      transferId: 'files_1',
      fileId: 'file_a',
      direction: 'sending',
      fileBytes: 25,
      fileTotalBytes: 100,
      batchBytes: 25,
      batchTotalBytes: 200,
    }))
    expect(aggregateFileProgress(state.activity!, 'file_a')).toBe(0.25)

    state = reduceEvent(state, event({
      type: 'transfer:file-receipt',
      peerId: 'peer_b',
      transferId: 'files_1',
      fileId: 'file_a',
    }))

    expect(state.activity?.files.file_a).toMatchObject({
      state: 'completed',
      progress: 1,
    })
    expect(state.activity?.files.file_b?.state).toBe('queued')
    expect(aggregateFileProgress(state.activity!, 'file_a')).toBe(1)
  })

  test('rejected peers are terminal but do not hold accepted-peer progress', () => {
    let state: TransferUiState = {
      activity: createActivity({
        generation: 1,
        transferId: 'files_1',
        kind: 'file' as const,
        peerIds: ['peer_a', 'peer_b'],
        fileIds: ['file_a'],
      }),
    }
    state = reduceEvent(state, event({
      type: 'transfer:file-decision',
      peerId: 'peer_a',
      transferId: 'files_1',
      decision: 'accept',
    }))
    state = reduceEvent(state, event({
      type: 'transfer:file-decision',
      peerId: 'peer_b',
      transferId: 'files_1',
      decision: 'reject',
    }))
    state = reduceEvent(state, event({
      type: 'transfer:file-progress',
      peerId: 'peer_a',
      transferId: 'files_1',
      fileId: 'file_a',
      direction: 'sending',
      fileBytes: 60,
      fileTotalBytes: 100,
      batchBytes: 60,
      batchTotalBytes: 100,
    }))

    expect(aggregateProgress(state.activity!)).toBe(0.6)
    expect(aggregateFileProgress(state.activity!, 'file_a')).toBe(0.6)
    expect(state.activity?.peers.peer_b?.outcome).toBe('rejected')
  })

  test('derives complete or error only after every peer is terminal', () => {
    const start = (transferId: string) => ({
      activity: createActivity({
        generation: 1,
        transferId,
        kind: 'file' as const,
        peerIds: ['peer_a', 'peer_b'],
      }),
    })
    let complete = reduceEvent(start('file_ok'), event({
      type: 'transfer:terminal',
      peerId: 'peer_a',
      transferId: 'file_ok',
      outcome: 'completed',
    }))
    expect(complete.activity?.phase).toBe('transferring')
    complete = reduceEvent(complete, event({
      type: 'transfer:terminal',
      peerId: 'peer_b',
      transferId: 'file_ok',
      outcome: 'completed',
    }))

    let failed = reduceEvent(start('file_failed'), event({
      type: 'transfer:terminal',
      peerId: 'peer_a',
      transferId: 'file_failed',
      outcome: 'completed',
    }))
    failed = reduceEvent(failed, event({
      type: 'transfer:terminal',
      peerId: 'peer_b',
      transferId: 'file_failed',
      outcome: 'failed',
      code: 'TRANSFER_ERROR',
    }))

    expect(complete.activity?.phase).toBe('complete')
    expect(failed.activity?.phase).toBe('error')
  })

  test('uses peer close as a terminal disconnect fallback', () => {
    const state = {
      activity: createActivity({
        generation: 1,
        transferId: 'file_1',
        kind: 'file' as const,
        peerIds: ['peer_a'],
      }),
    }

    const next = reduceEvent(state, event({
      type: 'peer:state',
      peerId: 'peer_a',
      state: 'closed',
    }))

    expect(next.activity).toMatchObject({
      phase: 'error',
      peers: { peer_a: { outcome: 'cancelled' } },
    })
  })

  test('ignores stale events and generation-mismatched terminal callbacks', () => {
    const old = createActivity({
      generation: 1,
      transferId: 'old',
      kind: 'file',
      peerIds: ['peer_a'],
    })
    const next = createActivity({
      generation: 2,
      transferId: 'new',
      kind: 'file',
      peerIds: ['peer_a'],
    })
    const state = { activity: next }

    const unchanged = reduceEvent(state, event({
      type: 'transfer:terminal',
      peerId: 'peer_a',
      transferId: 'old',
      outcome: 'completed',
    }))

    expect(unchanged).toBe(state)
    expect(clearTerminalHold(next, {
      generation: old.generation,
      transferId: old.transferId,
    })).toBe(next)
    expect(clearTerminalHold(next, {
      generation: next.generation,
      transferId: next.transferId,
    })).toBeUndefined()
  })

  test('room reset and realtime disconnect clear all presentation state', () => {
    const state = {
      activity: createActivity({
        generation: 1,
        transferId: 'file_1',
        kind: 'file' as const,
        peerIds: ['peer_a'],
      }),
    }

    expect(transferUiReducer(state, { type: 'room:reset' })).toEqual(initialTransferUiState)
    expect(transferUiReducer(state, { type: 'realtime:disconnected' })).toEqual(initialTransferUiState)
  })
})
