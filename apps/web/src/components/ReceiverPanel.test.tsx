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

describe('ReceiverPanel', () => {
  test('shows only sender identity and connection/receiving states', () => {
    const { rerender } = render(
      <ReceiverPanel sender={sender} state={{ status: 'waiting' }} />,
    )

    expect(screen.getByRole('region', { name: '接收状态' })).not.toBeNull()
    expect(screen.getByText('发送者甲').textContent).toBe('发送者甲')
    expect(screen.getByRole('heading', { name: '等待对方发送' })).not.toBeNull()
    expect(screen.queryByRole('button')).toBeNull()

    rerender(<ReceiverPanel sender={sender} state={{ status: 'receiving' }} />)
    expect(screen.getByRole('heading', { name: '正在接收文件' })).not.toBeNull()

    rerender(
      <ReceiverPanel
        sender={sender}
        state={{ status: 'error', message: '发送者已离开' }}
      />,
    )
    expect(screen.getByText('发送者已离开').textContent).toBe('发送者已离开')
  })
})
