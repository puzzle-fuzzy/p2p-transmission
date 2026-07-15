// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import '../test/dom'
import FileTransferRow, {
  type FileTransferRowProps,
} from './FileTransferRow'

const baseProps: FileTransferRowProps = {
  fileId: 'file-1',
  name: '设计稿.png',
  byteLength: 2048,
  progress: 0.376,
  state: 'transferring',
}

describe('FileTransferRow', () => {
  test('renders stable metadata, fill styling, progress semantics, and an optional action', () => {
    const { rerender } = render(
      <FileTransferRow
        {...baseProps}
        action={<button type="button">移除</button>}
      />,
    )

    const row = screen.getByTestId('file-transfer-row-file-1')
    const progress = screen.getByRole('progressbar', {
      name: '设计稿.png 传输进度',
    })
    const content = screen.getByTestId('file-transfer-content-file-1')
    const actionSlot = screen.getByTestId('file-transfer-action-file-1')

    expect(row.className).toContain('bg-white/5')
    expect(row.className).toContain('file-transfer-row')
    expect(content.className).toContain('min-h-11')
    expect(content.className).toContain('pr-12')
    expect(actionSlot.className).toContain('absolute')
    expect(actionSlot.className).toContain('inset-y-0')
    expect(actionSlot.className).toContain('right-0')
    expect(actionSlot.className).toContain('rounded-r-lg')
    expect(progress.className).toContain('bg-accent/15')
    expect(progress.className).toContain('motion-safe:transition-[width]')
    expect(progress.className).toContain('motion-safe:duration-150')
    expect(progress.getAttribute('aria-valuemin')).toBe('0')
    expect(progress.getAttribute('aria-valuemax')).toBe('100')
    expect(progress.getAttribute('aria-valuenow')).toBe('38')
    expect(progress.getAttribute('aria-valuetext')).toBe('38%')
    expect(progress.getAttribute('style')).toContain('38%')
    expect(screen.getByText('38%').textContent).toBe('38%')
    expect(screen.getByText('2.0 KiB').textContent).toBe('2.0 KiB')
    expect(screen.getByText('设计稿.png').getAttribute('title')).toBe('设计稿.png')
    expect(screen.getByRole('button', { name: '移除' })).not.toBeNull()

    rerender(<FileTransferRow {...baseProps} state="queued" progress={0} />)
    expect(screen.getByText('等待传输')).not.toBeNull()
    expect(progress.getAttribute('aria-valuenow')).toBe('0')
    expect(progress.getAttribute('aria-valuetext')).toBe('等待传输')
    expect(screen.queryByRole('button', { name: '移除' })).toBeNull()
    expect(screen.queryByTestId('file-transfer-action-file-1')).toBeNull()
    expect(screen.getByTestId('file-transfer-content-file-1').className)
      .toContain('pr-3')
  })

  test('clamps and rounds progress while completed and error labels remain explicit', () => {
    const { rerender } = render(
      <FileTransferRow {...baseProps} progress={2} state="completed" />,
    )
    const progress = screen.getByRole('progressbar', {
      name: '设计稿.png 传输进度',
    })

    expect(progress.getAttribute('aria-valuenow')).toBe('100')
    expect(progress.getAttribute('aria-valuetext')).toBe('已完成')
    expect(progress.getAttribute('style')).toContain('100%')
    expect(screen.getByText('已完成')).not.toBeNull()

    rerender(<FileTransferRow {...baseProps} progress={-1} state="error" />)
    expect(progress.getAttribute('aria-valuenow')).toBe('0')
    expect(progress.getAttribute('aria-valuetext')).toBe('传输失败')
    expect(progress.getAttribute('style')).toContain('0%')
    expect(screen.getByText('传输失败')).not.toBeNull()

    rerender(<FileTransferRow {...baseProps} progress={Number.NaN} />)
    expect(progress.getAttribute('aria-valuenow')).toBe('0')
    expect(screen.getByText('0%')).not.toBeNull()
  })
})
