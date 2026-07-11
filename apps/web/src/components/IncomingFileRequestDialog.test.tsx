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

    const accept = screen.getByRole('button', { name: '接收' }) as HTMLButtonElement
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

  test('shows real receiving progress with disabled actions', () => {
    const actions = callbacks()
    render(
      <IncomingFileRequestDialog
        sender={sender}
        files={files}
        state={{ status: 'receiving', progress: 37.6 }}
        {...actions}
      />,
    )

    const progress = screen.getByRole('progressbar')
    expect(progress.getAttribute('aria-valuenow')).toBe('38')
    expect(screen.getByText('38%').textContent).toBe('38%')
    expect((screen.getByRole('button', { name: '接收' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('renders explicit Save links and closes completed results with Escape', () => {
    const actions = callbacks()
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

    const links = screen.getAllByRole('link', { name: '保存' }) as HTMLAnchorElement[]
    expect(links).toHaveLength(2)
    expect(links[0]?.getAttribute('href')).toBe('blob:file-1')
    expect(links[0]?.getAttribute('download')).toBe('设计稿.png')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭' }))

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
    expect(screen.getByRole('button', { name: '关闭' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: '接收' })).toBeNull()
  })
})
