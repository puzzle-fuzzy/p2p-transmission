// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '../test/dom'
import type { PublicVisitor } from '../shared/contracts'
import TransferPeerFlow from './TransferPeerFlow'

const createVisitor = (id: string, displayName: string): PublicVisitor => ({
  id,
  avatarSeed: `seed-${id}`,
  displayName,
  createdAt: 1,
  lastSeenAt: 1,
})

describe('TransferPeerFlow', () => {
  test('renders at most three receivers, overflow, and one accessible status', () => {
    const sender = createVisitor('sender', 'Sender')
    const receivers = Array.from({ length: 6 }, (_, index) =>
      createVisitor(`receiver-${index + 1}`, `Receiver ${index + 1}`))

    render(
      <TransferPeerFlow
        sender={sender}
        receivers={receivers}
        phase="transferring"
        accessibleLabel="Transferring to 6 receivers"
      />,
    )

    const status = screen.getByRole('status', { name: 'Transferring to 6 receivers' })
    expect(status.getAttribute('data-active')).toBe('true')
    expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(3)
    expect(status.querySelector('.transfer-peer-flow__line')).toBeNull()
    expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(screen.getAllByRole('status')).toHaveLength(1)

    expect(screen.getByTitle('Sender').textContent).toBe('ER')
    expect(screen.getByTitle('Receiver 1').textContent).toBe('R1')
    expect(screen.getByTitle('Receiver 3').textContent).toBe('R3')
    expect(screen.queryByTitle('Receiver 4')).toBeNull()
    const overflow = screen.getByText('+3')
    expect(overflow.textContent).toBe('+3')
    expect(overflow.className).toContain('max-sm:size-8!')
  })

  test('renders only the sender when no receiver is connected', () => {
    const sender = createVisitor('sender', 'Sender')
    render(
      <TransferPeerFlow
        sender={sender}
        receivers={[]}
        phase="idle"
        accessibleLabel="0 receivers connected"
      />,
    )

    const status = screen.getByRole('status', { name: '0 receivers connected' })
    expect(screen.getByTitle('Sender')).not.toBeNull()
    expect(status.querySelector('.transfer-peer-flow__line')).toBeNull()
    expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(0)
    expect(status.getAttribute('data-active')).toBe('false')
  })

  test('uses a fixed static line except while transferring', () => {
    const sender = createVisitor('sender', 'Sender')
    const receiver = createVisitor('receiver', 'Receiver')
    const { rerender } = render(
      <TransferPeerFlow
        sender={sender}
        receivers={[receiver]}
        phase="requesting"
        accessibleLabel="Waiting for receiver decision"
      />,
    )

    const status = screen.getByRole('status')
    const requestingLine = status.querySelector('.transfer-peer-flow__line')
    expect(status.getAttribute('data-active')).toBe('false')
    expect(requestingLine).not.toBeNull()
    expect(requestingLine?.parentElement?.className).toContain('w-5')
    expect(requestingLine?.parentElement?.className).toContain('sm:w-8')
    expect(screen.getByTitle('Sender').className).toContain('max-sm:size-8!')
    expect(screen.getByTitle('Receiver').className).toContain('max-sm:size-8!')
    expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(0)

    rerender(
      <TransferPeerFlow
        sender={sender}
        receivers={[receiver]}
        phase="transferring"
        accessibleLabel="Transferring"
      />,
    )

    expect(status.getAttribute('data-active')).toBe('true')
    expect(status.querySelector('.transfer-peer-flow__line')).toBeNull()
    expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(3)
    expect(status.querySelector('.transfer-peer-flow__dot')?.parentElement?.className)
      .toContain('sm:gap-1.5')

    rerender(
      <TransferPeerFlow
        sender={sender}
        receivers={[receiver]}
        phase="complete"
        accessibleLabel="Transfer complete"
      />,
    )

    expect(status.getAttribute('data-active')).toBe('false')
    expect(status.getAttribute('data-phase')).toBe('complete')
    expect(status.querySelector('.transfer-peer-flow__line')).not.toBeNull()
    expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(0)
  })

  test('exposes a keyboard-focusable recipient picker trigger with the selected count', () => {
    const sender = createVisitor('sender', 'Sender')
    const receiver = createVisitor('receiver', 'Receiver')
    const onClick = vi.fn()

    render(
      <TransferPeerFlow
        sender={sender}
        receivers={[receiver]}
        phase="idle"
        accessibleLabel="Ready to send"
        onClick={onClick}
        selectedCount={1}
      />,
    )

    const trigger = screen.getByRole('button', { name: '选择接收者，已选择 1 位' })
    expect(trigger.getAttribute('title')).toBe('选择接收者')
    trigger.focus()
    expect(document.activeElement).toBe(trigger)
    trigger.click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
