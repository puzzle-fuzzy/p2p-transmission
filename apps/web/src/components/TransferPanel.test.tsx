// @vitest-environment jsdom

import type { ComponentProps } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
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
  onFilesAdded: vi.fn(() => true),
  onFileRemoved: vi.fn(),
  onSendFiles: vi.fn(async () => undefined),
  onCancel: vi.fn(),
  ...overrides,
})

const createSelection = (fileId: string, file: File): FileSelection => ({
  fileId,
  file,
})

const createTextClipboard = (text: string) => ({
  files: [],
  getData: (format: string) => format === 'text/plain' ? text : '',
}) as unknown as DataTransfer

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

describe('TransferPanel', () => {
  test('uses the unified flow and filters receivers to the active transfer', () => {
    const initialProps = createProps()
    const { rerender } = render(<TransferPanel {...initialProps} />)
    const status = screen.getByRole('status')

    expect(screen.queryByText('2 位接收者已连接')).toBeNull()
    expect(status.getAttribute('data-phase')).toBe('idle')
    expect(screen.getByTitle(sender.displayName)).not.toBeNull()
    expect(screen.getByTitle(receiverOne.displayName)).not.toBeNull()
    expect(screen.getByTitle(receiverTwo.displayName)).not.toBeNull()

    const activeActivity = createActiveFileTransfer('file-flow')
    activeActivity.peerIds = [receiverTwo.id]
    rerender(<TransferPanel {...initialProps} activity={activeActivity} />)

    expect(status.getAttribute('data-phase')).toBe('transferring')
    expect(status.querySelector('.transfer-peer-flow__dash')).not.toBeNull()
    expect(screen.queryByTitle(receiverOne.displayName)).toBeNull()
    expect(screen.getByTitle(receiverTwo.displayName)).not.toBeNull()
  })

  test('restores all current receivers after a transfer reaches a terminal phase', () => {
    const terminalActivity = createFailedFileTransfer('file-terminal')
    terminalActivity.peerIds = [receiverTwo.id]

    render(<TransferPanel {...createProps({ activity: terminalActivity })} />)

    const status = screen.getByRole('status')
    expect(status.getAttribute('data-phase')).toBe('error')
    expect(screen.getByTitle(receiverOne.displayName)).not.toBeNull()
    expect(screen.getByTitle(receiverTwo.displayName)).not.toBeNull()
  })

  test('shows the waiting flow when no receiver is ready', () => {
    render(<TransferPanel {...createProps({ receivers: [] })} />)
    const status = screen.getByRole('status')

    expect(status.getAttribute('data-phase')).toBe('connecting')
    expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(3)
    expect(status.querySelector('.transfer-peer-flow__placeholder')).not.toBeNull()
  })

  test('shows one upload surface and no text/file tabs', () => {
    render(<TransferPanel {...createProps()} />)

    expect(screen.getByRole('button', { name: '上传要传输的内容' })).not.toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('textbox', { name: '要传输的文本' })).toBeNull()
  })

  test('opens paste confirmation only from the upload surface', async () => {
    const user = userEvent.setup()
    render(<TransferPanel {...createProps()} />)
    const upload = screen.getByRole('button', { name: '上传要传输的内容' })
    const data = createTextClipboard('粘贴的内容')

    await user.click(upload)
    fireEvent.paste(upload, { clipboardData: data })

    expect(screen.getByRole('dialog', { name: '确认添加粘贴内容' })).not.toBeNull()
  })

  test('confirming pasted text adds one file item but does not send', async () => {
    const user = userEvent.setup()
    const onFilesAdded = vi.fn(() => true)
    const onSendFiles = vi.fn(async () => undefined)
    render(<TransferPanel {...createProps({ onFilesAdded, onSendFiles })} />)
    const upload = screen.getByRole('button', { name: '上传要传输的内容' })
    const data = createTextClipboard('要作为文本项目发送')

    fireEvent.paste(upload, { clipboardData: data })
    await user.click(screen.getByRole('button', { name: '添加到传输列表' }))

    expect(onFilesAdded).toHaveBeenCalledWith([
      expect.objectContaining({ name: '粘贴内容.txt', type: 'text/plain' }),
    ])
    expect(onSendFiles).not.toHaveBeenCalled()
  })

  test('keeps an empty recipient selection explicit and disables sending', async () => {
    const user = userEvent.setup()
    render(<TransferPanel {...createProps()} />)

    await user.click(screen.getByRole('button', { name: /选择接收者/u }))
    await user.click(screen.getByRole('button', { name: '清空选择' }))
    await user.click(screen.getByRole('button', { name: '确定' }))

    expect(screen.getByRole('alert').textContent).toContain('至少选择一位接收者')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect((screen.getByRole('button', { name: '选择文件' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: '选择接收者，已选择 2 位' })).not.toBeNull()
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

    const dropZone = screen.getByRole('button', { name: '上传要传输的内容' })
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

    const clearFiles = screen.getByRole('button', { name: '清空' })
    expect(clearFiles.className).toContain('shrink-0')
    await user.click(clearFiles)
    expect(onFileRemoved).toHaveBeenCalledWith('file-existing')

    fireEvent.change(input, { target: { files: [pickedFile] } })
    expect(onFilesAdded).toHaveBeenLastCalledWith([pickedFile])

    fireEvent.drop(dropZone, { dataTransfer: { files: [droppedFile] } })
    expect(onFilesAdded).toHaveBeenLastCalledWith([droppedFile])

    inputClick.mockClear()
    await user.click(screen.getByRole('button', { name: '移除 existing.txt' }))
    expect(onFileRemoved).toHaveBeenCalledWith('file-existing')
    expect(inputClick).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '发送 1 项' }))
    expect(onSendFiles).toHaveBeenCalledTimes(1)
  })

  test('explains that files cannot be sent before receivers connect', async () => {
    const user = userEvent.setup()
    const selection = createSelection(
      'file-waiting',
      new File(['waiting'], 'waiting.txt', { type: 'text/plain' }),
    )
    const onFileRemoved = vi.fn()
    const onSendFiles = vi.fn(async () => undefined)
    render(
      <TransferPanel
        {...createProps({
          receivers: [],
          files: [selection],
          onFileRemoved,
          onSendFiles,
        })}
      />,
    )

    const sendButton = screen.getByRole('button', { name: '暂无接收者连接' }) as HTMLButtonElement
    expect(sendButton.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '发送 1 项' })).toBeNull()

    await user.click(screen.getByRole('button', { name: '清空' }))
    expect(onFileRemoved).toHaveBeenCalledWith('file-waiting')
    expect(onSendFiles).not.toHaveBeenCalled()
  })

  test('clears every selected file exactly once', async () => {
    const user = userEvent.setup()
    const files = [
      createSelection('file-one', new File(['one'], 'one.txt')),
      createSelection('file-two', new File(['two'], 'two.txt')),
      createSelection('file-three', new File(['three'], 'three.txt')),
    ]
    const onFileRemoved = vi.fn()
    render(<TransferPanel {...createProps({ files, onFileRemoved })} />)

    await user.click(screen.getByRole('button', { name: '清空' }))

    expect(onFileRemoved.mock.calls).toEqual([
      ['file-one'],
      ['file-two'],
      ['file-three'],
    ])
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

  test('shows the 10-file and 100-MiB limits before files are selected', () => {
    render(<TransferPanel {...createProps()} />)

    expect(screen.getByText('一次最多 10 个文件，总计不超过 100 MiB')).toBeDefined()
  })

  test('shows real slowest-peer file progress, locks editing, and exposes Cancel', async () => {
    const user = userEvent.setup()
    const file = new File(['content'], 'progress.bin')
    const selection = createSelection('file-progress', file)
    const onFilesAdded = vi.fn()
    const onCancel = vi.fn()
    const onRetry = vi.fn(async () => undefined)
    const onDismissActivity = vi.fn()
    const initialProps = createProps({
      files: [selection],
      onFilesAdded,
      onCancel,
      onRetry,
      onDismissActivity,
    })
    const { rerender } = render(<TransferPanel {...initialProps} />)

    const selectedRow = screen.getByTestId('file-transfer-row-file-progress')
    const selectedClassName = selectedRow.className
    const removeButton = screen.getByRole('button', { name: '移除 progress.bin' })
    expect(removeButton.className).toContain('size-9')
    expect(removeButton.className).toContain('rounded-lg')
    expect(removeButton.className).not.toContain('rounded-full')

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
    expect((document.querySelector('input[type="file"]') as HTMLInputElement).disabled)
      .toBe(true)
    expect(screen.queryByRole('button', { name: '移除 progress.bin' })).toBeNull()

    const dropZone = screen.getByRole('button', { name: '上传要传输的内容' })
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
    expect(screen.getByRole('alert').textContent).toContain('传输未完成')
    expect((screen.getByRole('button', { name: '再次发送' }) as HTMLButtonElement).disabled).toBe(false)
    await user.click(screen.getByRole('button', { name: '再次发送' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '关闭结果' }))
    expect(onDismissActivity).toHaveBeenCalledTimes(1)
  })

  test('uses border-only focus and contains no fake transfer machinery', () => {
    render(<TransferPanel {...createProps()} />)
    const dropZone = screen.getByRole('button', { name: '上传要传输的内容' })
    expect(dropZone.className.includes('focus-visible:border-accent')).toBe(true)
    expect(dropZone.className).not.toMatch(/(?:ring|shadow)/)

    expect(transferPanelSource).not.toMatch(/Math\.random|setInterval|mockTransfer|fakeProgress/i)
    expect(transferPanelSource).not.toMatch(/(?:^|\s)(?:[\w-]*shadow|[\w-]*ring)(?:-|\[)/m)
  })
})
