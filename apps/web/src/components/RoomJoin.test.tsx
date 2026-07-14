// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '../test/dom'
import RoomJoin from './RoomJoin'

const roomCodeInputs = () => Array.from({ length: 6 }, (_, index) =>
  screen.getByRole('textbox', { name: `房间码第 ${String(index + 1)} 位` }) as HTMLInputElement)

const renderRoomJoin = (overrides: Partial<React.ComponentProps<typeof RoomJoin>> = {}) => {
  const props: React.ComponentProps<typeof RoomJoin> = {
    mode: 'manual',
    onCodeEdited: vi.fn(),
    onCreateRoom: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  }

  render(<RoomJoin {...props} />)
  return props
}

describe('RoomJoin', () => {
  test('shows visible room-code guidance for first-time users', () => {
    renderRoomJoin()

    expect(screen.getByRole('heading', { name: '加入房间' })).not.toBeNull()
    expect(screen.getByText('输入发送者提供的 6 位房间码，或直接打开邀请链接')).not.toBeNull()
  })

  test('uses a gently tall shape for room-code inputs', () => {
    renderRoomJoin()

    for (const input of roomCodeInputs()) {
      expect(input.className).toContain('aspect-[4/5]')
      expect(input.className).toContain('min-h-12')
    }
  })

  test('uses a high-contrast focus treatment for room-code inputs', () => {
    renderRoomJoin()

    const [input] = roomCodeInputs()
    expect(input?.className).toContain('focus:border-amber-50/90')
    expect(input?.className).toContain('focus:ring-2')
    expect(input?.className).toContain('focus:ring-amber-50/20')
  })

  test('prefills an invitation but waits for explicit confirmation', async () => {
    const user = userEvent.setup()
    const props = renderRoomJoin({ initialCode: '123456', mode: 'invite' })

    expect(roomCodeInputs().map(input => input.value)).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(screen.getByText('已读取邀请链接，确认后加入房间')).not.toBeNull()
    expect(props.onSubmit).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '加入房间' }))

    expect(props.onSubmit).toHaveBeenCalledTimes(1)
    expect(props.onSubmit).toHaveBeenCalledWith('123456')
  })

  test('labels a code-only join as an approval request', () => {
    renderRoomJoin({ initialCode: '123456', mode: 'manual' })

    expect(screen.queryByText('已读取邀请链接，确认后加入房间')).toBeNull()
    expect(screen.getByRole('button', { name: '请求加入' })).not.toBeNull()
  })

  test('reports typing, deleting, and pasting so invitation authority can be discarded', async () => {
    const user = userEvent.setup()
    const props = renderRoomJoin({ initialCode: '123456', mode: 'invite' })
    const inputs = roomCodeInputs()

    await user.clear(inputs[0]!)
    await user.type(inputs[0]!, '9')
    fireEvent.paste(inputs[0]!, {
      clipboardData: { getData: () => '789' },
    })

    expect(props.onCodeEdited).toHaveBeenCalledTimes(3)
    expect(inputs.map(input => input.value)).toEqual(['7', '8', '9', '', '', ''])
    expect(screen.getByRole('button', { name: '加入房间' }).hasAttribute('disabled')).toBe(true)
  })

  test('uses mode-specific busy copy and disables both actions', () => {
    const { unmount } = render(
      <RoomJoin
        busy
        initialCode="123456"
        mode="invite"
        onCodeEdited={vi.fn()}
        onCreateRoom={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    expect((screen.getByRole('button', { name: '连接中…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '创建房间' }) as HTMLButtonElement).disabled).toBe(true)

    unmount()
    renderRoomJoin({ busy: true, initialCode: '123456', mode: 'manual' })

    expect((screen.getByRole('button', { name: '申请中…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('renders an accessible error beside the room-code input', () => {
    renderRoomJoin({ error: '邀请链接无效或已过期', mode: 'invite' })

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('邀请链接无效或已过期')
    for (const input of roomCodeInputs()) {
      expect(input.getAttribute('aria-describedby')).toBe(alert.id)
      expect(input.getAttribute('aria-invalid')).toBe('true')
    }
  })

  test('starts empty and rejects invalid initial codes', () => {
    const { unmount } = render(
      <RoomJoin
        mode="manual"
        onCodeEdited={vi.fn()}
        onCreateRoom={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    expect(roomCodeInputs().map(input => input.value)).toEqual(['', '', '', '', '', ''])
    expect(screen.getByRole('button', { name: '请求加入' }).hasAttribute('disabled')).toBe(true)

    unmount()
    renderRoomJoin({ initialCode: '１２３４５６' })
    expect(roomCodeInputs().map(input => input.value)).toEqual(['', '', '', '', '', ''])
  })

  test('keeps the existing privacy copy readable', () => {
    renderRoomJoin()

    const privacy = screen.getByText(
      '文件和文本正文通过加密的 WebRTC 通道传输，优先尝试设备直连，必要时经加密中继转发；应用服务器只协调连接，不保存传输内容。接收完成的文件会暂存在当前页面中，关闭结果或退出房间后释放。',
    )
    expect(privacy.className).toContain('text-amber-50/60')
  })

  test('submits the complete room code when pressing Enter', async () => {
    const user = userEvent.setup()
    const props = renderRoomJoin()
    const inputs = roomCodeInputs()

    for (const [index, input] of inputs.entries()) {
      await user.type(input, String(index + 1))
    }
    await user.keyboard('{Enter}')

    expect(props.onSubmit).toHaveBeenCalledTimes(1)
    expect(props.onSubmit).toHaveBeenCalledWith('123456')
  })

  test('does not submit an incomplete room code when pressing Enter', async () => {
    const user = userEvent.setup()
    const props = renderRoomJoin()
    const inputs = roomCodeInputs()

    for (const [index, input] of inputs.slice(0, 5).entries()) {
      await user.type(input, String(index + 1))
    }
    await user.keyboard('{Enter}')

    expect(props.onSubmit).not.toHaveBeenCalled()
  })
})
