import { afterEach, describe, expect, test, vi } from 'vitest'
import type { RoomJoinRequestReceipt } from '../../shared/contracts'
import { createJoinRequestPoller } from './join-request-poller'

const receipt = (
  state: RoomJoinRequestReceipt['state'],
): RoomJoinRequestReceipt => ({
  requestId: 'request-1',
  state,
  expiresAt: 10_000,
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('join request poller', () => {
  test('reads immediately, waits two seconds between pending reads, and stops on terminal state', async () => {
    vi.useFakeTimers()
    const onReceipt = vi.fn()
    const read = vi.fn()
      .mockResolvedValueOnce(receipt('pending'))
      .mockResolvedValueOnce(receipt('approved'))
    const poller = createJoinRequestPoller({
      read,
      onReceipt,
      onError: vi.fn(),
    })

    poller.start()
    expect(read).toHaveBeenCalledTimes(1)
    await flushPromises()
    expect(onReceipt).toHaveBeenCalledWith(receipt('pending'))

    await vi.advanceTimersByTimeAsync(1_999)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    expect(onReceipt).toHaveBeenLastCalledWith(receipt('approved'))

    await vi.advanceTimersByTimeAsync(10_000)
    expect(read).toHaveBeenCalledTimes(2)
  })

  test('uses recursive scheduling so reads never overlap', async () => {
    vi.useFakeTimers()
    const first = deferred<RoomJoinRequestReceipt>()
    const second = deferred<RoomJoinRequestReceipt>()
    const read = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const poller = createJoinRequestPoller({
      read,
      onReceipt: vi.fn(),
      onError: vi.fn(),
      intervalMs: 2_000,
    })

    poller.start()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(read).toHaveBeenCalledTimes(1)

    first.resolve(receipt('pending'))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(read).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(20_000)
    expect(read).toHaveBeenCalledTimes(2)
    second.resolve(receipt('approved'))
    await flushPromises()
  })

  test('reports a read error once and stops', async () => {
    vi.useFakeTimers()
    const error = new Error('offline')
    const onError = vi.fn()
    const read = vi.fn().mockRejectedValue(error)
    const poller = createJoinRequestPoller({
      read,
      onReceipt: vi.fn(),
      onError,
    })

    poller.start()
    await flushPromises()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(error)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(read).toHaveBeenCalledTimes(1)
  })

  test('stop is idempotent and cancels a scheduled read', async () => {
    const scheduled: Array<() => void> = []
    const cancelSchedule = vi.fn()
    const schedule = vi.fn((handler: () => void) => {
      scheduled.push(handler)
      return 7 as unknown as ReturnType<typeof setTimeout>
    })
    const read = vi.fn().mockResolvedValue(receipt('pending'))
    const poller = createJoinRequestPoller({
      read,
      onReceipt: vi.fn(),
      onError: vi.fn(),
      schedule,
      cancelSchedule,
    })

    poller.start()
    await flushPromises()
    expect(schedule).toHaveBeenCalledTimes(1)

    poller.stop()
    poller.stop()

    expect(cancelSchedule).toHaveBeenCalledTimes(1)
    expect(cancelSchedule).toHaveBeenCalledWith(7)
    scheduled[0]?.()
    await flushPromises()
    expect(read).toHaveBeenCalledTimes(1)
  })

  test('a stopped generation cannot publish after restart', async () => {
    const stale = deferred<RoomJoinRequestReceipt>()
    const current = deferred<RoomJoinRequestReceipt>()
    const onReceipt = vi.fn()
    const read = vi.fn()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise)
    const poller = createJoinRequestPoller({
      read,
      onReceipt,
      onError: vi.fn(),
    })

    poller.start()
    poller.stop()
    poller.start()
    expect(read).toHaveBeenCalledTimes(2)

    current.resolve(receipt('approved'))
    await flushPromises()
    expect(onReceipt).toHaveBeenCalledTimes(1)
    expect(onReceipt).toHaveBeenCalledWith(receipt('approved'))

    stale.resolve(receipt('pending'))
    await flushPromises()
    expect(onReceipt).toHaveBeenCalledTimes(1)
  })
})
