// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import '../test/dom'
import type { PublicVisitor } from '../shared/contracts'
import ReceiverPanel from './ReceiverPanel'

const sender: PublicVisitor = {
  id: 'sender',
  avatarSeed: 'sender-seed',
  displayName: '发送者甲',
  createdAt: 1,
  lastSeenAt: 1,
}

const receiver: PublicVisitor = {
  id: 'receiver',
  avatarSeed: 'receiver-seed',
  displayName: '接收者乙',
  createdAt: 1,
  lastSeenAt: 1,
}

const otherReceiver: PublicVisitor = {
  id: 'receiver-other',
  avatarSeed: 'other-receiver-seed',
  displayName: '接收者丙',
  createdAt: 1,
  lastSeenAt: 1,
}

describe('ReceiverPanel', () => {
  test('uses one sender-left receiver-group flow across receiver states', () => {
    const { rerender } = render(
      <ReceiverPanel
        visitor={receiver}
        sender={sender}
        receivers={[receiver, otherReceiver]}
        connected={false}
        state={{ status: 'waiting' }}
      />,
    )

    const status = screen.getByRole('status', { name: '正在建立点对点连接' })
    expect(status.getAttribute('data-phase')).toBe('connecting')
    expect(screen.getAllByTitle('接收者乙')).toHaveLength(1)
    expect(screen.getByTitle('发送者甲')).not.toBeNull()
    expect(screen.getByTitle('接收者乙').querySelector('[data-avatar-face]')?.getAttribute('style'))
      .toContain('border-color: rgb(255, 255, 255)')
    expect(screen.getByTitle('接收者丙').style.borderColor).toBe('')

    rerender(
      <ReceiverPanel
        visitor={receiver}
        sender={sender}
        receivers={[receiver, otherReceiver]}
        connected
        state={{ status: 'waiting' }}
      />,
    )
    expect(status.getAttribute('data-phase')).toBe('idle')
    expect(status.querySelector('.transfer-peer-flow__line')).not.toBeNull()

    rerender(
      <ReceiverPanel
        visitor={receiver}
        sender={sender}
        receivers={[receiver, otherReceiver]}
        connected
        state={{ status: 'receiving' }}
      />,
    )
    expect(status.getAttribute('data-phase')).toBe('transferring')
    expect(status.querySelector('.transfer-peer-flow__dash')).not.toBeNull()

    rerender(
      <ReceiverPanel
        visitor={receiver}
        sender={sender}
        receivers={[receiver, otherReceiver]}
        connected={false}
        state={{ status: 'error', message: '发送者已离开' }}
      />,
    )
    expect(status.getAttribute('data-phase')).toBe('error')
    expect(status.querySelector('[data-state-icon="link_off"]')).not.toBeNull()
    expect(screen.getByText('发送者已离开')).not.toBeNull()
  })
})
