// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '../test/dom'
import PasteConfirmDialog from './PasteConfirmDialog'

describe('PasteConfirmDialog', () => {
  test('confirms adding pasted text without sending it', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const text = `${'第一行\n'.repeat(50)}最后一行`

    render(
      <PasteConfirmDialog
        candidate={{ kind: 'text', text }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: '确认添加粘贴内容' }) as HTMLDialogElement
    const cancelButton = screen.getByRole('button', { name: '取消' })

    expect(dialog.dataset.testid).toBe('paste-confirm-dialog')
    expect(dialog.textContent).toContain('粘贴内容.txt')
    expect(dialog.textContent).toContain(`${text.length} 个字符`)
    expect(dialog.textContent).toContain(text.slice(0, 200))
    expect(dialog.textContent).not.toContain(text.slice(201))
    expect(document.activeElement).toBe(cancelButton)

    await user.click(screen.getByRole('button', { name: '添加到传输列表' }))

    expect(dialog.open).toBe(false)
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
  })

  test('cancelling pasted files does not confirm them', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const files = [
      new File(['data'], '报告.pdf', { type: 'application/pdf' }),
      new File(['image'], '截图.png', { type: 'image/png' }),
    ]

    render(
      <PasteConfirmDialog
        candidate={{ kind: 'files', files }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: '确认添加粘贴内容' }) as HTMLDialogElement

    expect(dialog.textContent).toContain('报告.pdf')
    expect(dialog.textContent).toContain('截图.png')
    expect(dialog.textContent).toContain('2 个文件')

    await user.click(screen.getByRole('button', { name: '取消' }))

    expect(dialog.open).toBe(false)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  test('renders nothing for an empty paste candidate', () => {
    const { container } = render(
      <PasteConfirmDialog
        candidate={undefined}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('paste-confirm-dialog')).toBeNull()
  })
})
