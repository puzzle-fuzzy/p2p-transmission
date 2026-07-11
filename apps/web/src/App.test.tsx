// @vitest-environment jsdom

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import './test/dom'
import type { FileSelection } from './features/transfer/file-selection'
import type { PeerSessionEvent } from './features/transfer/peer-session'
import type { OutgoingActivity } from './features/transfer/ui-state'
import type { PublicRoom, PublicVisitor, VisitorSession } from './shared/contracts'
import App from './App'

const boundary = vi.hoisted(() => ({
  createRoom: vi.fn(),
  createVisitor: vi.fn(),
  joinRoom: vi.fn(),
  createRealtimeClient: vi.fn(),
  createPeerSession: vi.fn(),
  loadVisitorSession: vi.fn(),
  saveVisitorSession: vi.fn(),
  clearVisitorSession: vi.fn(),
  showToast: vi.fn(),
}))

vi.mock('./lib/api-client', () => ({
  ApiClientError: class ApiClientError extends Error {
    code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  createRoom: boundary.createRoom,
  createVisitor: boundary.createVisitor,
  joinRoom: boundary.joinRoom,
}))

vi.mock('./lib/realtime-client', () => ({
  createRealtimeClient: boundary.createRealtimeClient,
}))

vi.mock('./features/transfer/peer-session', () => ({
  createPeerSession: boundary.createPeerSession,
}))

vi.mock('./lib/visitor-session', () => ({
  loadVisitorSession: boundary.loadVisitorSession,
  saveVisitorSession: boundary.saveVisitorSession,
  clearVisitorSession: boundary.clearVisitorSession,
}))

vi.mock('./lib/config', () => ({
  getRtcConfiguration: () => ({}),
}))

vi.mock('./components/ui/useToast', () => ({
  useToast: () => ({
    toast: undefined,
    show: boundary.showToast,
    dismiss: vi.fn(),
  }),
}))

vi.mock('./components/ui/Toast', () => ({ default: () => null }))
vi.mock('./components/Loading', () => ({ default: () => <div>loading</div> }))

vi.mock('./components/RoomJoin', () => ({
  default: ({
    onCreateRoom,
    onJoinRoom,
  }: {
    onCreateRoom(): Promise<void>
    onJoinRoom(code: string): Promise<void>
  }) => (
    <div>
      <button type="button" onClick={() => { void onCreateRoom() }}>创建测试房间</button>
      <button type="button" onClick={() => { void onJoinRoom('012345') }}>加入测试房间</button>
    </div>
  ),
}))

type MockTransferPanelProps = {
  activity?: OutgoingActivity
  files: FileSelection[]
  onFilesAdded(files: readonly File[]): void
  onSendText(text: string): Promise<void>
  onSendFiles(): Promise<void>
  onCancel(): void
}

vi.mock('./components/TransferPanel', () => ({
  default: (props: MockTransferPanelProps) => {
    const firstFile = props.activity
      ? Object.values(props.activity.files)[0]
      : undefined
    return (
      <div data-testid="transfer-panel">
        <button
          type="button"
          disabled={Boolean(props.activity)}
          onClick={() => { void props.onSendText('精确文本\n🙂') }}
        >
          发送测试文本
        </button>
        <button
          type="button"
          disabled={Boolean(props.activity)}
          onClick={() => props.onFilesAdded([
            new File(['file body'], '设计稿.txt', { type: 'text/plain' }),
          ])}
        >
          添加测试文件
        </button>
        <button
          type="button"
          disabled={Boolean(props.activity) || props.files.length === 0}
          onClick={() => { void props.onSendFiles() }}
        >
          发送测试文件
        </button>
        <button type="button" onClick={props.onCancel}>取消测试传输</button>
        <output data-testid="activity-phase">{props.activity?.phase ?? 'idle'}</output>
        <output data-testid="file-progress">{firstFile?.progress ?? 0}</output>
      </div>
    )
  },
}))

vi.mock('./components/ReceiverPanel', () => ({
  default: ({ state }: { state: { status: string } }) => (
    <div data-testid="receiver-panel">{state.status}</div>
  ),
}))

vi.mock('./components/ReceivedTextDialog', () => ({
  default: ({
    text,
    copyStatus,
    onCopy,
    onClose,
  }: {
    text: string
    copyStatus: string
    onCopy(): void
    onClose(): void
  }) => (
    <div role="dialog" aria-label="收到文本">
      <div data-testid="received-text">{text}</div>
      <div data-testid="copy-status">{copyStatus}</div>
      <button type="button" onClick={onCopy}>复制收到文本</button>
      <button type="button" onClick={onClose}>关闭收到文本</button>
    </div>
  ),
}))

vi.mock('./components/IncomingFileRequestDialog', () => ({
  default: ({
    files,
    state,
    onAccept,
    onReject,
    onClose,
  }: {
    files: Array<{ name: string }>
    state: { status: string; files?: Array<{ name: string; url: string }> }
    onAccept(): void
    onReject(): void
    onClose(): void
  }) => (
    <div role="dialog" aria-label="收到文件">
      <div data-testid="file-dialog-status">{state.status}</div>
      {files.map(file => <span key={file.name}>{file.name}</span>)}
      {state.status === 'pending' && (
        <>
          <button type="button" onClick={onAccept}>接收测试文件</button>
          <button type="button" onClick={onReject}>拒绝测试文件</button>
        </>
      )}
      {(state.status === 'received' || state.status === 'error') && (
        <button type="button" onClick={onClose}>关闭文件弹窗</button>
      )}
    </div>
  ),
}))

vi.mock('./components/RoomCodeCopyButton', () => ({
  default: ({ code, onCopy }: { code: string; onCopy(code: string): Promise<void> }) => (
    <button type="button" onClick={() => { void onCopy(code) }}>复制测试房间码</button>
  ),
}))

type RealtimeMessageListener = (message: never) => void
type RealtimeStatusListener = (
  status: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'
) => void

class FakeRealtimeClient {
  readonly connect = vi.fn()
  readonly send = vi.fn()
  readonly close = vi.fn()
  private readonly messageListeners = new Set<RealtimeMessageListener>()
  private readonly statusListeners = new Set<RealtimeStatusListener>()

  readonly subscribe = vi.fn((listener: RealtimeMessageListener) => {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  })

  readonly subscribeStatus = vi.fn((listener: RealtimeStatusListener) => {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  })

  emitStatus(status: Parameters<RealtimeStatusListener>[0]) {
    for (const listener of this.statusListeners) listener(status)
  }
}

class FakePeerSession {
  readonly syncRoom = vi.fn()
  readonly handleSignal = vi.fn(async () => undefined)
  readonly readyPeerCount = vi.fn(() => 1)
  readonly close = vi.fn()
  readonly offerText = vi.fn((_text: string) => ({
    transferId: 'text-1',
    peerIds: ['receiver'],
    peerCount: 1,
    unsupportedPeerIds: [],
  }))
  readonly offerFiles = vi.fn((_files: readonly FileSelection[]) => ({
    transferId: 'files-1',
    peerIds: ['receiver'],
    peerCount: 1,
    unsupportedPeerIds: [],
  }))
  readonly acknowledgeText = vi.fn(() => true)
  readonly discardText = vi.fn(() => true)
  readonly acceptFiles = vi.fn(() => true)
  readonly rejectFiles = vi.fn(() => true)
  readonly cancelTransfer = vi.fn(() => true)
  private readonly listeners = new Set<(event: PeerSessionEvent) => void>()

  readonly subscribe = vi.fn((listener: (event: PeerSessionEvent) => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  })

  emit(event: PeerSessionEvent) {
    for (const listener of this.listeners) listener(event)
  }
}

const visitor = (
  id: string,
  displayName: string,
): PublicVisitor => ({
  id,
  displayName,
  avatarSeed: `seed-${id}`,
  createdAt: 1,
  lastSeenAt: 1,
})

const sender = visitor('sender', '发送者')
const receiver = visitor('receiver', '接收者')

const room: PublicRoom = {
  code: '012345',
  senderId: sender.id,
  receivers: [receiver.id],
  participants: [
    { visitor: sender, role: 'sender', joinedAt: 1, status: 'online' },
    { visitor: receiver, role: 'receiver', joinedAt: 1, status: 'online' },
  ],
  createdAt: 1,
  expiresAt: 2,
}

const sessionFor = (activeVisitor: PublicVisitor): VisitorSession => ({
  token: `token-${activeVisitor.id}`,
  visitor: activeVisitor,
})

let realtime: FakeRealtimeClient
let peerSession: FakePeerSession
let clipboardWrite: ReturnType<typeof vi.fn>
let createObjectUrl: ReturnType<typeof vi.fn>
let revokeObjectUrl: ReturnType<typeof vi.fn>
let nextFrameId: number
let frameCallbacks: Map<number, FrameRequestCallback>
let requestFrame: ReturnType<typeof vi.fn>
let cancelFrame: ReturnType<typeof vi.fn>
let unmountApp: () => void

const enterRoom = async (role: 'sender' | 'receiver') => {
  const user = userEvent.setup()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  })
  boundary.loadVisitorSession.mockReturnValue(sessionFor(
    role === 'sender' ? sender : receiver,
  ))
  const rendered = render(<App />)
  unmountApp = rendered.unmount

  await user.click(await screen.findByRole('button', {
    name: role === 'sender' ? '创建测试房间' : '加入测试房间',
  }))
  await waitFor(() => expect(boundary.createRealtimeClient).toHaveBeenCalledTimes(1))
  act(() => realtime.emitStatus('open'))
  act(() => peerSession.emit({
    type: 'peer:state',
    peerId: role === 'sender' ? receiver.id : sender.id,
    state: 'ready',
  }))
  return user
}

const emit = (event: PeerSessionEvent) => {
  act(() => peerSession.emit(event))
}

beforeEach(() => {
  realtime = new FakeRealtimeClient()
  peerSession = new FakePeerSession()
  boundary.createRealtimeClient.mockReturnValue(realtime)
  boundary.createPeerSession.mockReturnValue(peerSession)
  boundary.createRoom.mockResolvedValue(room)
  boundary.joinRoom.mockResolvedValue(room)
  boundary.createVisitor.mockResolvedValue(sessionFor(sender))
  boundary.loadVisitorSession.mockReturnValue(sessionFor(sender))

  clipboardWrite = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  })

  let nextUrl = 0
  createObjectUrl = vi.fn(() => `blob:test-${String(++nextUrl)}`)
  revokeObjectUrl = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectUrl,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeObjectUrl,
  })

  nextFrameId = 0
  frameCallbacks = new Map()
  requestFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextFrameId
    frameCallbacks.set(id, callback)
    return id
  })
  cancelFrame = vi.fn((frame: number) => {
    frameCallbacks.delete(frame)
  })
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: requestFrame,
  })
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: cancelFrame,
  })
})

describe('App transfer integration', () => {
  test('commits five exact text bodies before one ACK each and discards overflow once', async () => {
    const user = await enterRoom('receiver')

    for (let index = 1; index <= 6; index += 1) {
      emit({
        type: 'transfer:text-received',
        peerId: sender.id,
        transferId: `text-${String(index)}`,
        text: `第 ${String(index)} 条\n🙂`,
      })
    }

    expect(peerSession.acknowledgeText).toHaveBeenCalledTimes(5)
    expect(peerSession.discardText).toHaveBeenCalledTimes(1)
    expect(peerSession.discardText).toHaveBeenCalledWith(sender.id, 'text-6')
    expect(screen.getByTestId('received-text').textContent).toBe('第 1 条\n🙂')

    await user.click(screen.getByRole('button', { name: '关闭收到文本' }))
    expect(screen.getByTestId('received-text').textContent).toBe('第 2 条\n🙂')
  })

  test('copies the exact received body and preserves the dialog on failure', async () => {
    const user = await enterRoom('receiver')
    emit({
      type: 'transfer:text-received',
      peerId: sender.id,
      transferId: 'text-copy',
      text: '保留空格  \n与换行',
    })
    clipboardWrite.mockRejectedValueOnce(new Error('denied'))

    await user.click(screen.getByRole('button', { name: '复制收到文本' }))
    await waitFor(() => expect(screen.getByTestId('copy-status').textContent).toBe('error'))

    expect(clipboardWrite).toHaveBeenCalledWith('保留空格  \n与换行')
    expect(screen.getByTestId('received-text').textContent).toBe('保留空格  \n与换行')
    expect(boundary.showToast).toHaveBeenCalledWith('无法复制文本，请手动复制')
  })

  test('accepts or rejects only file requests and creates/revokes each result URL once', async () => {
    const user = await enterRoom('receiver')
    emit({
      type: 'transfer:file-requested',
      peerId: sender.id,
      transferId: 'files-reject',
      files: [{
        fileId: 'file-reject',
        streamId: 1,
        name: '拒绝.txt',
        mimeType: 'text/plain',
        byteLength: 1,
        lastModified: 1,
        chunkSize: 1024,
        chunkCount: 1,
      }],
    })
    await user.click(screen.getByRole('button', { name: '拒绝测试文件' }))
    expect(peerSession.rejectFiles).toHaveBeenCalledWith(sender.id, 'files-reject')

    emit({
      type: 'transfer:file-requested',
      peerId: sender.id,
      transferId: 'files-receive',
      files: [{
        fileId: 'file-1',
        streamId: 2,
        name: '接收.txt',
        mimeType: 'text/plain',
        byteLength: 4,
        lastModified: 1,
        chunkSize: 1024,
        chunkCount: 1,
      }],
    })
    await user.click(screen.getByRole('button', { name: '接收测试文件' }))
    expect(peerSession.acceptFiles).toHaveBeenCalledWith(sender.id, 'files-receive')

    const received: PeerSessionEvent = {
      type: 'transfer:files-received',
      peerId: sender.id,
      transferId: 'files-receive',
      files: [{
        fileId: 'file-1',
        name: '接收.txt',
        mimeType: 'text/plain',
        byteLength: 4,
        lastModified: 1,
        blob: new Blob(['body']),
      }],
    }
    emit(received)
    emit(received)

    expect(createObjectUrl).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '关闭文件弹窗' }))
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1)
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test-1')
  })

  test('revokes received URLs once when realtime resets and does not revoke again on unmount', async () => {
    await enterRoom('receiver')
    emit({
      type: 'transfer:file-requested',
      peerId: sender.id,
      transferId: 'files-reset',
      files: [{
        fileId: 'file-1',
        streamId: 3,
        name: '重置.txt',
        mimeType: 'text/plain',
        byteLength: 1,
        lastModified: 1,
        chunkSize: 1024,
        chunkCount: 1,
      }],
    })
    emit({
      type: 'transfer:files-received',
      peerId: sender.id,
      transferId: 'files-reset',
      files: [{
        fileId: 'file-1',
        name: '重置.txt',
        mimeType: 'text/plain',
        byteLength: 1,
        lastModified: 1,
        blob: new Blob(['x']),
      }],
    })

    act(() => realtime.emitStatus('reconnecting'))
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1)

    act(() => unmountApp())
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1)
  })

  test('revokes an available file URL on direct unmount', async () => {
    await enterRoom('receiver')
    emit({
      type: 'transfer:file-requested',
      peerId: sender.id,
      transferId: 'files-unmount',
      files: [{
        fileId: 'file-unmount',
        streamId: 4,
        name: '卸载.txt',
        mimeType: 'text/plain',
        byteLength: 1,
        lastModified: 1,
        chunkSize: 1024,
        chunkCount: 1,
      }],
    })
    emit({
      type: 'transfer:files-received',
      peerId: sender.id,
      transferId: 'files-unmount',
      files: [{
        fileId: 'file-unmount',
        name: '卸载.txt',
        mimeType: 'text/plain',
        byteLength: 1,
        lastModified: 1,
        blob: new Blob(['x']),
      }],
    })

    act(() => unmountApp())

    expect(createObjectUrl).toHaveBeenCalledTimes(1)
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1)
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test-1')
  })

  test('coalesces progress per animation frame and cancels a pending frame on cleanup', async () => {
    const user = await enterRoom('sender')
    await user.click(screen.getByRole('button', { name: '添加测试文件' }))
    await user.click(screen.getByRole('button', { name: '发送测试文件' }))
    const fileId = peerSession.offerFiles.mock.calls[0]?.[0][0]?.fileId
    expect(fileId).toBeTruthy()
    emit({
      type: 'transfer:file-decision',
      peerId: receiver.id,
      transferId: 'files-1',
      decision: 'accept',
    })

    for (const bytes of [10, 40, 70]) {
      emit({
        type: 'transfer:file-progress',
        peerId: receiver.id,
        transferId: 'files-1',
        fileId: fileId!,
        direction: 'sending',
        fileBytes: bytes,
        fileTotalBytes: 100,
        batchBytes: bytes,
        batchTotalBytes: 100,
      })
    }
    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('file-progress').textContent).toBe('0')

    act(() => {
      const callback = frameCallbacks.get(1)
      frameCallbacks.delete(1)
      callback?.(0)
    })
    expect(screen.getByTestId('file-progress').textContent).toBe('0.7')

    emit({
      type: 'transfer:file-progress',
      peerId: receiver.id,
      transferId: 'files-1',
      fileId: fileId!,
      direction: 'sending',
      fileBytes: 80,
      fileTotalBytes: 100,
      batchBytes: 80,
      batchTotalBytes: 100,
    })
    act(() => realtime.emitStatus('reconnecting'))
    expect(cancelFrame).toHaveBeenCalledTimes(1)
  })

  test('a stale terminal callback cannot clear a newer generation', async () => {
    const terminalCallbacks: Array<() => void> = []
    const nativeSetTimeout = globalThis.setTimeout
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay, ...args) => {
      if (delay === 400 && typeof handler === 'function') {
        terminalCallbacks.push(() => handler(...args))
        return terminalCallbacks.length as unknown as ReturnType<typeof setTimeout>
      }
      return nativeSetTimeout(handler, delay, ...args)
    })
    const user = await enterRoom('sender')

    await user.click(screen.getByRole('button', { name: '发送测试文本' }))
    emit({
      type: 'transfer:terminal',
      peerId: receiver.id,
      transferId: 'text-1',
      outcome: 'completed',
    })
    expect(screen.getByTestId('activity-phase').textContent).toBe('complete')
    expect(terminalCallbacks).toHaveLength(1)

    act(() => terminalCallbacks[0]?.())
    expect(screen.getByTestId('activity-phase').textContent).toBe('idle')
    peerSession.offerText.mockReturnValueOnce({
      transferId: 'text-2',
      peerIds: [receiver.id],
      peerCount: 1,
      unsupportedPeerIds: [],
    })
    await user.click(screen.getByRole('button', { name: '发送测试文本' }))
    expect(screen.getByTestId('activity-phase').textContent).toBe('transferring')

    act(() => terminalCallbacks[0]?.())
    expect(screen.getByTestId('activity-phase').textContent).toBe('transferring')
    emit({
      type: 'transfer:terminal',
      peerId: receiver.id,
      transferId: 'text-2',
      outcome: 'completed',
    })
    act(() => terminalCallbacks[1]?.())
    expect(screen.getByTestId('activity-phase').textContent).toBe('idle')
    timerSpy.mockRestore()
  })

  test('wires room copy plus sender text, file, and cancel intents', async () => {
    const user = await enterRoom('sender')
    await user.click(screen.getByRole('button', { name: '复制测试房间码' }))
    expect(clipboardWrite).toHaveBeenCalledWith('012345')
    expect(boundary.showToast).toHaveBeenCalledWith('房间码已复制', 'success')

    await user.click(screen.getByRole('button', { name: '发送测试文本' }))
    expect(peerSession.offerText).toHaveBeenCalledWith('精确文本\n🙂')
    await user.click(screen.getByRole('button', { name: '取消测试传输' }))
    expect(peerSession.cancelTransfer).toHaveBeenCalledWith('text-1')
  })
})
