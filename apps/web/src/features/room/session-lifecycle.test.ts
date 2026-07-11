import { describe, expect, test, vi } from 'vitest'
import { createRoomSessionLifecycle } from './session-lifecycle'

describe('room session lifecycle', () => {
  test('expires once at the room deadline', () => {
    vi.useFakeTimers()
    let now = 100
    const onExpire = vi.fn()
    const lifecycle = createRoomSessionLifecycle({
      expiresAt: 1_000,
      now: () => now,
      onExpire,
    })
    lifecycle.start()
    now = 1_000
    vi.advanceTimersByTime(900)

    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(lifecycle.isActive()).toBe(false)
    expect(lifecycle.check()).toBe(false)
    expect(onExpire).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  test('rechecks on visibility, reconnect, and peer retry', () => {
    let now = 100
    const onExpire = vi.fn()
    const lifecycle = createRoomSessionLifecycle({
      expiresAt: 1_000,
      now: () => now,
      setTimer: () => 1 as ReturnType<typeof setTimeout>,
      clearTimer: vi.fn(),
      onExpire,
    })
    lifecycle.start()
    expect(lifecycle.onVisibilityChange()).toBe(true)
    expect(lifecycle.onReconnect()).toBe(true)
    now = 1_000
    expect(lifecycle.beforePeerRetry()).toBe(false)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  test('stop and stale generations suppress expiration', () => {
    const onExpire = vi.fn()
    const clearTimer = vi.fn()
    let current = true
    const lifecycle = createRoomSessionLifecycle({
      expiresAt: 1_000,
      now: () => 100,
      setTimer: () => 7 as ReturnType<typeof setTimeout>,
      clearTimer,
      isCurrent: () => current,
      onExpire,
    })
    lifecycle.start()
    lifecycle.stop()
    expect(clearTimer).toHaveBeenCalledWith(7)
    expect(onExpire).not.toHaveBeenCalled()

    current = false
    const stale = createRoomSessionLifecycle({
      expiresAt: 1_000,
      now: () => 1_000,
      isCurrent: () => current,
      onExpire,
    })
    stale.start()
    expect(onExpire).not.toHaveBeenCalled()
    expect(stale.isActive()).toBe(false)
  })
})
