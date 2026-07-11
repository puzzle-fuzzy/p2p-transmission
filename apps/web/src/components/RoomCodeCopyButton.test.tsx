// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '../test/dom'
import RoomCodeCopyButton from './RoomCodeCopyButton'

describe('RoomCodeCopyButton', () => {
  test('copies the exact code and reports success', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn(async () => undefined)
    render(<RoomCodeCopyButton code="012345" onCopy={onCopy} />)

    const button = screen.getByRole('button', { name: '复制房间码' })
    expect(button.classList.contains('min-h-11')).toBe(true)
    expect(button.classList.contains('min-w-11')).toBe(true)

    await user.click(button)

    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(onCopy).toHaveBeenCalledWith('012345')
    expect(button.getAttribute('data-status')).toBe('copied')
    expect(screen.getByText('房间码已复制').textContent).toBe('房间码已复制')
  })

  test('reports a rejected copy without changing its accessible name', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn(() => Promise.reject(new Error('denied')))
    render(<RoomCodeCopyButton code="654321" onCopy={onCopy} />)

    const button = screen.getByRole('button', { name: '复制房间码' })
    await user.click(button)

    expect(button.getAttribute('data-status')).toBe('error')
    expect(screen.getByText('无法复制房间码').textContent).toBe('无法复制房间码')
    expect(screen.getByRole('button', { name: '复制房间码' })).toBe(button)
  })
})
