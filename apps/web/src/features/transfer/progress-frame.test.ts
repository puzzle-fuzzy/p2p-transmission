import { describe, expect, test, vi } from 'vitest'
import { createProgressFrameScheduler } from './progress-frame'

type ProgressEvent = {
  peerId: string
  fileId: string
  batchBytes: number
}

const createFrameHarness = () => {
  let nextId = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextId
    callbacks.set(id, callback)
    return id
  })
  const cancelFrame = vi.fn((id: number) => {
    callbacks.delete(id)
  })

  return {
    requestFrame,
    cancelFrame,
    callback(id: number) {
      return callbacks.get(id)
    },
    run(id: number) {
      const callback = callbacks.get(id)
      callbacks.delete(id)
      callback?.(0)
    },
  }
}

describe('progress frame scheduler', () => {
  test('coalesces many pushes into one frame and keeps the latest key value', () => {
    const frames = createFrameHarness()
    const onFlush = vi.fn<(events: readonly ProgressEvent[]) => void>()
    const scheduler = createProgressFrameScheduler<ProgressEvent>({ ...frames, onFlush })

    scheduler.push({ peerId: 'peer_a', fileId: 'file_a', batchBytes: 1 })
    scheduler.push({ peerId: 'peer_a', fileId: 'file_a', batchBytes: 2 })
    scheduler.push({ peerId: 'peer_a', fileId: 'file_a', batchBytes: 3 })

    expect(frames.requestFrame).toHaveBeenCalledTimes(1)
    expect(onFlush).not.toHaveBeenCalled()

    frames.run(1)

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush).toHaveBeenCalledWith([
      { peerId: 'peer_a', fileId: 'file_a', batchBytes: 3 },
    ])
  })

  test('flushes independent peer/file keys in deterministic order', () => {
    const frames = createFrameHarness()
    const flushed: Array<readonly ProgressEvent[]> = []
    const scheduler = createProgressFrameScheduler<ProgressEvent>({
      ...frames,
      onFlush: events => flushed.push(events),
    })

    scheduler.push({ peerId: 'peer_b', fileId: 'file_a', batchBytes: 2 })
    scheduler.push({ peerId: 'peer_a', fileId: 'file_b', batchBytes: 3 })
    scheduler.push({ peerId: 'peer_a', fileId: 'file_a', batchBytes: 1 })
    frames.run(1)

    expect(flushed).toEqual([[
      { peerId: 'peer_a', fileId: 'file_a', batchBytes: 1 },
      { peerId: 'peer_a', fileId: 'file_b', batchBytes: 3 },
      { peerId: 'peer_b', fileId: 'file_a', batchBytes: 2 },
    ]])
  })

  test('schedules a new frame after the prior flush', () => {
    const frames = createFrameHarness()
    const onFlush = vi.fn<(events: readonly ProgressEvent[]) => void>()
    const scheduler = createProgressFrameScheduler<ProgressEvent>({ ...frames, onFlush })

    scheduler.push({ peerId: 'peer_a', fileId: 'file_a', batchBytes: 1 })
    frames.run(1)
    scheduler.push({ peerId: 'peer_a', fileId: 'file_a', batchBytes: 2 })

    expect(frames.requestFrame).toHaveBeenCalledTimes(2)
    frames.run(2)
    expect(onFlush).toHaveBeenNthCalledWith(2, [
      { peerId: 'peer_a', fileId: 'file_a', batchBytes: 2 },
    ])
  })

  test('clear cancels the pending frame, drops buffered events, and invalidates stale callbacks', () => {
    const frames = createFrameHarness()
    const onFlush = vi.fn<(events: readonly ProgressEvent[]) => void>()
    const scheduler = createProgressFrameScheduler<ProgressEvent>({ ...frames, onFlush })

    scheduler.push({ peerId: 'peer_a', fileId: 'file_a', batchBytes: 1 })
    const staleCallback = frames.callback(1)
    scheduler.clear()

    expect(frames.cancelFrame).toHaveBeenCalledWith(1)
    staleCallback?.(0)
    expect(onFlush).not.toHaveBeenCalled()

    scheduler.push({ peerId: 'peer_b', fileId: 'file_b', batchBytes: 2 })
    frames.run(2)

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush).toHaveBeenCalledWith([
      { peerId: 'peer_b', fileId: 'file_b', batchBytes: 2 },
    ])

    scheduler.clear()
    expect(frames.cancelFrame).toHaveBeenCalledTimes(1)
  })
})
