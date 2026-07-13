// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '../test/dom'
import ShareDialog from './ShareDialog'

const qrCode = vi.hoisted(() => ({
  toCanvas: vi.fn(async () => undefined),
}))

vi.mock('qrcode', () => ({ default: qrCode }))

const setNativeShare = (share?: (data?: ShareData) => Promise<void>) => {
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: share,
  })
}

const deferredAction = () => {
  let resolve: () => void = () => undefined
  let reject: (reason?: unknown) => void = () => undefined
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = () => resolvePromise()
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

describe('ShareDialog', () => {
  beforeEach(() => setNativeShare(undefined))

  test('uses one opaque invitation URL without rendering its capability', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn(async () => undefined)
    const inviteToken = `inv_${'a'.repeat(43)}`
    const roomUrl = `https://example.com/transfer#room=123456&invite=${inviteToken}`
    render(
      <ShareDialog
        roomCode="123456"
        roomUrl={roomUrl}
        onCopy={onCopy}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('扫描二维码或打开房间链接加入；房间码仅用于核对。')).not.toBeNull()
    expect(screen.getByText('此链接包含加入权限，请只发送给可信接收者。')).not.toBeNull()
    expect(document.body.textContent).not.toContain(inviteToken)
    expect(document.body.textContent).not.toContain(roomUrl)
    await waitFor(() => expect(qrCode.toCanvas).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      roomUrl,
      expect.any(Object),
    ))

    await user.click(screen.getByRole('button', { name: '复制房间链接' }))

    expect(onCopy).toHaveBeenCalledWith(roomUrl)
  })

  test('reports a room-code copy only after it succeeds', async () => {
    const user = userEvent.setup()
    const pendingCopy = deferredAction()
    const onCopy = vi.fn(() => pendingCopy.promise)
    render(
      <ShareDialog
        roomCode="123456"
        roomUrl="https://example.com/?room=123456"
        onCopy={onCopy}
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: '复制房间码' }))

    expect(onCopy).toHaveBeenCalledWith('123456')
    const pendingButton = screen.getByRole('button', { name: '正在复制房间码' }) as HTMLButtonElement
    expect(pendingButton.disabled).toBe(true)
    expect(pendingButton.className).toContain('size-11')
    expect(pendingButton.className).toContain('rounded-full')
    await user.click(pendingButton)
    expect(onCopy).toHaveBeenCalledTimes(1)

    pendingCopy.resolve()

    await waitFor(() => expect(screen.getByRole('button', { name: '房间码已复制' })).not.toBeNull())
    expect(screen.getByRole('button', { name: '复制房间链接' })).not.toBeNull()
  })

  test('does not report success when copying the room code fails', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn(() => Promise.reject(new Error('clipboard denied')))
    render(
      <ShareDialog
        roomCode="123456"
        roomUrl="https://example.com/?room=123456"
        onCopy={onCopy}
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: '复制房间码' }))

    await waitFor(() => expect(screen.getByRole('button', { name: '复制房间码' })).not.toBeNull())
    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '房间码已复制' })).toBeNull()
  })

  test('awaits the complete room URL when native sharing is unavailable', async () => {
    const user = userEvent.setup()
    const pendingCopy = deferredAction()
    const onCopy = vi.fn(() => pendingCopy.promise)
    const roomUrl = 'https://example.com/?room=123456'
    render(
      <ShareDialog
        roomCode="123456"
        roomUrl={roomUrl}
        onCopy={onCopy}
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: '复制房间链接' }))

    expect(onCopy).toHaveBeenCalledWith(roomUrl)
    expect(screen.getByRole('button', { name: '复制房间码' })).not.toBeNull()
    const pendingButton = screen.getByRole('button', { name: '复制中…' }) as HTMLButtonElement
    expect(pendingButton.disabled).toBe(true)
    await user.click(pendingButton)
    expect(onCopy).toHaveBeenCalledTimes(1)

    pendingCopy.resolve()

    await waitFor(() => expect(screen.getByRole('button', { name: '链接已复制' })).not.toBeNull())
    expect(screen.getByRole('button', { name: '复制房间码' })).not.toBeNull()
  })

  test('restores the link action when copying the room URL fails', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn(() => Promise.reject(new Error('clipboard denied')))
    render(
      <ShareDialog
        roomCode="123456"
        roomUrl="https://example.com/?room=123456"
        onCopy={onCopy}
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: '复制房间链接' }))

    await waitFor(() => expect(screen.getByRole('button', { name: '复制房间链接' })).not.toBeNull())
    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '链接已复制' })).toBeNull()
    expect(screen.getByRole('button', { name: '复制房间码' })).not.toBeNull()
  })

  test('uses native sharing without copying when sharing succeeds', async () => {
    const user = userEvent.setup()
    const pendingShare = deferredAction()
    const nativeShare = vi.fn(() => pendingShare.promise)
    const onCopy = vi.fn(async () => undefined)
    setNativeShare(nativeShare)
    render(
      <ShareDialog
        roomCode="123456"
        roomUrl="https://example.com/?room=123456"
        onCopy={onCopy}
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: '分享房间链接' }))

    expect(nativeShare).toHaveBeenCalledWith({
      title: 'P2P Transmission 房间',
      text: '加入我的 P2P 传输房间：123456',
      url: 'https://example.com/?room=123456',
    })
    const pendingButton = screen.getByRole('button', { name: '分享中…' }) as HTMLButtonElement
    expect(pendingButton.disabled).toBe(true)
    await user.click(pendingButton)
    expect(nativeShare).toHaveBeenCalledTimes(1)
    expect(onCopy).not.toHaveBeenCalled()

    pendingShare.resolve()

    await waitFor(() => expect(screen.getByRole('button', { name: '已分享' })).not.toBeNull())
    expect(screen.getByRole('button', { name: '复制房间码' })).not.toBeNull()
  })

  test('does not copy after the user cancels native sharing', async () => {
    const user = userEvent.setup()
    const nativeShare = vi.fn(() => Promise.reject(new DOMException('cancelled', 'AbortError')))
    const onCopy = vi.fn(async () => undefined)
    setNativeShare(nativeShare)
    render(
      <ShareDialog
        roomCode="123456"
        roomUrl="https://example.com/?room=123456"
        onCopy={onCopy}
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: '分享房间链接' }))

    await waitFor(() => expect(screen.getByRole('button', { name: '分享房间链接' })).not.toBeNull())
    expect(nativeShare).toHaveBeenCalledTimes(1)
    expect(onCopy).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '复制房间码' })).not.toBeNull()
  })

  test('falls back to copying the room URL after a non-cancellation share failure', async () => {
    const user = userEvent.setup()
    const nativeShare = vi.fn(() => Promise.reject(new Error('share unavailable')))
    const pendingCopy = deferredAction()
    const onCopy = vi.fn(() => pendingCopy.promise)
    const roomUrl = 'https://example.com/?room=123456'
    setNativeShare(nativeShare)
    render(
      <ShareDialog
        roomCode="123456"
        roomUrl={roomUrl}
        onCopy={onCopy}
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: '分享房间链接' }))

    await waitFor(() => expect(onCopy).toHaveBeenCalledWith(roomUrl))
    const pendingButton = screen.getByRole('button', { name: '复制中…' }) as HTMLButtonElement
    expect(pendingButton.disabled).toBe(true)
    await user.click(pendingButton)
    expect(nativeShare).toHaveBeenCalledTimes(1)
    expect(onCopy).toHaveBeenCalledTimes(1)

    pendingCopy.resolve()

    await waitFor(() => expect(screen.getByRole('button', { name: '链接已复制' })).not.toBeNull())
    expect(screen.getByRole('button', { name: '复制房间码' })).not.toBeNull()
  })
})
