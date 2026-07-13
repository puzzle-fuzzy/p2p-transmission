// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '../test/dom'
import AboutDialog from './AboutDialog'

describe('AboutDialog', () => {
  test('renders the product explanation, limits, build information, and no sensitive tokens', () => {
    const visitorToken = 'visitor_secret_token'
    const inviteToken = 'inv_secret_token'
    render(<AboutDialog version="1.0.50" onClose={vi.fn()} />)

    expect(screen.getByRole('heading', { name: '关于 P2P Transmission' })).not.toBeNull()
    expect(screen.getByText('不注册，不上传，直接把内容传给对方。')).not.toBeNull()
    expect(screen.getByText('它是怎么工作的')).not.toBeNull()
    expect(screen.getByText('隐私与安全')).not.toBeNull()
    expect(screen.getByText('使用前知道')).not.toBeNull()
    expect(screen.getByText('构建信息')).not.toBeNull()
    expect(screen.getByText('https://p2p.yxswy.com')).not.toBeNull()
    expect(screen.getByText('1.0.50')).not.toBeNull()
    expect(screen.getByText(/30 分钟/)).not.toBeNull()
    expect(screen.getByText(/10 个文件/)).not.toBeNull()
    expect(screen.getByText(/DataChannel/)).not.toBeNull()
    expect(screen.getByText(/API 只负责/)).not.toBeNull()
    expect(screen.getAllByText(/TURN 中继/).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain(visitorToken)
    expect(document.body.textContent).not.toContain(inviteToken)
  })

  test('opens with the title association and focuses the close button', () => {
    render(<AboutDialog version="开发构建" onClose={vi.fn()} />)

    const dialog = screen.getByRole('dialog') as HTMLDialogElement
    const title = screen.getByRole('heading', { name: '关于 P2P Transmission' })
    const closeButton = screen.getByRole('button', { name: '关闭' })

    expect(dialog.open).toBe(true)
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id)
    expect(dialog.showModal).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(closeButton)
  })

  test('closes from the explicit button and reports the close once', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<AboutDialog version="开发构建" onClose={onClose} />)

    const dialog = screen.getByRole('dialog') as HTMLDialogElement
    await user.click(screen.getByRole('button', { name: '关闭' }))

    expect(dialog.open).toBe(false)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('handles the cancel event as Escape and reports the close once', () => {
    const onClose = vi.fn()
    render(<AboutDialog version="开发构建" onClose={onClose} />)

    const dialog = screen.getByRole('dialog') as HTMLDialogElement
    const cancelEvent = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(cancelEvent)

    expect(cancelEvent.defaultPrevented).toBe(true)
    expect(dialog.open).toBe(false)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
