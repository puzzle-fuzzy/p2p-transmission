// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '../test/dom'
import type { PublicVisitor } from '../shared/contracts'
import IncomingFileRequestDialog, {
  type IncomingFileRequestItem,
} from './IncomingFileRequestDialog'

const sender: PublicVisitor = {
  id: 'sender',
  avatarSeed: 'sender-seed',
  displayName: '文件发送者',
  createdAt: 1,
  lastSeenAt: 1,
}

const files: IncomingFileRequestItem[] = [
  { fileId: 'file-1', name: '设计稿.png', byteLength: 1024 },
  { fileId: 'file-2', name: '说明.txt', byteLength: 2048 },
]

const callbacks = () => ({
  onAccept: vi.fn(),
  onReject: vi.fn(),
  onCancel: vi.fn(),
  onClose: vi.fn(),
})

describe('IncomingFileRequestDialog', () => {
  test('shows metadata and focuses Reject before consent', () => {
    const actions = callbacks()
    render(
      <IncomingFileRequestDialog
        sender={sender}
        files={files}
        state={{ status: 'pending' }}
        {...actions}
      />,
    )

    expect(screen.getByRole('heading', { name: '收到文件' })).not.toBeNull()
    expect(screen.getByText('设计稿.png').textContent).toBe('设计稿.png')
    expect(screen.getByText('说明.txt').textContent).toBe('说明.txt')
    expect(screen.getByText(/2 个文件 · 3.0 KB/)).not.toBeNull()
    const list = screen.getByRole('list', { name: '待接收文件' })
    expect(list.className).toContain('max-h-52')
    expect(list.className).toContain('sm:max-h-56')
    expect(list.className).toContain('overscroll-contain')
    const accept = screen.getByRole('button', { name: '接收全部' })
    expect(accept.parentElement?.className)
      .toContain('grid-cols-[minmax(0,1fr)_minmax(0,2fr)]')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '拒绝' }))
  })

  test('accepts once and disables both decision actions immediately', async () => {
    const user = userEvent.setup()
    const actions = callbacks()
    render(
      <IncomingFileRequestDialog
        sender={sender}
        files={files}
        state={{ status: 'pending' }}
        {...actions}
      />,
    )

    const accept = screen.getByRole('button', { name: '接收全部' }) as HTMLButtonElement
    const reject = screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement
    await user.click(accept)
    await user.click(accept)

    expect(actions.onAccept).toHaveBeenCalledTimes(1)
    expect(actions.onReject).not.toHaveBeenCalled()
    expect(accept.disabled).toBe(true)
    expect(reject.disabled).toBe(true)
  })

  test('Escape rejects exactly once while backdrop clicks do nothing', () => {
    const actions = callbacks()
    render(
      <IncomingFileRequestDialog
        sender={sender}
        files={files}
        state={{ status: 'pending' }}
        {...actions}
      />,
    )

    const dialog = screen.getByRole('dialog')
    fireEvent.click(dialog)
    expect(actions.onReject).not.toHaveBeenCalled()

    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(actions.onReject).toHaveBeenCalledTimes(1)
  })

  test('shows independent receiving progress with one exact-once Cancel action', () => {
    const actions = callbacks()
    render(
      <IncomingFileRequestDialog
        sender={sender}
        files={files}
        state={{
          status: 'receiving',
          progressByFileId: {
            'file-1': 0.25,
            'file-2': 0.756,
          },
        }}
        {...actions}
      />,
    )

    const first = screen.getByRole('progressbar', { name: '设计稿.png 传输进度' })
    const second = screen.getByRole('progressbar', { name: '说明.txt 传输进度' })
    expect(first.getAttribute('aria-valuenow')).toBe('25')
    expect(first.getAttribute('style')).toContain('25%')
    expect(second.getAttribute('aria-valuenow')).toBe('76')
    expect(second.getAttribute('style')).toContain('76%')
    expect(screen.queryByLabelText('接收进度')).toBeNull()
    expect(screen.queryByRole('button', { name: '接收全部' })).toBeNull()
    expect(screen.queryByRole('button', { name: '拒绝' })).toBeNull()

    const cancel = screen.getByRole('button', { name: '取消接收' })
    expect(cancel.className).toContain('w-full')
    expect(document.activeElement).toBe(cancel)
    fireEvent.click(cancel)
    fireEvent.click(cancel)
    expect(actions.onCancel).toHaveBeenCalledTimes(1)
  })

  test('Escape cancels receiving exactly once', () => {
    const actions = callbacks()
    render(
      <IncomingFileRequestDialog
        sender={sender}
        files={files}
        state={{
          status: 'receiving',
          progressByFileId: { 'file-1': 0.25, 'file-2': 0 },
        }}
        {...actions}
      />,
    )

    const dialog = screen.getByRole('dialog')
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    fireEvent(dialog, new Event('cancel', { cancelable: true }))

    expect(actions.onCancel).toHaveBeenCalledTimes(1)
    expect(actions.onReject).not.toHaveBeenCalled()
    expect(actions.onClose).not.toHaveBeenCalled()
  })

  test('renders completed shared rows with item and batch downloads', async () => {
    const user = userEvent.setup()
    const actions = callbacks()
    const clickDownload = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    render(
      <IncomingFileRequestDialog
        sender={sender}
        files={files}
        state={{
          status: 'received',
          files: [
            { ...files[0], url: 'blob:file-1' },
            { ...files[1], url: 'blob:file-2' },
          ],
        }}
        {...actions}
      />,
    )

    const list = screen.getByRole('list', { name: '已接收文件' })
    expect(list.className).toContain('max-h-52')
    expect(list.className).toContain('sm:max-h-56')
    expect(screen.getByTestId('file-transfer-row-file-1')).not.toBeNull()
    expect(screen.getByTestId('file-transfer-row-file-2')).not.toBeNull()
    expect(
      screen.getByRole('progressbar', { name: '设计稿.png 传输进度' })
        .getAttribute('aria-valuenow'),
    ).toBe('100')
    expect(
      screen.getByRole('progressbar', { name: '说明.txt 传输进度' })
        .getAttribute('aria-valuenow'),
    ).toBe('100')

    const firstDownload = screen.getByRole('link', { name: '下载 设计稿.png' })
    expect(firstDownload.className).toContain('size-11')
    expect(firstDownload.className).toContain('rounded-full')
    expect(firstDownload.getAttribute('href')).toBe('blob:file-1')
    expect(firstDownload.getAttribute('download')).toBe('设计稿.png')
    const secondDownload = screen.getByRole('link', { name: '下载 说明.txt' })
    expect(secondDownload.getAttribute('href')).toBe('blob:file-2')
    expect(secondDownload.getAttribute('download')).toBe('说明.txt')
    const downloadAll = screen.getByRole('button', { name: '一键下载' })
    expect(downloadAll.parentElement?.className)
      .toContain('grid-cols-[minmax(0,1fr)_minmax(0,2fr)]')
    expect(document.activeElement).toBe(downloadAll)
    expect(screen.getByRole('button', { name: '关闭' }).className)
      .toContain('border-amber-50/15')

    await user.click(downloadAll)
    expect(clickDownload).toHaveBeenCalledTimes(2)
    clickDownload.mockRestore()

    fireEvent(
      screen.getByRole('dialog'),
      new Event('cancel', { cancelable: true }),
    )
    expect(actions.onClose).toHaveBeenCalledTimes(1)
  })

  test('keeps an error recoverable with a Close action', () => {
    const actions = callbacks()
    render(
      <IncomingFileRequestDialog
        sender={sender}
        files={files}
        state={{ status: 'error', message: '连接已断开' }}
        {...actions}
      />,
    )

    expect(screen.getByText('连接已断开').textContent).toBe('连接已断开')
    expect(screen.getAllByText('传输失败')).toHaveLength(files.length)
    expect(screen.getByRole('list', { name: '待接收文件' }).className)
      .toContain('max-h-52')
    expect(screen.getByRole('button', { name: '关闭' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: '接收全部' })).toBeNull()
  })
})
