// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import RoomRecoveryPrompt from './RoomRecoveryPrompt'

describe('RoomRecoveryPrompt', () => {
  test('retries the retained room identity explicitly', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()

    render(
      <RoomRecoveryPrompt
        roomCode="123456"
        onRetry={onRetry}
      />,
    )

    expect(screen.getByText('123456')).not.toBeNull()
    expect(screen.getByText('上次房间暂时未连接')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: '重新连接' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  test('prevents duplicate retries while recovery is in flight', () => {
    render(
      <RoomRecoveryPrompt
        roomCode="123456"
        busy
        onRetry={vi.fn()}
      />,
    )

    const button = screen.getByRole('button', { name: '重新连接中…' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })
})
