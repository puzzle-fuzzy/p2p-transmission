// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '../test/dom'
import type { PublicVisitor } from '../shared/contracts'
import ReceivedTextDialog from './ReceivedTextDialog'

const sender: PublicVisitor = {
  id: 'sender',
  avatarSeed: 'sender-seed',
  displayName: '发送者甲',
  createdAt: 1,
  lastSeenAt: 1,
}

describe('ReceivedTextDialog', () => {
  test('shows the exact body with only Copy and Close actions and focuses Close', () => {
    const text = '第一行\n第二行 🙂'
    render(
      <ReceivedTextDialog
        sender={sender}
        text={text}
        copyStatus="idle"
        onCopy={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const body = screen.getByText((_, element) =>
      element?.tagName === 'DIV' && element.textContent === text)
    const close = screen.getByRole('button', { name: '关闭' })

    expect(body.textContent).toBe(text)
    expect(body.classList.contains('whitespace-pre-wrap')).toBe(true)
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: '接收' })).toBeNull()
    expect(screen.queryByRole('button', { name: '拒绝' })).toBeNull()
    expect(screen.queryByText(/B|KB|MB/, { selector: 'span' })).toBeNull()
    expect(document.activeElement).toBe(close)
  })

  test('reports Copy success and failure without closing or changing the body', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn()
    const onClose = vi.fn()
    const text = '保留这段正文'
    const { rerender } = render(
      <ReceivedTextDialog
        sender={sender}
        text={text}
        copyStatus="idle"
        onCopy={onCopy}
        onClose={onClose}
      />,
    )

    await user.click(screen.getByRole('button', { name: '复制' }))
    expect(onCopy).toHaveBeenCalledTimes(1)

    rerender(
      <ReceivedTextDialog
        sender={sender}
        text={text}
        copyStatus="copied"
        onCopy={onCopy}
        onClose={onClose}
      />,
    )
    expect(screen.getByRole('button', { name: '已复制' })).not.toBeNull()
    expect((screen.getByRole('dialog') as HTMLDialogElement).open).toBe(true)

    rerender(
      <ReceivedTextDialog
        sender={sender}
        text={text}
        copyStatus="error"
        onCopy={onCopy}
        onClose={onClose}
      />,
    )
    expect(screen.getByRole('button', { name: '复制失败' })).not.toBeNull()
    expect(screen.getByText(text).textContent).toBe(text)
    expect(onClose).not.toHaveBeenCalled()
  })

  test('treats native Escape cancel as Close exactly once and ignores backdrop clicks', () => {
    const onClose = vi.fn()
    render(
      <ReceivedTextDialog
        sender={sender}
        text="正文"
        copyStatus="idle"
        onCopy={vi.fn()}
        onClose={onClose}
      />,
    )

    const dialog = screen.getByRole('dialog')
    fireEvent.click(dialog)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
