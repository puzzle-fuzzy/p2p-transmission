// @vitest-environment jsdom

import type { ComponentProps } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '../test/dom'
import type { PublicVisitor } from '../shared/contracts'
import type { FileSelection } from '../features/transfer/file-selection'
import type { OutgoingActivity } from '../features/transfer/ui-state'
import transferPanelSource from './TransferPanel.tsx?raw'
import TransferPanel from './TransferPanel'

const createVisitor = (id: string, displayName: string): PublicVisitor => ({
  id,
  avatarSeed: `seed-${id}`,
  displayName,
  createdAt: 1,
  lastSeenAt: 1,
})

const sender = createVisitor('sender', '发送者')
const receiverOne = createVisitor('receiver-1', '接收者一')
const receiverTwo = createVisitor('receiver-2', '接收者二')

type PanelProps = ComponentProps<typeof TransferPanel>

const createProps = (overrides: Partial<PanelProps> = {}): PanelProps => ({
  visitor: sender,
  receivers: [receiverOne, receiverTwo],
  files: [],
  selectionError: '',
  onFilesAdded: vi.fn(),
  onFileRemoved: vi.fn(),
  onSendText: vi.fn(async () => undefined),
  onSendFiles: vi.fn(async () => undefined),
  onCancel: vi.fn(),
  ...overrides,
})

const createSelection = (fileId: string, file: File): FileSelection => ({
  fileId,
  file,
})

const createActiveFileTransfer = (
  fileId: string,
  progress = 0.35,
): OutgoingActivity => ({
  generation: 1,
  transferId: 'transfer-1',
  kind: 'file',
  phase: 'transferring',
  peerIds: [receiverOne.id, receiverTwo.id],
  peers: {
    [receiverOne.id]: { accepted: true, progress },
    [receiverTwo.id]: { accepted: true, progress: 0.8 },
  },
  files: {
    [fileId]: {
      state: 'transferring',
      progress,
      peers: {
        [receiverOne.id]: { progress },
        [receiverTwo.id]: { progress: 0.8 },
      },
    },
  },
})

const createFailedFileTransfer = (
  fileId: string,
  progress = 0.42,
): OutgoingActivity => ({
  generation: 1,
  transferId: 'transfer-1',
  kind: 'file',
  phase: 'error',
  peerIds: [receiverOne.id],
  peers: {
    [receiverOne.id]: {
      accepted: true,
      progress,
      outcome: 'failed',
    },
  },
  files: {
    [fileId]: {
      state: 'error',
      progress,
      peers: {
        [receiverOne.id]: { progress, outcome: 'failed' },
      },
    },
  },
})

const createActiveTextTransfer = (): OutgoingActivity => ({
  generation: 1,
  transferId: 'transfer-text',
  kind: 'text',
  phase: 'transferring',
  peerIds: [receiverTwo.id],
  peers: {
    [receiverTwo.id]: { accepted: true, progress: 0.5 },
  },
  files: {},
})

describe('TransferPanel', () => {
  test('keeps the connected label and peer flow together while filtering active recipients', () => {
    const initialProps = createProps()
    const { rerender } = render(<TransferPanel {...initialProps} />)

    const label = screen.getByText('2 位接收者已连接')
    const status = screen.getByRole('status')
    expect(label.parentElement).toBe(status.parentElement)
    expect(label.parentElement?.className).toContain('flex-nowrap')
    expect(label.parentElement?.className).toContain('gap-2')
    expect(label.className).toContain('text-[11px]')
    expect(label.className).toContain('sm:text-xs')
    expect(status.getAttribute('data-phase')).toBe('idle')
    expect(status.getAttribute('data-active')).toBe('false')
    expect(screen.getByTitle(receiverOne.displayName)).not.toBeNull()
    expect(screen.getByTitle(receiverTwo.displayName)).not.toBeNull()
    expect(screen.queryByText(/房间\s+012345/)).toBeNull()

    rerender(
      <TransferPanel
        {...initialProps}
        activity={createActiveTextTransfer()}
      />,
    )

    expect(screen.getByText('2 位接收者已连接')).not.toBeNull()
    expect(status.getAttribute('data-phase')).toBe('transferring')
    expect(status.getAttribute('data-active')).toBe('true')
    expect(screen.queryByTitle(receiverOne.displayName)).toBeNull()
    expect(screen.getByTitle(receiverTwo.displayName)).not.toBeNull()
  })

  test('renders a sender-only idle flow when no receiver is ready', () => {
    render(<TransferPanel {...createProps({ receivers: [] })} />)

    const status = screen.getByRole('status')
    expect(screen.getByText('0 位接收者已连接')).not.toBeNull()
    expect(screen.getByTitle(sender.displayName)).not.toBeNull()
    expect(status.querySelector('.transfer-peer-flow__line')).toBeNull()
    expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(0)
  })

  test('implements wrapping arrow keys plus Home/End for tabs', async () => {
    const user = userEvent.setup()
    render(<TransferPanel {...createProps()} />)

    const textTab = screen.getByRole('tab', { name: '传输文本' })
    const fileTab = screen.getByRole('tab', { name: '传输文件' })
    expect(textTab.getAttribute('aria-selected')).toBe('true')

    textTab.focus()
    await user.keyboard('{ArrowRight}')
    expect(fileTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(fileTab)

    await user.keyboard('{ArrowRight}')
    expect(textTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(textTab)

    await user.keyboard('{End}')
    expect(fileTab.getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{Home}')
    expect(textTab.getAttribute('aria-selected')).toBe('true')
  })

  test('preserves the exact textarea value and sends it without trimming', async () => {
    const user = userEvent.setup()
    const onSendText = vi.fn(async () => undefined)
    render(<TransferPanel {...createProps({ onSendText })} />)

    const textarea = screen.getByRole('textbox', {
      name: '要传输的文本',
    }) as HTMLTextAreaElement
    const exact = '  第一行\n第二行 🙂  '
    fireEvent.change(textarea, { target: { value: exact } })

    expect(textarea.value).toBe(exact)
    expect(textarea.className.includes('focus-visible:border-accent')).toBe(true)
    expect(textarea.className).not.toMatch(/(?:ring|shadow)/)
    expect(screen.getByText(`${String(exact.length)}/500`).textContent)
      .toBe(`${String(exact.length)}/500`)

    await user.click(screen.getByRole('button', { name: '发送给 2 位接收者' }))
    expect(onSendText).toHaveBeenCalledTimes(1)
    expect(onSendText).toHaveBeenCalledWith(exact)
    await waitFor(() => expect(textarea.value).toBe(''))
  })

  test('opens the picker, appends input/drop files, removes by stable ID, and sends', async () => {
    const user = userEvent.setup()
    const existingFile = new File(['old'], 'existing.txt', { type: 'text/plain' })
    const pickedFile = new File(['picked'], 'picked.txt', { type: 'text/plain' })
    const droppedFile = new File(['dropped'], 'dropped.txt', { type: 'text/plain' })
    const selection = createSelection('file-existing', existingFile)
    const onFilesAdded = vi.fn()
    const onFileRemoved = vi.fn()
    const onSendFiles = vi.fn(async () => undefined)
    render(
      <TransferPanel
        {...createProps({
          files: [selection],
          onFilesAdded,
          onFileRemoved,
          onSendFiles,
        })}
      />,
    )

    await user.click(screen.getByRole('tab', { name: '传输文件' }))
    const dropZone = screen.getByRole('button', { name: '选择要传输的文件' })
    const fileScroll = screen.getByTestId('selected-file-scroll')
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const inputClick = vi.spyOn(input, 'click')

    await user.click(dropZone)
    expect(inputClick).toHaveBeenCalledTimes(1)
    expect(input.multiple).toBe(true)
    expect(fileScroll.className).toContain('native-scrollbar')
    expect(fileScroll.className).toContain('max-h-52')
    expect(fileScroll.className).toContain('sm:max-h-56')
    expect(fileScroll.className).toContain('overflow-y-auto')
    expect(fileScroll.className).toContain('overscroll-contain')
    expect(fileScroll.querySelector('[data-testid^="file-transfer-row-"]')).not.toBeNull()

    const addMore = Array.from(dropZone.querySelectorAll('button')).find(button =>
      button.querySelector('.material-symbols-outlined')?.textContent?.trim() === 'add')
    expect(addMore).toBeDefined()
    expect(fileScroll.contains(addMore as Node)).toBe(false)

    fireEvent.change(input, { target: { files: [pickedFile] } })
    expect(onFilesAdded).toHaveBeenLastCalledWith([pickedFile])

    fireEvent.drop(dropZone, { dataTransfer: { files: [droppedFile] } })
    expect(onFilesAdded).toHaveBeenLastCalledWith([droppedFile])

    inputClick.mockClear()
    await user.click(screen.getByRole('button', { name: '移除 existing.txt' }))
    expect(onFileRemoved).toHaveBeenCalledWith('file-existing')
    expect(inputClick).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '发送 1 个文件' }))
    expect(onSendFiles).toHaveBeenCalledTimes(1)
  })

  test('exposes controlled 10-file and 100-MiB validation errors', () => {
    const { rerender } = render(
      <TransferPanel
        {...createProps({ selectionError: '每批最多选择 10 个文件' })}
      />,
    )

    expect(screen.getByRole('alert').textContent).toContain('每批最多选择 10 个文件')

    rerender(
      <TransferPanel
        {...createProps({ selectionError: '文件总大小不能超过 100 MiB' })}
      />,
    )
    expect(screen.getByRole('alert').textContent)
      .toContain('文件总大小不能超过 100 MiB')
  })

  test('shows real slowest-peer file progress, locks editing, and exposes Cancel', async () => {
    const user = userEvent.setup()
    const file = new File(['content'], 'progress.bin')
    const selection = createSelection('file-progress', file)
    const onFilesAdded = vi.fn()
    const onCancel = vi.fn()
    const initialProps = createProps({
      files: [selection],
      onFilesAdded,
      onCancel,
    })
    const { rerender } = render(<TransferPanel {...initialProps} />)

    await user.click(screen.getByRole('tab', { name: '传输文件' }))
    const selectedRow = screen.getByTestId('file-transfer-row-file-progress')
    const selectedClassName = selectedRow.className
    expect(screen.getByRole('button', { name: '移除 progress.bin' })).not.toBeNull()

    rerender(
      <TransferPanel
        {...initialProps}
        activity={createActiveFileTransfer(selection.fileId)}
      />,
    )

    const transferringRow = screen.getByTestId('file-transfer-row-file-progress')
    expect(transferringRow.className).toBe(selectedClassName)
    expect(screen.queryByRole('button', { name: '移除 progress.bin' })).toBeNull()

    const progress = screen.getByRole('progressbar', {
      name: 'progress.bin 传输进度',
    })
    expect(progress.getAttribute('aria-valuenow')).toBe('35')
    expect(progress.getAttribute('style')).toContain('35%')
    expect(screen.getByText('35%').textContent).toBe('35%')
    expect((screen.getByRole('tab', { name: '传输文本' }) as HTMLButtonElement).disabled)
      .toBe(true)
    expect((document.querySelector('input[type="file"]') as HTMLInputElement).disabled)
      .toBe(true)
    expect(screen.queryByRole('button', { name: '移除 progress.bin' })).toBeNull()

    const dropZone = screen.getByRole('button', { name: '选择要传输的文件' })
    expect(dropZone.getAttribute('aria-disabled')).toBe('true')
    expect(dropZone.className).not.toContain('opacity-60')
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [new File(['late'], 'late.bin')] },
    })
    expect(onFilesAdded).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '取消传输' }))
    expect(onCancel).toHaveBeenCalledTimes(1)

    rerender(
      <TransferPanel
        {...initialProps}
        activity={createFailedFileTransfer(selection.fileId)}
      />,
    )
    expect(screen.getByText('传输失败').textContent).toBe('传输失败')
    const failedProgress = screen.getByRole('progressbar', {
      name: 'progress.bin 传输进度',
    })
    expect(failedProgress.getAttribute('aria-valuenow')).toBe('42')
    expect(failedProgress.getAttribute('style')).toContain('42%')
    expect((screen.getByRole('button', {
      name: '文件传输结束，但有接收方未完成',
    }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('uses border-only focus and contains no fake transfer machinery', async () => {
    const user = userEvent.setup()
    render(<TransferPanel {...createProps()} />)
    await user.click(screen.getByRole('tab', { name: '传输文件' }))

    const dropZone = screen.getByRole('button', { name: '选择要传输的文件' })
    expect(dropZone.className.includes('focus-visible:border-accent')).toBe(true)
    expect(dropZone.className).not.toMatch(/(?:ring|shadow)/)

    expect(transferPanelSource).not.toMatch(/Math\.random|setInterval|mockTransfer|fakeProgress/i)
    expect(transferPanelSource).not.toMatch(/(?:^|\s)(?:[\w-]*shadow|[\w-]*ring)(?:-|\[)/m)
  })
})
