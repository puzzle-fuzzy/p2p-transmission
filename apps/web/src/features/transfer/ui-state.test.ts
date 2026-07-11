import { describe, expect, test } from 'vitest'
import type { PeerSessionEvent } from './peer-session'
import {
  aggregateFileProgress,
  aggregateProgress,
  clearTerminalHold,
  createActivity,
  initialTransferUiState,
  isTransferLocked,
  planIncomingText,
  transferUiReducer,
} from './ui-state'
import type { IncomingTextEvent, TransferUiState } from './ui-state'

const event = <Event extends { type: string }>(value: Event) =>
  value as unknown as PeerSessionEvent

const reduceEvent = (
  state: ReturnType<typeof transferUiReducer>,
  value: PeerSessionEvent,
) => transferUiReducer(state, { type: 'peer-session:event', event: value })

describe('transfer UI state', () => {
  test('creates concrete text and file peer state', () => {
    const text = createActivity({
      generation: 1,
      transferId: 'text_1',
      kind: 'text',
      peerIds: ['peer_a', 'peer_b'],
    })
    const files = createActivity({
      generation: 2,
      transferId: 'files_1',
      kind: 'file',
      peerIds: ['peer_a', 'peer_b'],
      unsupportedPeerIds: ['peer_b'],
      fileIds: ['file_a', 'file_b'],
    })

    expect(text).toMatchObject({
      phase: 'transferring',
      peers: {
        peer_a: { accepted: true, progress: 0 },
        peer_b: { accepted: true, progress: 0 },
      },
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
    expect(isTransferLocked({ activity: text })).toBe(true)
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
        kind: 'text' as const,
        peerIds: ['peer_a', 'peer_b'],
      }),
    })
    let complete = reduceEvent(start('text_ok'), event({
      type: 'transfer:terminal',
      peerId: 'peer_a',
      transferId: 'text_ok',
      outcome: 'completed',
    }))
    expect(complete.activity?.phase).toBe('transferring')
    complete = reduceEvent(complete, event({
      type: 'transfer:terminal',
      peerId: 'peer_b',
      transferId: 'text_ok',
      outcome: 'completed',
    }))

    let failed = reduceEvent(start('text_failed'), event({
      type: 'transfer:terminal',
      peerId: 'peer_a',
      transferId: 'text_failed',
      outcome: 'completed',
    }))
    failed = reduceEvent(failed, event({
      type: 'transfer:terminal',
      peerId: 'peer_b',
      transferId: 'text_failed',
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
        transferId: 'text_1',
        kind: 'text' as const,
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
      kind: 'text',
      peerIds: ['peer_a'],
    })
    const next = createActivity({
      generation: 2,
      transferId: 'new',
      kind: 'text',
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
        transferId: 'text_1',
        kind: 'text' as const,
        peerIds: ['peer_a'],
      }),
    }

    expect(transferUiReducer(state, { type: 'room:reset' })).toEqual(initialTransferUiState)
    expect(transferUiReducer(state, { type: 'realtime:disconnected' })).toEqual(initialTransferUiState)
  })
})

describe('incoming text FIFO planning', () => {
  test('acknowledges exactly five queued bodies and discards overflow', () => {
    let queue: IncomingTextEvent[] = []

    for (let index = 0; index < 5; index += 1) {
      const incoming: IncomingTextEvent = {
        type: 'transfer:text-received',
        peerId: `peer_${String(index)}`,
        transferId: `text_${String(index)}`,
        text: `第 ${String(index + 1)} 条\n🙂`,
      }
      const planned = planIncomingText(queue, incoming, 5)

      expect(planned.disposition).toBe('acknowledge')
      queue = planned.queue
    }

    const overflow: IncomingTextEvent = {
      type: 'transfer:text-received',
      peerId: 'peer_overflow',
      transferId: 'text_overflow',
      text: '不应覆盖队列',
    }
    const planned = planIncomingText(queue, overflow, 5)

    expect(queue.map(item => item.text)).toEqual([
      '第 1 条\n🙂',
      '第 2 条\n🙂',
      '第 3 条\n🙂',
      '第 4 条\n🙂',
      '第 5 条\n🙂',
    ])
    expect(planned).toEqual({ queue, disposition: 'discard' })
    expect(planned.queue).toBe(queue)
  })
})
