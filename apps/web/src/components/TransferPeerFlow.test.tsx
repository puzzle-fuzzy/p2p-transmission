// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
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
  test('renders real avatars, four receivers, overflow, and one accessible status', () => {
    const sender = createVisitor('sender', 'Sender')
    const receivers = Array.from({ length: 6 }, (_, index) =>
      createVisitor(`receiver-${index + 1}`, `Receiver ${index + 1}`))

    render(
      <TransferPeerFlow
        sender={sender}
        receivers={receivers}
        phase="transferring"
        accessibleLabel="正在向 6 位接收者传输"
      />,
    )

    const status = screen.getByRole('status', { name: '正在向 6 位接收者传输' })
    expect(status.getAttribute('data-active')).toBe('true')
    expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(3)
    expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(screen.getAllByRole('status')).toHaveLength(1)

    expect(screen.getByTitle('Sender').textContent).toBe('ER')
    expect(screen.getByTitle('Receiver 1').textContent).toBe('R1')
    expect(screen.getByTitle('Receiver 4').textContent).toBe('R4')
    expect(screen.queryByTitle('Receiver 5')).toBeNull()
    expect(screen.getByText('+2').textContent).toBe('+2')
  })

  test('animates only requesting and transferring phases', () => {
    const sender = createVisitor('sender', 'Sender')
    const receiver = createVisitor('receiver', 'Receiver')
    const { rerender } = render(
      <TransferPeerFlow
        sender={sender}
        receivers={[receiver]}
        phase="requesting"
        accessibleLabel="等待接收决定"
      />,
    )

    expect(screen.getByRole('status').getAttribute('data-active')).toBe('true')

    rerender(
      <TransferPeerFlow
        sender={sender}
        receivers={[receiver]}
        phase="complete"
        accessibleLabel="传输完成"
      />,
    )

    expect(screen.getByRole('status').getAttribute('data-active')).toBe('false')
    expect(screen.getByRole('status').getAttribute('data-phase')).toBe('complete')
  })
})
