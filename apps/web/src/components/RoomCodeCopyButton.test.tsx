// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '../test/dom'
import RoomCodeCopyButton from './RoomCodeCopyButton'

describe('RoomCodeCopyButton', () => {
  test('makes the room code and icon one exact-once copy target', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn(async () => undefined)
    render(<RoomCodeCopyButton code="012345" onCopy={onCopy} />)

    const button = screen.getByRole('button', { name: '复制房间码' })
    const code = within(button).getByText('012345')
    const icon = within(button).getByText('content_copy')
    const liveRegion = document.querySelector('[aria-live="polite"]')
    expect(button.classList.contains('min-h-11')).toBe(true)
    expect(button.classList.contains('rounded-xl')).toBe(true)
    expect(button.classList.contains('hover:bg-white/5')).toBe(true)
    expect(button.classList.contains('focus-visible:bg-white/5')).toBe(true)
    expect(Array.from(button.classList).some(className =>
      className === 'border' || className.startsWith('border-'))).toBe(false)
    expect(icon.parentElement?.classList.contains('size-11')).toBe(true)
    expect(icon.parentElement?.classList.contains('rounded-full')).toBe(false)
    expect(liveRegion).not.toBeNull()

    await user.click(code)

    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(onCopy).toHaveBeenCalledWith('012345')
    await waitFor(() => expect(button.getAttribute('data-status')).toBe('copied'))
    expect(liveRegion?.textContent).toBe('房间码已复制')

    await user.click(icon)
    expect(onCopy).toHaveBeenCalledTimes(2)
  })

  test('keeps the copy icon and accessible name after a rejected copy', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn(() => Promise.reject(new Error('denied')))
    render(<RoomCodeCopyButton code="654321" onCopy={onCopy} />)

    const button = screen.getByRole('button', { name: '复制房间码' })
    const accessibleName = button.getAttribute('aria-label')
    await user.click(button)

    expect(button.getAttribute('data-status')).toBe('error')
    expect(within(button).getByText('654321')).not.toBeNull()
    expect(within(button).getByText('content_copy')).not.toBeNull()
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('无法复制房间码')
    expect(screen.getByRole('button', { name: '复制房间码' })).toBe(button)
    expect(button.getAttribute('aria-label')).toBe(accessibleName)
  })
})
