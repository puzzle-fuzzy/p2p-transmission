// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '../test/dom'
import type { PublicVisitor } from '../shared/contracts'
import ManualJoinWaiting from './ManualJoinWaiting'

const visitor: PublicVisitor = {
  id: 'visitor-1',
  avatarSeed: 'visitor-seed',
  displayName: '访客一号',
  createdAt: 1,
  lastSeenAt: 1,
}

const renderWaiting = (overrides: Partial<React.ComponentProps<typeof ManualJoinWaiting>> = {}) => {
  const props: React.ComponentProps<typeof ManualJoinWaiting> = {
    expiresAt: Date.now() + 90_000,
    onCancel: vi.fn(),
    onChangeRoom: vi.fn(),
    roomCode: '123456',
    visitor,
    ...overrides,
  }

  render(<ManualJoinWaiting {...props} />)
  return props
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ManualJoinWaiting', () => {
  test('shows the bound visitor, room, and authoritative countdown', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T00:00:00.000Z'))
    renderWaiting({ expiresAt: Date.now() + 90_000 })

    expect(screen.getByText('等待发送者确认')).not.toBeNull()
    expect(screen.getByText('访客一号')).not.toBeNull()
    expect(screen.getByLabelText('访客一号')).not.toBeNull()
    expect(screen.getByText('123456')).not.toBeNull()
    const countdown = screen.getByText('申请将在 01:30 后失效')
    expect(countdown.getAttribute('aria-live')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()

    act(() => vi.advanceTimersByTime(31_000))

    expect(screen.getByText('申请将在 00:59 后失效')).not.toBeNull()

    act(() => vi.advanceTimersByTime(59_000))

    expect(screen.getByRole('status').textContent).toBe('申请已过期')
  })

  test('requests cancellation or room replacement without leaving the view itself', () => {
    const props = renderWaiting()

    fireEvent.click(screen.getByRole('button', { name: '取消申请' }))
    fireEvent.click(screen.getByRole('button', { name: '更换房间' }))

    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onChangeRoom).toHaveBeenCalledTimes(1)
    expect(screen.getByText('等待发送者确认')).not.toBeNull()
  })

  test('preserves the waiting context and offers retry for a retryable error', () => {
    const onRetry = vi.fn()
    renderWaiting({ error: '网络暂时不可用，请重试', onRetry })

    expect(screen.getByRole('alert').textContent).toBe('网络暂时不可用，请重试')
    expect(screen.getByText('等待发送者确认')).not.toBeNull()
    expect(screen.getByText('123456')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  test('disables every action while a cancellation or room change is pending', () => {
    renderWaiting({ busy: true, error: '网络暂时不可用', onRetry: vi.fn() })

    for (const name of ['取消申请', '更换房间', '重试']) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(button.className).toContain('min-h-11')
    }
  })
})
