// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { setupNotificationPermissionPrompt } from './notifications'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('setupNotificationPermissionPrompt', () => {
  test('returns an idempotent cleanup that deactivates the visibility listener', () => {
    const requestPermission = vi.fn(async () => 'granted' as NotificationPermission)
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission,
    })
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const addListener = vi.spyOn(document, 'addEventListener')
    const removeListener = vi.spyOn(document, 'removeEventListener')

    const cleanup = setupNotificationPermissionPrompt()
    const visibilityCall = addListener.mock.calls.find(
      ([type]) => type === 'visibilitychange',
    )
    const handler = visibilityCall?.[1] as EventListener | undefined

    expect(handler).toBeDefined()
    cleanup()
    cleanup()
    expect(removeListener).toHaveBeenCalledTimes(1)

    handler?.(new Event('visibilitychange'))
    expect(requestPermission).not.toHaveBeenCalled()
  })
})
