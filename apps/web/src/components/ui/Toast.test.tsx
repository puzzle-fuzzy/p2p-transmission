// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '../../test/dom'
import ToastViewport from './Toast'

describe('ToastViewport', () => {
  test('anchors alerts to the upper-right without a colored border', () => {
    render(
      <ToastViewport
        toast={{ id: 1, message: '连接服务器失败，请检查网络后重试', tone: 'error' }}
        onDismiss={vi.fn()}
      />,
    )

    const viewport = screen.getByRole('alert')
    const surface = viewport.firstElementChild

    expect(viewport.className).toContain('right-4')
    expect(viewport.className).toContain('top-4')
    expect(viewport.className).toContain('sm:right-6')
    expect(viewport.className).toContain('sm:top-6')
    expect(viewport.className).not.toContain('left-1/2')
    expect(viewport.className).toContain('w-[min(320px,calc(100vw-2rem))]')
    expect(surface).not.toBeNull()
    expect(surface?.className).not.toMatch(/\bborder(?:-|\b)/u)
    expect(surface?.className).toContain('min-h-10')
    expect(surface?.className).toContain('gap-2.5')
    expect(surface?.className).toContain('px-3')
    expect(surface?.className).toContain('py-2.5')

    const dismiss = screen.getByRole('button', { name: '关闭提示' })
    expect(dismiss.className).toContain('size-11')
  })
})
