// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '../test/dom'
import type { RoomJoinRequestSummary } from '../shared/contracts'
import SenderJoinRequestDialog from './SenderJoinRequestDialog'

const request: RoomJoinRequestSummary = {
  requestId: 'request-1',
  roomCode: '123456',
  visitor: {
    id: 'visitor-1',
    avatarSeed: 'visitor-seed',
    displayName: '访客一号',
    createdAt: 1,
    lastSeenAt: 1,
  },
  createdAt: 2,
  expiresAt: 92_000,
}

const renderDialog = (overrides: Partial<React.ComponentProps<typeof SenderJoinRequestDialog>> = {}) => {
  const props: React.ComponentProps<typeof SenderJoinRequestDialog> = {
    onApprove: vi.fn(),
    onReject: vi.fn(),
    remainingCount: 0,
    request,
    ...overrides,
  }

  render(<SenderJoinRequestDialog {...props} />)
  return props
}

describe('SenderJoinRequestDialog', () => {
  test('shows the visitor and room with a larger approval action', async () => {
    const user = userEvent.setup()
    const props = renderDialog({ remainingCount: 2 })

    expect(screen.getByRole('heading', { name: '加入申请' })).not.toBeNull()
    expect(screen.getByText('访客一号')).not.toBeNull()
    expect(screen.getByLabelText('访客一号')).not.toBeNull()
    expect(screen.getByText('房间 123456')).not.toBeNull()
    expect(screen.getByText('还有 2 个申请')).not.toBeNull()

    const approve = screen.getByRole('button', { name: '允许加入' })
    const reject = screen.getByRole('button', { name: '拒绝' })
    expect(approve.className).toContain('min-h-11')
    expect(reject.className).toContain('min-h-11')
    expect(approve.parentElement?.className)
      .toContain('grid-cols-[minmax(0,1fr)_minmax(0,2fr)]')

    await user.click(approve)
    expect(props.onApprove).toHaveBeenCalledWith('request-1')
    expect(props.onReject).not.toHaveBeenCalled()
  })

  test('rejects the exact visible request', async () => {
    const user = userEvent.setup()
    const props = renderDialog()

    await user.click(screen.getByRole('button', { name: '拒绝' }))

    expect(props.onReject).toHaveBeenCalledWith('request-1')
    expect(props.onApprove).not.toHaveBeenCalled()
  })

  test('disables both decisions while either action is pending', () => {
    const { unmount } = render(
      <SenderJoinRequestDialog
        request={request}
        remainingCount={0}
        pendingDecision="approve"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    )

    expect((screen.getByRole('button', { name: '允许中…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement).disabled).toBe(true)

    unmount()
    renderDialog({ pendingDecision: 'reject' })
    expect((screen.getByRole('button', { name: '允许加入' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '拒绝中…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('cannot discard a visible request through Escape or backdrop clicks', () => {
    const props = renderDialog()
    const dialog = screen.getByRole('dialog')

    fireEvent.click(dialog)
    fireEvent(dialog, new Event('cancel', { cancelable: true }))

    expect(dialog.hasAttribute('open')).toBe(true)
    expect(props.onApprove).not.toHaveBeenCalled()
    expect(props.onReject).not.toHaveBeenCalled()
  })
})
