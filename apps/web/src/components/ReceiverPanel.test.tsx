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

describe('ReceiverPanel', () => {
  test('shows receiver identity, peer flow, and connection states', () => {
    const { rerender } = render(
      <ReceiverPanel
        visitor={receiver}
        sender={sender}
        receivers={[receiver]}
        state={{ status: 'waiting' }}
      />,
    )

    expect(screen.getByRole('region', { name: '接收状态' })).not.toBeNull()
    expect(screen.getByText('接收者乙').textContent).toBe('接收者乙')
    expect(screen.getByText('接收者').textContent).toBe('接收者')
    expect(screen.getByRole('status', { name: '1 位接收者在房间内' }))
      .not.toBeNull()
    expect(screen.getByTitle('发送者甲')).not.toBeNull()
    expect(screen.getAllByTitle('接收者乙')).toHaveLength(2)
    expect(screen.getByRole('status').querySelector('.transfer-peer-flow__line'))
      .not.toBeNull()
    expect(screen.getByRole('status').querySelectorAll('.transfer-peer-flow__dot'))
      .toHaveLength(0)
    expect(screen.getByRole('heading', { name: '等待对方发送' })).not.toBeNull()
    expect(screen.queryByRole('button')).toBeNull()

    rerender(
      <ReceiverPanel
        visitor={receiver}
        sender={sender}
        receivers={[receiver]}
        state={{ status: 'receiving' }}
      />,
    )
    expect(screen.getByRole('heading', { name: '正在接收文件' })).not.toBeNull()
    expect(screen.getByRole('status', { name: '正在接收来自发送者的文件' })
      .querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(3)

    rerender(
      <ReceiverPanel
        visitor={receiver}
        sender={sender}
        receivers={[receiver]}
        state={{ status: 'error', message: '发送者已离开' }}
      />,
    )
    expect(screen.getByText('发送者已离开').textContent).toBe('发送者已离开')
  })
})
