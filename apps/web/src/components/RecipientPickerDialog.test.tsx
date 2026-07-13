// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '../test/dom'
import type { PublicVisitor } from '../shared/contracts'
import RecipientPickerDialog from './RecipientPickerDialog'

const receiverOne: PublicVisitor = {
  id: 'receiver-1',
  avatarSeed: 'seed-1',
  displayName: '接收者一',
  createdAt: 1,
  lastSeenAt: 1,
}

const receiverTwo: PublicVisitor = {
  id: 'receiver-2',
  avatarSeed: 'seed-2',
  displayName: '接收者二',
  createdAt: 1,
  lastSeenAt: 1,
}

describe('RecipientPickerDialog', () => {
  test('renders every receiver with checkbox semantics and selected state', () => {
    render(
      <RecipientPickerDialog
        receivers={[receiverOne, receiverTwo]}
        selectedIds={[receiverOne.id]}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog', { name: '选择接收者' })).not.toBeNull()
    const selectedCheckbox = screen.getByRole('checkbox', { name: receiverOne.displayName }) as HTMLInputElement
    const selectedRow = selectedCheckbox.closest('label')
    const unselectedCheckbox = screen.getByRole('checkbox', { name: receiverTwo.displayName }) as HTMLInputElement
    const unselectedRow = unselectedCheckbox.closest('label')

    expect(selectedRow?.getAttribute('data-selected')).toBe('true')
    expect(selectedRow?.className).toContain('bg-accent/15')
    expect(selectedRow?.className).toContain('border-accent/60')
    expect(selectedRow?.querySelector('[data-testid="recipient-check-indicator"]')).not.toBeNull()
    expect(unselectedRow?.getAttribute('data-selected')).toBe('false')
    expect(unselectedRow?.className).not.toContain('bg-accent/15')
    expect(selectedCheckbox.checked).toBe(true)
    expect(unselectedCheckbox.checked).toBe(false)
  })

  test('supports select all, clear all, empty-selection validation, and confirmation', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    render(
      <RecipientPickerDialog
        receivers={[receiverOne, receiverTwo]}
        selectedIds={[receiverOne.id, receiverTwo.id]}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: '清空选择' }))
    await user.click(screen.getByRole('button', { name: '确定' }))
    expect(screen.getByRole('alert').textContent).toContain('至少选择一位接收者')
    await user.click(screen.getByRole('checkbox', { name: receiverTwo.displayName }))
    await user.click(screen.getByRole('button', { name: '确定' }))
    expect(onConfirm).toHaveBeenCalledWith([receiverTwo.id])
  })

  test('Escape closes without changing the confirmed selection', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <RecipientPickerDialog
        receivers={[receiverOne]}
        selectedIds={[receiverOne.id]}
        onConfirm={vi.fn()}
        onClose={onClose}
      />,
    )

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
