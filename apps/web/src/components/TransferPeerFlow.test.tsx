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
  test('keeps the sender left and uses five receiver slots with total-count overflow', () => {
    const sender = createVisitor('sender', 'Sender')
    const receivers = Array.from({ length: 6 }, (_, index) =>
      createVisitor(`receiver-${index + 1}`, `Receiver ${index + 1}`))

    render(
      <TransferPeerFlow
        sender={sender}
        receivers={receivers}
        enteringReceiverIds={[receivers[5]!.id]}
        phase="idle"
        accessibleLabel="6 receivers connected"
      />,
    )

    const status = screen.getByRole('status', { name: '6 receivers connected' })
    const senderSide = status.querySelector('[data-side="sender"]')
    const receiverSide = status.querySelector('[data-side="receivers"]')
    expect(senderSide).not.toBeNull()
    expect(receiverSide).not.toBeNull()
    expect(senderSide!.compareDocumentPosition(receiverSide!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
    expect(screen.getByTitle('Sender')).not.toBeNull()
    expect(screen.getByTitle('Receiver 1')).not.toBeNull()
    expect(screen.getByTitle('Receiver 4')).not.toBeNull()
    expect(screen.queryByTitle('Receiver 5')).toBeNull()
    expect(screen.queryByTitle('Receiver 6')).toBeNull()
    expect(screen.getByTitle('共 6 位接收者').textContent).toBe('6')
    expect(screen.getByTitle('共 6 位接收者').className)
      .toContain('transfer-peer-flow__receiver-count--entering')
    const receiverSummary = screen.getByText('共 6 位接收者')
    expect(receiverSummary.className).toContain('sr-only')
    expect(receiverSummary.closest('[aria-hidden="true"]')).toBeNull()
  })

  test('shows all five receivers before switching to the total-count badge', () => {
    const sender = createVisitor('sender', 'Sender')
    const receivers = Array.from({ length: 5 }, (_, index) =>
      createVisitor(`receiver-${index + 1}`, `Receiver ${index + 1}`))

    render(
      <TransferPeerFlow
        sender={sender}
        receivers={receivers}
        phase="idle"
        accessibleLabel="5 receivers connected"
      />,
    )

    expect(screen.getByTitle('Receiver 5')).not.toBeNull()
    expect(screen.queryByTitle('共 5 位接收者')).toBeNull()
  })

  test('maps connection phases to dots, a line, moving dashes, and state icons', () => {
    const sender = createVisitor('sender', 'Sender')
    const receiver = createVisitor('receiver', 'Receiver')
    const props = { sender, receivers: [receiver], accessibleLabel: 'Peer state' }
    const { rerender } = render(<TransferPeerFlow {...props} phase="connecting" />)
    const status = screen.getByRole('status')

    expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(3)
    expect(Array.from(status.querySelectorAll('.transfer-peer-flow__dot'))
      .every(dot => dot.className.includes('bg-amber-50/80'))).toBe(true)
    expect(status.querySelector('.transfer-peer-flow__line')).toBeNull()

    rerender(<TransferPeerFlow {...props} phase="idle" />)
    expect(status.querySelector('.transfer-peer-flow__line')).not.toBeNull()
    expect(status.querySelector('.transfer-peer-flow__dash')).toBeNull()

    rerender(<TransferPeerFlow {...props} phase="requesting" />)
    expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(3)

    rerender(<TransferPeerFlow {...props} phase="transferring" />)
    expect(status.querySelector('.transfer-peer-flow__dash')).not.toBeNull()
    expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(0)

    rerender(<TransferPeerFlow {...props} phase="complete" />)
    expect(status.querySelector('[data-state-icon="check"]')).not.toBeNull()

    rerender(<TransferPeerFlow {...props} phase="error" />)
    expect(status.querySelector('[data-state-icon="link_off"]')).not.toBeNull()
  })

  test('shows a receiver placeholder while connecting with nobody ready', () => {
    const sender = createVisitor('sender', 'Sender')
    render(
      <TransferPeerFlow
        sender={sender}
        receivers={[]}
        phase="connecting"
        accessibleLabel="Waiting for receivers"
      />,
    )

    const status = screen.getByRole('status')
    const placeholder = status.querySelector('.transfer-peer-flow__placeholder')
    expect(placeholder).not.toBeNull()
    expect(placeholder?.className).toContain('size-12')
    expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(3)
  })

  test('keeps the recipient picker keyboard-focusable and reports selection count', () => {
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

    const status = screen.getByRole('status', { name: 'Ready to send' })
    const trigger = screen.getByRole('button', { name: '选择接收者，已选择 1 位' })
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    expect(screen.getByTitle('Sender').closest('button')).toBeNull()
    expect(status.querySelector('[data-side="receivers"]')).toBe(trigger)

    screen.getByTitle('Sender').click()
    expect(onClick).not.toHaveBeenCalled()

    trigger.click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
