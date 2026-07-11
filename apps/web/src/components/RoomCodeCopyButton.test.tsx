// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '../test/dom'
import RoomCodeCopyButton from './RoomCodeCopyButton'

describe('RoomCodeCopyButton', () => {
  test('keeps a borderless circular 44px copy affordance in every copy state', async () => {
    const user = userEvent.setup()
    let resolveCopy: (() => void) | undefined
    const onCopy = vi.fn(() => new Promise<void>(resolve => {
      resolveCopy = resolve
    }))
    render(<RoomCodeCopyButton code="012345" onCopy={onCopy} />)

    const button = screen.getByRole('button', { name: '复制房间码' })
    const liveRegion = document.querySelector('[aria-live="polite"]')
    expect(button.classList.contains('min-h-11')).toBe(true)
    expect(button.classList.contains('min-w-11')).toBe(true)
    expect(button.classList.contains('rounded-full')).toBe(true)
    expect(Array.from(button.classList).some(className =>
      className === 'border' || className.startsWith('border-'))).toBe(false)
    expect(button.classList.contains('hover:bg-white/5')).toBe(true)
    expect(button.classList.contains('focus-visible:bg-white/5')).toBe(true)
    expect(button.classList.contains('disabled:bg-transparent')).toBe(true)
    expect(button.textContent?.trim()).toBe('content_copy')
    expect(liveRegion).not.toBeNull()

    await user.click(button)

    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(onCopy).toHaveBeenCalledWith('012345')
    expect(button.getAttribute('data-status')).toBe('copying')
    expect(button.textContent?.trim()).toBe('content_copy')
    expect(liveRegion?.textContent).toBe('正在复制房间码')

    resolveCopy?.()
    await waitFor(() => expect(button.getAttribute('data-status')).toBe('copied'))
    expect(button.textContent?.trim()).toBe('content_copy')
    expect(liveRegion?.textContent).toBe('房间码已复制')
  })

  test('keeps the copy icon and accessible name after a rejected copy', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn(() => Promise.reject(new Error('denied')))
    render(<RoomCodeCopyButton code="654321" onCopy={onCopy} />)

    const button = screen.getByRole('button', { name: '复制房间码' })
    const accessibleName = button.getAttribute('aria-label')
    await user.click(button)

    expect(button.getAttribute('data-status')).toBe('error')
    expect(button.textContent?.trim()).toBe('content_copy')
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('无法复制房间码')
    expect(screen.getByRole('button', { name: '复制房间码' })).toBe(button)
    expect(button.getAttribute('aria-label')).toBe(accessibleName)
  })
})
