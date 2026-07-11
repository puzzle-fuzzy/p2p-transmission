import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
  configurable: true,
  value: vi.fn(function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }),
})

Object.defineProperty(HTMLDialogElement.prototype, 'close', {
  configurable: true,
  value: vi.fn(function close(this: HTMLDialogElement) {
    this.removeAttribute('open')
  }),
})
