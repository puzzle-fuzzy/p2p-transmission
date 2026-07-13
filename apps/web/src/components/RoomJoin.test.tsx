// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '../test/dom'
import RoomJoin from './RoomJoin'

const roomCodeInputs = () => Array.from({ length: 6 }, (_, index) =>
  screen.getByRole('textbox', { name: `房间码第 ${String(index + 1)} 位` }) as HTMLInputElement)

describe('RoomJoin', () => {
  test('prefills a shared room code and waits for explicit confirmation', async () => {
    const user = userEvent.setup()
    const onJoinRoom = vi.fn()

    render(
      <RoomJoin
        initialCode="123456"
        onCreateRoom={vi.fn()}
        onJoinRoom={onJoinRoom}
      />,
    )

    expect(roomCodeInputs().map(input => input.value)).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(onJoinRoom).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '加入房间' }))

    expect(onJoinRoom).toHaveBeenCalledTimes(1)
    expect(onJoinRoom).toHaveBeenCalledWith('123456')
  })

  test('starts with six empty inputs without a shared room code', () => {
    render(<RoomJoin onCreateRoom={vi.fn()} onJoinRoom={vi.fn()} />)

    expect(roomCodeInputs().map(input => input.value)).toEqual(['', '', '', '', '', ''])
    expect(screen.getByRole('button', { name: '加入房间' }).hasAttribute('disabled')).toBe(true)
  })

  test('does not prefill an invalid initial code', () => {
    render(
      <RoomJoin
        initialCode="１２３４５６"
        onCreateRoom={vi.fn()}
        onJoinRoom={vi.fn()}
      />,
    )

    expect(roomCodeInputs().map(input => input.value)).toEqual(['', '', '', '', '', ''])
  })

  test('replaces a prefilled code completely when a shorter code is pasted', () => {
    render(
      <RoomJoin
        initialCode="123456"
        onCreateRoom={vi.fn()}
        onJoinRoom={vi.fn()}
      />,
    )
    const inputs = roomCodeInputs()

    fireEvent.paste(inputs[0]!, {
      clipboardData: { getData: () => '789' },
    })

    expect(inputs.map(input => input.value)).toEqual(['7', '8', '9', '', '', ''])
    expect(screen.getByRole('button', { name: '加入房间' }).hasAttribute('disabled')).toBe(true)
  })

  test('uses accurate, readable privacy copy', () => {
    render(<RoomJoin onCreateRoom={vi.fn()} onJoinRoom={vi.fn()} />)

    const privacy = screen.getByText(
      '文件和文本正文通过加密的 WebRTC 通道传输，优先尝试设备直连，必要时经加密中继转发；应用服务器只协调连接，不保存传输内容。接收完成的文件会暂存在当前页面中，关闭结果或退出房间后释放。',
    )
    expect(privacy.className).toContain('text-amber-50/60')
  })
})
