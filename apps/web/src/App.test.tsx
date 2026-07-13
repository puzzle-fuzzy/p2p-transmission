// @vitest-environment jsdom

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import './test/dom'
import type { RoomNavigationSnapshot } from './features/room/room-navigation'
import type { FileSelection } from './features/transfer/file-selection'
import type { PeerSessionEvent } from './features/transfer/peer-session'
import type { OutgoingActivity } from './features/transfer/ui-state'
import type {
  PublicRoom,
  PublicVisitor,
  RoomJoinRequestSummary,
  ServerRealtimeMessage,
  VisitorSession,
} from './shared/contracts'
import { ApiClientError } from './lib/api-client'
import App from './App'

const boundary = vi.hoisted(() => ({
  createRoom: vi.fn(),
  createVisitor: vi.fn(),
  joinRoom: vi.fn(),
  createRoomJoinRequest: vi.fn(),
  getRoomJoinRequest: vi.fn(),
  decideRoomJoinRequest: vi.fn(),
  finalizeRoomJoinRequest: vi.fn(),
  cancelRoomJoinRequest: vi.fn(),
  createRealtimeClient: vi.fn(),
  createPeerSession: vi.fn(),
  loadVisitorSession: vi.fn(),
  saveVisitorSession: vi.fn(),
  clearVisitorSession: vi.fn(),
  loadRoomSession: vi.fn(),
  saveRoomSession: vi.fn(),
  clearRoomSession: vi.fn(),
  setupNotificationPermissionPrompt: vi.fn(),
  cleanupNotificationPermissionPrompt: vi.fn(),
  renderShareDialog: vi.fn(),
  showToast: vi.fn(),
}))

vi.mock('./lib/api-client', () => ({
  ApiClientError: class ApiClientError extends Error {
    code: string
    status: number

    constructor(message: string, code: string, status: number) {
      super(message)
      this.code = code
      this.status = status
    }
  },
  createRoom: boundary.createRoom,
  createVisitor: boundary.createVisitor,
  joinRoom: boundary.joinRoom,
  createRoomJoinRequest: boundary.createRoomJoinRequest,
  getRoomJoinRequest: boundary.getRoomJoinRequest,
  decideRoomJoinRequest: boundary.decideRoomJoinRequest,
  finalizeRoomJoinRequest: boundary.finalizeRoomJoinRequest,
  cancelRoomJoinRequest: boundary.cancelRoomJoinRequest,
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

vi.mock('./lib/room-session', () => ({
  loadRoomSession: boundary.loadRoomSession,
  saveRoomSession: boundary.saveRoomSession,
  clearRoomSession: boundary.clearRoomSession,
}))

vi.mock('./lib/config', () => ({
  getClientIceMode: () => ({ mode: 'off', configuration: {} }),
  resolveBootstrapRtcConfiguration: () => ({}),
  roomIceMode: () => 'off',
}))

vi.mock('./lib/notifications', () => ({
  setupNotificationPermissionPrompt: boundary.setupNotificationPermissionPrompt,
  sendNotification: vi.fn(),
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
    initialCode,
    mode,
    error,
    onCreateRoom,
    onSubmit,
    onCodeEdited,
  }: {
    initialCode?: string
    mode: 'invite' | 'manual'
    error?: string
    onCreateRoom(): Promise<void>
    onSubmit(code: string): Promise<void>
    onCodeEdited(): void
  }) => (
    <div>
      <button type="button" onClick={() => { void onCreateRoom() }}>创建测试房间</button>
      <button type="button" onClick={() => { void onSubmit(initialCode || '012345') }}>
        {mode === 'invite' ? '加入测试房间' : '请求加入测试房间'}
      </button>
      <button type="button" onClick={() => { void onSubmit('654321') }}>
        请求加入其他测试房间
      </button>
      <button type="button" onClick={onCodeEdited}>编辑测试房间码</button>
      <output data-testid="initial-room-code">{initialCode ?? ''}</output>
      <output data-testid="join-mode">{mode}</output>
      <output data-testid="join-error">{error ?? ''}</output>
    </div>
  ),
}))

vi.mock('./components/ShareDialog', () => ({
  default: (props: {
    roomCode: string
    roomUrl: string
    onClose(): void
  }) => {
    boundary.renderShareDialog(props)
    return (
      <div role="dialog" aria-label="分享测试房间">
        <button type="button" onClick={props.onClose}>关闭测试分享</button>
      </div>
    )
  },
}))

vi.mock('./components/ManualJoinWaiting', () => ({
  default: (props: {
    roomCode: string
    error?: string
    onCancel(): void
    onChangeRoom(): void
    onRetry?(): void
  }) => (
    <div data-testid="manual-waiting" data-room-code={props.roomCode}>
      <span>{props.error}</span>
      <button type="button" onClick={props.onCancel}>取消测试申请</button>
      <button type="button" onClick={props.onChangeRoom}>更换测试房间</button>
      {props.onRetry && <button type="button" onClick={props.onRetry}>重试测试申请</button>}
    </div>
  ),
}))

vi.mock('./components/SenderJoinRequestDialog', () => ({
  default: (props: {
    request: { requestId: string; visitor: PublicVisitor }
    remainingCount: number
    pendingDecision?: 'approve' | 'reject'
    onApprove(requestId: string): void
    onReject(requestId: string): void
  }) => (
    <div role="dialog" aria-label="发送者加入申请">
      <span>{props.request.visitor.displayName}</span>
      <span data-testid="remaining-requests">{props.remainingCount}</span>
      <span data-testid="pending-decision">{props.pendingDecision ?? ''}</span>
      <button type="button" onClick={() => props.onReject(props.request.requestId)}>拒绝测试申请</button>
      <button type="button" onClick={() => props.onApprove(props.request.requestId)}>允许测试申请</button>
    </div>
  ),
}))

type MockTransferPanelProps = {
  activity?: OutgoingActivity
  files: FileSelection[]
  receivers: PublicVisitor[]
  fileSpeedData?: Record<string, { speed: number; eta: number | undefined }>
  onFilesAdded(files: readonly File[]): void
  onSendText(text: string, peerIds: readonly string[]): Promise<void>
  onSendFiles(peerIds: readonly string[]): Promise<void>
  onCancel(): void
  onRetry?(): Promise<void>
  onDismissActivity?(): void
}

vi.mock('./components/TransferPanel', () => ({
  default: (props: MockTransferPanelProps) => {
    const firstFile = props.activity
      ? Object.values(props.activity.files)[0]
      : undefined
    const firstFileId = props.files[0]?.fileId
    const firstFileSpeed = firstFileId ? props.fileSpeedData?.[firstFileId] : undefined
    return (
      <div
        data-testid="transfer-panel"
        data-receiver-ids={props.receivers.map(receiver => receiver.id).join(',')}
      >
        <button
          type="button"
          disabled={Boolean(props.activity)}
          onClick={() => { void props.onSendText('精确文本\n🙂', ['receiver']) }}
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
          onClick={() => { void props.onSendFiles(['receiver']) }}
        >
          发送测试文件
        </button>
        <button type="button" onClick={props.onCancel}>取消测试传输</button>
        {(props.activity?.phase === 'complete' || props.activity?.phase === 'error') && (
          <>
            <button type="button" onClick={() => { void props.onRetry?.() }}>再次发送</button>
            <button type="button" onClick={props.onDismissActivity}>关闭结果</button>
          </>
        )}
        <output data-testid="activity-phase">{props.activity?.phase ?? 'idle'}</output>
        <output data-testid="file-progress">{firstFile?.progress ?? 0}</output>
        <output data-testid="file-speed">{firstFileSpeed?.speed ?? ''}</output>
        <output data-testid="file-eta">{firstFileSpeed?.eta ?? ''}</output>
      </div>
    )
  },
}))

vi.mock('./components/ReceiverPanel', () => ({
  default: ({
    visitor,
    sender,
    receivers,
    state,
  }: {
    visitor: PublicVisitor
    sender?: PublicVisitor
    receivers: PublicVisitor[]
    state: { status: string }
  }) => (
    <div
      data-testid="receiver-panel"
      data-visitor-id={visitor.id}
      data-sender-id={sender?.id ?? ''}
      data-receiver-ids={receivers.map(receiver => receiver.id).join(',')}
    >
      {state.status}
    </div>
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
    fileSpeedData,
    onAccept,
    onReject,
    onCancel,
    onClose,
  }: {
    files: Array<{ fileId: string; name: string }>
    state: {
      status: string
      files?: Array<{ name: string; url: string }>
      progressByFileId?: Record<string, number>
    }
    fileSpeedData?: Record<string, { speed: number; eta: number | undefined }>
    onAccept(): void
    onReject(): void
    onCancel(): void
    onClose(): void
  }) => (
    <div role="dialog" aria-label="收到文件">
      <div data-testid="file-dialog-status">{state.status}</div>
      <output data-testid="incoming-file-speed">
        {fileSpeedData?.[files[0]?.fileId ?? '']?.speed ?? ''}
      </output>
      <output data-testid="incoming-file-eta">
        {fileSpeedData?.[files[0]?.fileId ?? '']?.eta ?? ''}
      </output>
      {state.status === 'receiving' && (
        <output data-testid="incoming-file-progress">
          {JSON.stringify(state.progressByFileId)}
        </output>
      )}
      {files.map(file => <span key={file.name}>{file.name}</span>)}
      {state.status === 'pending' && (
        <>
          <button type="button" onClick={onAccept}>接收测试文件</button>
          <button type="button" onClick={onReject}>拒绝测试文件</button>
        </>
      )}
      {state.status === 'receiving' && (
        <button type="button" onClick={onCancel}>取消测试接收</button>
      )}
      {(state.status === 'received' || state.status === 'error') && (
        <button type="button" onClick={onClose}>关闭文件弹窗</button>
      )}
    </div>
  ),
}))

vi.mock('./components/RoomCodeCopyButton', () => ({
  default: ({ code, onCopy }: { code: string; onCopy(code: string): Promise<void> }) => (
    <button
      type="button"
      aria-label="复制测试房间码"
      onClick={() => { void onCopy(code) }}
    >
      <span data-testid="room-code-copy-value">{code}</span>
      <span>content_copy</span>
    </button>
  ),
}))

type RealtimeMessageListener = (message: ServerRealtimeMessage) => void
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

  emitMessage(message: ServerRealtimeMessage) {
    for (const listener of this.messageListeners) listener(message)
  }
}

class FakePeerSession {
  readonly syncRoom = vi.fn()
  readonly handleSignal = vi.fn(async () => undefined)
  readyPeerIdList: readonly string[] = ['receiver']
  readonly readyPeerIds = vi.fn((): readonly string[] => this.readyPeerIdList)
  readonly close = vi.fn()
  readonly offerText = vi.fn((_text: string, _peerIds?: readonly string[]) => ({
    transferId: 'text-1',
    peerIds: ['receiver'],
    peerCount: 1,
    unsupportedPeerIds: [],
  }))
  readonly offerFiles = vi.fn((_files: readonly FileSelection[], _peerIds?: readonly string[]) => ({
    transferId: 'files-1',
    peerIds: ['receiver'],
    peerCount: 1,
    unsupportedPeerIds: [],
  }))
  readonly acknowledgeText = vi.fn(() => true)
  readonly discardText = vi.fn(() => true)
  readonly acceptFiles = vi.fn(() => true)
  readonly rejectFiles = vi.fn(() => true)
  readonly cancelTransfer = vi.fn((_transferId: string) => true)
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
const receiverTwo = visitor('receiver-2', '接收者二号')

const room: PublicRoom = {
  code: '012345',
  senderId: sender.id,
  receivers: [receiver.id],
  participants: [
    { visitor: sender, role: 'sender', joinedAt: 1, status: 'online' },
    { visitor: receiver, role: 'receiver', joinedAt: 1, status: 'online' },
  ],
  createdAt: 1,
  expiresAt: Date.now() + 30 * 60 * 1_000,
}

const inviteToken = `inv_${'A'.repeat(43)}`
const ownerInvite = {
  token: inviteToken,
  expiresAt: room.expiresAt,
}
const absentNavigation: RoomNavigationSnapshot = Object.freeze({
  fragment: Object.freeze({ kind: 'absent' }),
})
const invitationNavigation: RoomNavigationSnapshot = Object.freeze({
  fragment: Object.freeze({
    kind: 'invite',
    intent: Object.freeze({
      kind: 'invite',
      roomCode: room.code,
      inviteToken,
    }),
  }),
})

const roomForReceiver = (activeReceiver: PublicVisitor): PublicRoom => ({
  ...room,
  receivers: [activeReceiver.id],
  participants: [
    room.participants[0]!,
    { visitor: activeReceiver, role: 'receiver', joinedAt: 1, status: 'online' },
  ],
})

const pendingReceipt = {
  requestId: 'request-1',
  state: 'pending' as const,
  expiresAt: Date.now() + 90_000,
}

const joinRequestSummary: RoomJoinRequestSummary = {
  requestId: pendingReceipt.requestId,
  roomCode: room.code,
  visitor: receiver,
  createdAt: 1,
  expiresAt: pendingReceipt.expiresAt,
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
  const activeVisitor = role === 'sender' ? sender : receiver
  boundary.loadVisitorSession.mockReturnValue(sessionFor(activeVisitor))
  boundary.createVisitor.mockResolvedValue(sessionFor(activeVisitor))
  const rendered = render(
    <App initialNavigation={role === 'receiver' ? invitationNavigation : absentNavigation} />,
  )
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

const receivingProgress = (
  transferId: string,
  fileId: string,
  fileBytes: number,
  fileTotalBytes: number,
): PeerSessionEvent => ({
  type: 'transfer:file-progress',
  peerId: sender.id,
  transferId,
  fileId,
  direction: 'receiving',
  fileBytes,
  fileTotalBytes,
  batchBytes: fileBytes,
  batchTotalBytes: fileTotalBytes,
})

beforeEach(() => {
  vi.resetAllMocks()
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.history.replaceState({}, '', '/')
  realtime = new FakeRealtimeClient()
  peerSession = new FakePeerSession()
  boundary.createRealtimeClient.mockReturnValue(realtime)
  boundary.createPeerSession.mockReturnValue(peerSession)
  boundary.createRoom.mockResolvedValue({ room, invite: ownerInvite })
  boundary.joinRoom.mockResolvedValue({ room })
  boundary.createRoomJoinRequest.mockResolvedValue(pendingReceipt)
  boundary.getRoomJoinRequest.mockResolvedValue(pendingReceipt)
  boundary.decideRoomJoinRequest.mockResolvedValue({
    ...pendingReceipt,
    state: 'approved',
  })
  boundary.finalizeRoomJoinRequest.mockResolvedValue({ room })
  boundary.cancelRoomJoinRequest.mockResolvedValue({
    ...pendingReceipt,
    state: 'cancelled',
  })
  boundary.setupNotificationPermissionPrompt.mockReturnValue(
    boundary.cleanupNotificationPermissionPrompt,
  )
  boundary.createVisitor.mockResolvedValue(sessionFor(sender))
  boundary.loadVisitorSession.mockReturnValue(sessionFor(sender))
  boundary.loadRoomSession.mockReturnValue(undefined)

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
    writable: true,
    value: requestFrame,
  })
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: cancelFrame,
  })
})

describe('App transfer integration', () => {
  test('reuses visitor bootstrap across StrictMode and ignores it after unmount', async () => {
    boundary.loadVisitorSession.mockReturnValue(undefined)
    let resolveVisitor!: (session: VisitorSession) => void
    const pendingVisitor = new Promise<VisitorSession>(resolve => {
      resolveVisitor = resolve
    })
    boundary.createVisitor.mockReturnValue(pendingVisitor)
    const rendered = render(
      <StrictMode>
        <App initialNavigation={absentNavigation} />
      </StrictMode>,
    )

    await waitFor(() => expect(boundary.createVisitor).toHaveBeenCalledTimes(1))
    rendered.unmount()
    expect(boundary.setupNotificationPermissionPrompt).toHaveBeenCalledTimes(2)
    expect(boundary.cleanupNotificationPermissionPrompt).toHaveBeenCalledTimes(2)
    await act(async () => {
      resolveVisitor(sessionFor(sender))
      await pendingVisitor
    })

    expect(boundary.saveVisitorSession).not.toHaveBeenCalled()
    expect(boundary.createRealtimeClient).not.toHaveBeenCalled()
  })

  test('does not connect realtime when a deferred room bootstrap resolves after unmount', async () => {
    let resolveBootstrap!: (value: { room: PublicRoom }) => void
    const pendingBootstrap = new Promise<{ room: PublicRoom }>(resolve => {
      resolveBootstrap = resolve
    })
    boundary.createRoom.mockReturnValueOnce(pendingBootstrap)
    const user = userEvent.setup()
    const rendered = render(<App initialNavigation={absentNavigation} />)

    await user.click(await screen.findByRole('button', { name: '创建测试房间' }))
    await waitFor(() => expect(boundary.createRoom).toHaveBeenCalledTimes(1))
    rendered.unmount()
    await act(async () => {
      resolveBootstrap({ room })
      await pendingBootstrap
    })

    expect(boundary.createRealtimeClient).not.toHaveBeenCalled()
    expect(boundary.createPeerSession).not.toHaveBeenCalled()
  })

  test('rejects a bootstrap that omits the authenticated membership', async () => {
    const invalidRoom: PublicRoom = {
      ...room,
      senderId: null,
      participants: room.participants.filter(participant => participant.role !== 'sender'),
    }
    boundary.createRoom.mockResolvedValueOnce({ room: invalidRoom })
    const user = userEvent.setup()
    render(<App initialNavigation={absentNavigation} />)

    await user.click(await screen.findByRole('button', { name: '创建测试房间' }))
    await waitFor(() => expect(boundary.showToast).toHaveBeenCalledWith(
      '服务端返回的房间成员关系无效',
    ))

    expect(boundary.createRealtimeClient).not.toHaveBeenCalled()
  })

  test('bootstraps ICE before realtime and attaches membership before creating peers', async () => {
    boundary.loadVisitorSession.mockReturnValue(sessionFor(sender))
    const user = userEvent.setup()
    render(<App initialNavigation={absentNavigation} />)

    await user.click(await screen.findByRole('button', { name: '创建测试房间' }))
    await waitFor(() => expect(boundary.createRealtimeClient).toHaveBeenCalledTimes(1))

    expect(boundary.createRoom).toHaveBeenCalledWith('token-sender', 'off')
    expect(realtime.connect).toHaveBeenCalledTimes(1)
    expect(boundary.createPeerSession).not.toHaveBeenCalled()

    act(() => realtime.emitStatus('open'))

    expect(realtime.send).toHaveBeenNthCalledWith(1, {
      type: 'room:attach',
      roomCode: room.code,
      role: 'sender',
    })
    expect(boundary.createPeerSession).toHaveBeenCalledWith(expect.objectContaining({
      selfId: sender.id,
      roomCode: room.code,
      role: 'sender',
      rtcConfiguration: {},
    }))
  })

  test('preserves a valid invitation snapshot through StrictMode and waits for confirmation', async () => {
    boundary.loadVisitorSession.mockReturnValue(sessionFor(sender))
    boundary.loadRoomSession.mockReturnValue({
      roomCode: '654321',
      role: 'receiver',
      expiresAt: Date.now() + 60_000,
    })
    boundary.createVisitor.mockResolvedValueOnce(sessionFor(receiver))
    const user = userEvent.setup()
    render(
      <StrictMode>
        <App initialNavigation={invitationNavigation} />
      </StrictMode>,
    )

    expect((await screen.findByTestId('initial-room-code')).textContent).toBe(room.code)
    expect(screen.getByTestId('join-mode').textContent).toBe('invite')
    expect(boundary.joinRoom).not.toHaveBeenCalled()
    expect(boundary.clearRoomSession).toHaveBeenCalledTimes(1)

    await user.click(await screen.findByRole('button', { name: '加入测试房间' }))
    await waitFor(() => expect(boundary.createRealtimeClient).toHaveBeenCalledTimes(1))

    expect(boundary.createVisitor).toHaveBeenCalledTimes(1)
    expect(boundary.saveVisitorSession).toHaveBeenCalledWith(sessionFor(receiver))
    expect(boundary.joinRoom).toHaveBeenCalledWith({
      roomCode: room.code,
      visitorToken: 'token-receiver',
      iceMode: 'off',
      admission: { kind: 'invite', inviteToken },
    })
  })

  test('invalid fragments suppress recovery while legacy query data stays manual-only', async () => {
    boundary.loadRoomSession.mockReturnValue({
      roomCode: room.code,
      role: 'receiver',
      expiresAt: Date.now() + 60_000,
    })
    const invalidNavigation: RoomNavigationSnapshot = {
      fragment: { kind: 'invalid' },
      legacyRoomCode: '654321',
    }

    const { unmount } = render(<App initialNavigation={invalidNavigation} />)

    expect((await screen.findByTestId('join-error')).textContent)
      .toBe('邀请链接无效或已过期')
    expect(screen.getByTestId('join-mode').textContent).toBe('manual')
    expect(screen.getByTestId('initial-room-code').textContent).toBe('654321')
    expect(boundary.joinRoom).not.toHaveBeenCalled()

    unmount()
    boundary.loadRoomSession.mockReturnValue(undefined)
    const legacyNavigation: RoomNavigationSnapshot = {
      fragment: { kind: 'absent' },
      legacyRoomCode: '654321',
    }
    render(<App initialNavigation={legacyNavigation} />)

    expect((await screen.findByTestId('initial-room-code')).textContent).toBe('654321')
    expect(screen.getByTestId('join-mode').textContent).toBe('manual')
  })

  test('editing an invitation destroys its capability and cannot use direct join', async () => {
    const user = userEvent.setup()
    boundary.createVisitor.mockResolvedValueOnce(sessionFor(receiver))

    render(<App initialNavigation={invitationNavigation} />)

    expect((await screen.findByTestId('join-mode')).textContent).toBe('invite')
    expect(boundary.joinRoom).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '编辑测试房间码' }))
    expect(screen.getByTestId('join-mode').textContent).toBe('manual')
    await user.click(screen.getByRole('button', { name: '请求加入测试房间' }))
    expect(boundary.joinRoom).not.toHaveBeenCalled()
    expect(boundary.createVisitor).toHaveBeenCalledTimes(1)
    expect(boundary.createRoomJoinRequest).toHaveBeenCalledWith({
      roomCode: room.code,
      visitorToken: 'token-receiver',
    })
  })

  test('does not resurrect the original invite code after changing a manual room', async () => {
    const user = userEvent.setup()
    boundary.createVisitor.mockResolvedValueOnce(sessionFor(receiver))

    render(<App initialNavigation={invitationNavigation} />)

    await user.click(await screen.findByRole('button', { name: '编辑测试房间码' }))
    await user.click(screen.getByRole('button', { name: '请求加入其他测试房间' }))
    await waitFor(() => expect(screen.getByTestId('manual-waiting').dataset.roomCode)
      .toBe('654321'))
    await user.click(screen.getByRole('button', { name: '更换测试房间' }))

    await waitFor(() => expect(screen.queryByTestId('manual-waiting')).toBeNull())
    expect(screen.getByTestId('join-mode').textContent).toBe('manual')
    expect(screen.getByTestId('initial-room-code').textContent).toBe('')
  })

  test('replaces an invite visitor at most once after VISITOR_NOT_FOUND', async () => {
    const user = userEvent.setup()
    boundary.createVisitor
      .mockResolvedValueOnce(sessionFor(receiver))
      .mockResolvedValueOnce(sessionFor(receiverTwo))
    boundary.joinRoom
      .mockRejectedValueOnce(new ApiClientError('访客已失效', 'VISITOR_NOT_FOUND', 401))
      .mockResolvedValueOnce({ room: roomForReceiver(receiverTwo) })

    render(<App initialNavigation={invitationNavigation} />)

    await user.click(await screen.findByRole('button', { name: '加入测试房间' }))
    await waitFor(() => expect(boundary.createRealtimeClient).toHaveBeenCalledTimes(1))

    expect(boundary.createVisitor).toHaveBeenCalledTimes(2)
    expect(boundary.joinRoom).toHaveBeenNthCalledWith(1, {
      roomCode: room.code,
      visitorToken: 'token-receiver',
      iceMode: 'off',
      admission: { kind: 'invite', inviteToken },
    })
    expect(boundary.joinRoom).toHaveBeenNthCalledWith(2, {
      roomCode: room.code,
      visitorToken: 'token-receiver-2',
      iceMode: 'off',
      admission: { kind: 'invite', inviteToken },
    })
  })

  test('retains invitation identity and authority after a network failure', async () => {
    const user = userEvent.setup()
    boundary.createVisitor.mockResolvedValueOnce(sessionFor(receiver))
    boundary.joinRoom
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce({ room })

    render(<App initialNavigation={invitationNavigation} />)

    await user.click(await screen.findByRole('button', { name: '加入测试房间' }))
    await waitFor(() => expect(boundary.showToast).toHaveBeenCalledWith('network unavailable'))
    expect(screen.getByTestId('join-mode').textContent).toBe('invite')
    await user.click(screen.getByRole('button', { name: '加入测试房间' }))
    await waitFor(() => expect(boundary.createRealtimeClient).toHaveBeenCalledTimes(1))

    expect(boundary.createVisitor).toHaveBeenCalledTimes(1)
    expect(boundary.joinRoom).toHaveBeenCalledTimes(2)
    expect(boundary.joinRoom).toHaveBeenLastCalledWith({
      roomCode: room.code,
      visitorToken: 'token-receiver',
      iceMode: 'off',
      admission: { kind: 'invite', inviteToken },
    })
  })

  test('clears a deterministically denied invitation without direct fallback', async () => {
    const user = userEvent.setup()
    boundary.createVisitor.mockResolvedValueOnce(sessionFor(receiver))
    boundary.joinRoom.mockRejectedValueOnce(
      new ApiClientError('denied', 'ROOM_ACCESS_DENIED', 404),
    )

    render(<App initialNavigation={invitationNavigation} />)

    await user.click(await screen.findByRole('button', { name: '加入测试房间' }))
    await waitFor(() => expect(screen.getByTestId('join-mode').textContent).toBe('manual'))
    expect(screen.getByTestId('join-error').textContent).toBe('邀请链接无效或已过期')
    expect(boundary.joinRoom).toHaveBeenCalledTimes(1)
    expect(boundary.createVisitor).toHaveBeenCalledTimes(1)
  })

  test('uses strict same-tab recovery without minting or replacing identity', async () => {
    const persisted = {
      roomCode: room.code,
      role: 'receiver' as const,
      expiresAt: Date.now() + 60_000,
    }
    boundary.loadVisitorSession.mockReturnValue(sessionFor(receiver))
    boundary.loadRoomSession.mockReturnValue(persisted)
    let resolveJoin!: (value: { room: PublicRoom }) => void
    const pendingJoin = new Promise<{ room: PublicRoom }>(resolve => {
      resolveJoin = resolve
    })
    boundary.joinRoom.mockReturnValueOnce(pendingJoin)

    render(<App initialNavigation={absentNavigation} />)

    await waitFor(() => expect(boundary.joinRoom).toHaveBeenCalledWith({
      roomCode: room.code,
      visitorToken: 'token-receiver',
      iceMode: 'off',
      admission: { kind: 'recovery' },
    }))
    expect(boundary.createVisitor).not.toHaveBeenCalled()
    expect(boundary.clearRoomSession).not.toHaveBeenCalled()

    await act(async () => {
      resolveJoin({ room })
      await pendingJoin
    })
    await waitFor(() => expect(boundary.createRealtimeClient).toHaveBeenCalledTimes(1))
    expect(boundary.saveRoomSession).toHaveBeenCalledWith({
      roomCode: room.code,
      role: 'receiver',
      expiresAt: room.expiresAt,
    })
  })

  test('a visitor minted during boot clears stale recovery instead of claiming it', async () => {
    boundary.loadVisitorSession.mockReturnValue(undefined)
    boundary.loadRoomSession.mockReturnValue({
      roomCode: room.code,
      role: 'receiver',
      expiresAt: Date.now() + 60_000,
    })
    boundary.createVisitor.mockResolvedValueOnce(sessionFor(receiver))

    render(<App initialNavigation={absentNavigation} />)

    await waitFor(() => expect(boundary.clearRoomSession).toHaveBeenCalledTimes(1))
    expect(boundary.createVisitor).toHaveBeenCalledTimes(1)
    expect(boundary.joinRoom).not.toHaveBeenCalled()
  })

  test('recovery VISITOR_NOT_FOUND clears stale authority and never mints', async () => {
    boundary.loadVisitorSession.mockReturnValue(sessionFor(receiver))
    boundary.loadRoomSession.mockReturnValue({
      roomCode: room.code,
      role: 'receiver',
      expiresAt: Date.now() + 60_000,
    })
    boundary.joinRoom.mockRejectedValueOnce(
      new ApiClientError('访客已失效', 'VISITOR_NOT_FOUND', 401),
    )

    render(<App initialNavigation={absentNavigation} />)

    await waitFor(() => expect(boundary.clearRoomSession).toHaveBeenCalledTimes(1))
    expect(boundary.clearVisitorSession).toHaveBeenCalledTimes(1)
    expect(boundary.createVisitor).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '重新连接' })).toBeNull()
  })

  test.each([
    {
      label: 'network failure',
      error: new TypeError('Failed to fetch'),
      message: '网络连接失败，请稍后重试',
    },
    {
      label: 'rate limit',
      error: new ApiClientError('请求过于频繁', 'RATE_LIMITED', 429),
      message: '请求过于频繁',
    },
    {
      label: 'server failure',
      error: new ApiClientError('服务暂时不可用', 'INTERNAL_ERROR', 503),
      message: '服务暂时不可用',
    },
  ])('a recovery $label retains its identity and exposes an exact recovery retry', async ({
    error,
    message,
  }) => {
    boundary.loadVisitorSession.mockReturnValue(sessionFor(receiver))
    boundary.loadRoomSession.mockReturnValue({
      roomCode: room.code,
      role: 'receiver',
      expiresAt: Date.now() + 60_000,
    })
    boundary.joinRoom
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ room })
    const user = userEvent.setup()

    render(<App initialNavigation={absentNavigation} />)

    await waitFor(() => expect(boundary.showToast).toHaveBeenCalledWith(message))
    expect(screen.getByText(room.code)).not.toBeNull()
    expect(boundary.clearRoomSession).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '重新连接' }))
    await waitFor(() => expect(boundary.createRealtimeClient).toHaveBeenCalledTimes(1))

    expect(boundary.joinRoom).toHaveBeenCalledTimes(2)
    expect(boundary.joinRoom).toHaveBeenLastCalledWith({
      roomCode: room.code,
      visitorToken: 'token-receiver',
      iceMode: 'off',
      admission: { kind: 'recovery' },
    })
    expect(boundary.clearVisitorSession).not.toHaveBeenCalled()
    expect(boundary.createVisitor).not.toHaveBeenCalled()
  })

  test('does not recover a receiver room at its exact expiry boundary', async () => {
    const now = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)
    boundary.loadVisitorSession.mockReturnValue(sessionFor(receiver))
    boundary.loadRoomSession.mockReturnValue({
      roomCode: room.code,
      role: 'receiver',
      expiresAt: now,
    })

    try {
      render(<App initialNavigation={absentNavigation} />)

      await waitFor(() => expect(boundary.clearRoomSession).toHaveBeenCalledTimes(1))
      expect(boundary.joinRoom).not.toHaveBeenCalled()
      expect(boundary.createVisitor).not.toHaveBeenCalled()
      expect(boundary.showToast).toHaveBeenCalledWith(
        '上次的房间已到期，请创建或加入新房间',
        'info',
      )
    } finally {
      nowSpy.mockRestore()
    }
  })

  test('keeps owner invitation in memory and exposes sharing only to the sender', async () => {
    window.history.replaceState({ source: 'owner' }, '', '/deploy/app/?campaign=summer')
    const user = userEvent.setup()
    const rendered = render(<App initialNavigation={absentNavigation} />)

    await user.click(await screen.findByRole('button', { name: '创建测试房间' }))
    await waitFor(() => expect(boundary.createRealtimeClient).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: '分享房间' })).not.toBeNull()
    expect(rendered.container.textContent).not.toContain(inviteToken)
    expect(JSON.stringify(window.localStorage)).not.toContain(inviteToken)
    expect(JSON.stringify(window.sessionStorage)).not.toContain(inviteToken)

    await user.click(screen.getByRole('button', { name: '分享房间' }))
    expect(boundary.renderShareDialog).toHaveBeenCalledWith(expect.objectContaining({
      roomCode: room.code,
      roomUrl: `http://localhost:3000/deploy/app/?campaign=summer#room=${room.code}&invite=${inviteToken}`,
    }))

    act(() => realtime.emitMessage({
      type: 'error',
      code: 'ROOM_MEMBERSHIP_REQUIRED',
      message: 'membership lost',
    }))
    expect(screen.queryByRole('button', { name: '分享房间' })).toBeNull()
  })

  test('reuses one manual visitor after a lost 202 and finalizes an authoritative approval', async () => {
    const user = userEvent.setup()
    boundary.createVisitor.mockResolvedValueOnce(sessionFor(receiver))
    boundary.createRoomJoinRequest
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ ...pendingReceipt, state: 'approved' })

    render(<App initialNavigation={absentNavigation} />)

    await user.click(await screen.findByRole('button', { name: '请求加入测试房间' }))
    await waitFor(() => expect(boundary.showToast).toHaveBeenCalledWith('response lost'))
    await user.click(screen.getByRole('button', { name: '请求加入测试房间' }))
    await waitFor(() => expect(boundary.createRealtimeClient).toHaveBeenCalledTimes(1))

    expect(boundary.createVisitor).toHaveBeenCalledTimes(1)
    expect(boundary.createRoomJoinRequest).toHaveBeenCalledTimes(2)
    expect(boundary.createRoomJoinRequest).toHaveBeenLastCalledWith({
      roomCode: room.code,
      visitorToken: 'token-receiver',
    })
    expect(boundary.finalizeRoomJoinRequest).toHaveBeenCalledWith({
      roomCode: room.code,
      requestId: pendingReceipt.requestId,
      visitorToken: 'token-receiver',
      iceMode: 'off',
    })
  })

  test('replaces a receiptless manual intent before a failed create-room attempt', async () => {
    const user = userEvent.setup()
    boundary.createVisitor
      .mockResolvedValueOnce(sessionFor(receiver))
      .mockResolvedValueOnce(sessionFor(receiverTwo))
    boundary.createRoomJoinRequest
      .mockRejectedValueOnce(new Error('request response lost'))
      .mockResolvedValueOnce({ ...pendingReceipt, state: 'approved' })
    boundary.createRoom.mockRejectedValueOnce(new Error('create failed'))
    boundary.finalizeRoomJoinRequest.mockResolvedValueOnce({
      room: roomForReceiver(receiverTwo),
    })

    render(<App initialNavigation={absentNavigation} />)

    await user.click(await screen.findByRole('button', { name: '请求加入测试房间' }))
    await waitFor(() => expect(boundary.showToast).toHaveBeenCalledWith('request response lost'))
    await user.click(screen.getByRole('button', { name: '创建测试房间' }))
    await waitFor(() => expect(boundary.showToast).toHaveBeenCalledWith('create failed'))
    await user.click(screen.getByRole('button', { name: '请求加入测试房间' }))
    await waitFor(() => expect(boundary.createRealtimeClient).toHaveBeenCalledTimes(1))

    expect(boundary.createVisitor).toHaveBeenCalledTimes(2)
    expect(boundary.createRoomJoinRequest).toHaveBeenLastCalledWith({
      roomCode: room.code,
      visitorToken: 'token-receiver-2',
    })
    expect(boundary.finalizeRoomJoinRequest).toHaveBeenCalledWith({
      roomCode: room.code,
      requestId: pendingReceipt.requestId,
      visitorToken: 'token-receiver-2',
      iceMode: 'off',
    })
  })

  test('retains the pending manual receipt for an UNKNOWN_API_ERROR', async () => {
    const user = userEvent.setup()
    boundary.createVisitor.mockResolvedValueOnce(sessionFor(receiver))
    boundary.getRoomJoinRequest.mockRejectedValueOnce(
      new ApiClientError('unknown poll response', 'UNKNOWN_API_ERROR', 400),
    )

    render(<App initialNavigation={absentNavigation} />)

    await user.click(await screen.findByRole('button', { name: '请求加入测试房间' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '重试测试申请' })).not.toBeNull())
    expect(screen.getByTestId('manual-waiting').dataset.roomCode).toBe(room.code)

    await user.click(screen.getByRole('button', { name: '重试测试申请' }))
    await waitFor(() => expect(boundary.getRoomJoinRequest).toHaveBeenCalledTimes(2))
    expect(boundary.createVisitor).toHaveBeenCalledTimes(1)
    expect(boundary.createRoomJoinRequest).toHaveBeenCalledTimes(1)
  })

  test('polls a pending manual request without overlap and finalizes approval', async () => {
    boundary.createVisitor.mockResolvedValueOnce(sessionFor(receiver))
    boundary.getRoomJoinRequest
      .mockResolvedValueOnce(pendingReceipt)
      .mockResolvedValueOnce({ ...pendingReceipt, state: 'approved' })
    const user = userEvent.setup()
    render(<App initialNavigation={absentNavigation} />)

    await user.click(await screen.findByRole('button', { name: '请求加入测试房间' }))
    await waitFor(() => expect(screen.getByTestId('manual-waiting')).not.toBeNull())
    expect(boundary.getRoomJoinRequest).toHaveBeenCalledTimes(1)

    await waitFor(
      () => expect(boundary.createRealtimeClient).toHaveBeenCalledTimes(1),
      { timeout: 3_000 },
    )
    expect(boundary.getRoomJoinRequest).toHaveBeenCalledTimes(2)
  })

  test('cancels with the bound visitor before returning to the retained room code', async () => {
    const user = userEvent.setup()
    boundary.createVisitor.mockResolvedValueOnce(sessionFor(receiver))
    render(<App initialNavigation={absentNavigation} />)

    await user.click(await screen.findByRole('button', { name: '请求加入测试房间' }))
    await waitFor(() => expect(screen.getByTestId('manual-waiting')).not.toBeNull())
    await user.click(screen.getByRole('button', { name: '取消测试申请' }))

    await waitFor(() => expect(screen.queryByTestId('manual-waiting')).toBeNull())
    expect(boundary.cancelRoomJoinRequest).toHaveBeenCalledWith({
      roomCode: room.code,
      requestId: pendingReceipt.requestId,
      visitorToken: 'token-receiver',
    })
    expect(screen.getByTestId('initial-room-code').textContent).toBe(room.code)
  })

  test('recovers a lost finalize response with the same visitor and no mint', async () => {
    const user = userEvent.setup()
    boundary.createVisitor.mockResolvedValueOnce(sessionFor(receiver))
    boundary.createRoomJoinRequest.mockResolvedValueOnce({
      ...pendingReceipt,
      state: 'approved',
    })
    boundary.finalizeRoomJoinRequest.mockRejectedValueOnce(
      new ApiClientError('receipt removed', 'ROOM_JOIN_REQUEST_NOT_FOUND', 404),
    )
    render(<App initialNavigation={absentNavigation} />)

    await user.click(await screen.findByRole('button', { name: '请求加入测试房间' }))
    await waitFor(() => expect(boundary.createRealtimeClient).toHaveBeenCalledTimes(1))

    expect(boundary.createVisitor).toHaveBeenCalledTimes(1)
    expect(boundary.joinRoom).toHaveBeenCalledWith({
      roomCode: room.code,
      visitorToken: 'token-receiver',
      iceMode: 'off',
      admission: { kind: 'recovery' },
    })
  })

  test('retains finalized authority when strict recovery fails over the network', async () => {
    const user = userEvent.setup()
    boundary.createVisitor.mockResolvedValueOnce(sessionFor(receiver))
    boundary.createRoomJoinRequest.mockResolvedValueOnce({
      ...pendingReceipt,
      state: 'approved',
    })
    boundary.finalizeRoomJoinRequest.mockRejectedValueOnce(
      new ApiClientError('receipt removed', 'ROOM_JOIN_REQUEST_NOT_FOUND', 404),
    )
    boundary.joinRoom
      .mockRejectedValueOnce(new Error('recovery network failed'))
      .mockResolvedValueOnce({ room })
    render(<App initialNavigation={absentNavigation} />)

    await user.click(await screen.findByRole('button', { name: '请求加入测试房间' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '重试测试申请' })).not.toBeNull())
    expect(screen.getByTestId('manual-waiting').dataset.roomCode).toBe(room.code)
    await user.click(screen.getByRole('button', { name: '重试测试申请' }))
    await waitFor(() => expect(boundary.createRealtimeClient).toHaveBeenCalledTimes(1))

    expect(boundary.createVisitor).toHaveBeenCalledTimes(1)
    expect(boundary.createRoomJoinRequest).toHaveBeenCalledTimes(1)
    expect(boundary.joinRoom).toHaveBeenCalledTimes(2)
  })

  test('retries strict recovery after an UNKNOWN_API_ERROR with the same visitor', async () => {
    const user = userEvent.setup()
    boundary.createVisitor.mockResolvedValueOnce(sessionFor(receiver))
    boundary.createRoomJoinRequest.mockResolvedValueOnce({
      ...pendingReceipt,
      state: 'approved',
    })
    boundary.finalizeRoomJoinRequest.mockRejectedValueOnce(
      new ApiClientError('receipt removed', 'ROOM_JOIN_REQUEST_NOT_FOUND', 404),
    )
    boundary.joinRoom
      .mockRejectedValueOnce(
        new ApiClientError('unknown recovery response', 'UNKNOWN_API_ERROR', 400),
      )
      .mockResolvedValueOnce({ room })
    render(<App initialNavigation={absentNavigation} />)

    await user.click(await screen.findByRole('button', { name: '请求加入测试房间' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '重试测试申请' })).not.toBeNull())
    await user.click(screen.getByRole('button', { name: '重试测试申请' }))
    await waitFor(() => expect(boundary.createRealtimeClient).toHaveBeenCalledTimes(1))

    expect(boundary.createVisitor).toHaveBeenCalledTimes(1)
    expect(boundary.createRoomJoinRequest).toHaveBeenCalledTimes(1)
    expect(boundary.joinRoom).toHaveBeenCalledTimes(2)
    expect(boundary.joinRoom).toHaveBeenLastCalledWith({
      roomCode: room.code,
      visitorToken: 'token-receiver',
      iceMode: 'off',
      admission: { kind: 'recovery' },
    })
  })

  test('uses strict recovery when an authoritative replay is already finalized', async () => {
    const user = userEvent.setup()
    boundary.createVisitor.mockResolvedValueOnce(sessionFor(receiver))
    boundary.createRoomJoinRequest.mockResolvedValueOnce({
      ...pendingReceipt,
      state: 'finalized',
    })
    render(<App initialNavigation={absentNavigation} />)

    await user.click(await screen.findByRole('button', { name: '请求加入测试房间' }))
    await waitFor(() => expect(boundary.createRealtimeClient).toHaveBeenCalledTimes(1))

    expect(boundary.finalizeRoomJoinRequest).not.toHaveBeenCalled()
    expect(boundary.joinRoom).toHaveBeenCalledWith({
      roomCode: room.code,
      visitorToken: 'token-receiver',
      iceMode: 'off',
      admission: { kind: 'recovery' },
    })
    expect(boundary.createVisitor).toHaveBeenCalledTimes(1)
  })

  test('keeps the fixed waiting context when cancellation returns a deterministic 4xx', async () => {
    const user = userEvent.setup()
    boundary.createVisitor.mockResolvedValueOnce(sessionFor(receiver))
    boundary.cancelRoomJoinRequest.mockRejectedValueOnce(
      new ApiClientError('request conflict', 'ROOM_JOIN_REQUEST_INVALID_STATE', 409),
    )
    render(<App initialNavigation={absentNavigation} />)

    await user.click(await screen.findByRole('button', { name: '请求加入测试房间' }))
    await waitFor(() => expect(screen.getByTestId('manual-waiting')).not.toBeNull())
    await user.click(screen.getByRole('button', { name: '取消测试申请' }))
    await waitFor(() => expect(boundary.showToast).toHaveBeenCalledWith('request conflict'))

    expect(screen.getByTestId('manual-waiting').dataset.roomCode).toBe(room.code)
    await user.click(screen.getByRole('button', { name: '取消测试申请' }))
    await waitFor(() => expect(screen.queryByTestId('manual-waiting')).toBeNull())

    expect(boundary.createVisitor).toHaveBeenCalledTimes(1)
    expect(boundary.createRoomJoinRequest).toHaveBeenCalledTimes(1)
    expect(boundary.cancelRoomJoinRequest).toHaveBeenCalledTimes(2)
    expect(boundary.cancelRoomJoinRequest).toHaveBeenLastCalledWith({
      roomCode: room.code,
      requestId: pendingReceipt.requestId,
      visitorToken: 'token-receiver',
    })
    expect(screen.getByTestId('initial-room-code').textContent).toBe(room.code)
  })

  test('keeps waiting when change-room cancellation fails and resets only after success', async () => {
    const user = userEvent.setup()
    boundary.createVisitor.mockResolvedValueOnce(sessionFor(receiver))
    boundary.cancelRoomJoinRequest.mockRejectedValueOnce(new Error('cancel failed'))
    render(<App initialNavigation={absentNavigation} />)

    await user.click(await screen.findByRole('button', { name: '请求加入测试房间' }))
    await waitFor(() => expect(screen.getByTestId('manual-waiting')).not.toBeNull())
    await user.click(screen.getByRole('button', { name: '更换测试房间' }))
    await waitFor(() => expect(boundary.showToast).toHaveBeenCalledWith('cancel failed'))
    expect(screen.getByTestId('manual-waiting').dataset.roomCode).toBe(room.code)

    await user.click(screen.getByRole('button', { name: '更换测试房间' }))
    await waitFor(() => expect(screen.queryByTestId('manual-waiting')).toBeNull())
    expect(screen.getByTestId('initial-room-code').textContent).toBe('')
    expect(boundary.cancelRoomJoinRequest).toHaveBeenCalledTimes(2)
    expect(boundary.cancelRoomJoinRequest).toHaveBeenLastCalledWith({
      roomCode: room.code,
      requestId: pendingReceipt.requestId,
      visitorToken: 'token-receiver',
    })
  })

  test('queues sender requests from realtime and keeps a failed decision visible', async () => {
    const user = await enterRoom('sender')
    const secondRequest: RoomJoinRequestSummary = {
      ...joinRequestSummary,
      requestId: 'request-2',
      visitor: receiverTwo,
      createdAt: 2,
    }
    act(() => realtime.emitMessage({
      type: 'room:join-requests',
      roomCode: room.code,
      requests: [secondRequest, joinRequestSummary],
    }))
    act(() => realtime.emitMessage({
      type: 'room:join-requested',
      request: joinRequestSummary,
    }))

    expect(screen.getByRole('dialog', { name: '发送者加入申请' }).textContent)
      .toContain(receiver.displayName)
    expect(screen.getByTestId('remaining-requests').textContent).toBe('1')
    boundary.decideRoomJoinRequest.mockRejectedValueOnce(new Error('decision failed'))
    await user.click(screen.getByRole('button', { name: '允许测试申请' }))
    await waitFor(() => expect(boundary.showToast).toHaveBeenCalledWith('decision failed'))
    expect(screen.getByRole('dialog', { name: '发送者加入申请' }).textContent)
      .toContain(receiver.displayName)

    await user.click(screen.getByRole('button', { name: '允许测试申请' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: '发送者加入申请' }).textContent)
      .toContain(receiverTwo.displayName))
    expect(boundary.decideRoomJoinRequest).toHaveBeenLastCalledWith({
      roomCode: room.code,
      requestId: pendingReceipt.requestId,
      visitorToken: 'token-sender',
      decision: 'approve',
    })
  })

  test('ignores sender-only room access events while attached as a receiver', async () => {
    await enterRoom('receiver')

    act(() => realtime.emitMessage({
      type: 'room:join-requests',
      roomCode: room.code,
      requests: [joinRequestSummary],
    }))
    act(() => realtime.emitMessage({
      type: 'room:join-requested',
      request: joinRequestSummary,
    }))

    expect(screen.queryByRole('dialog', { name: '发送者加入申请' })).toBeNull()
  })

  test('passes only ready room receivers to the transfer panel', async () => {
    const receiverTwo = visitor('receiver-2', '接收者二号')
    const roomWithTwoReceivers: PublicRoom = {
      ...room,
      receivers: [receiver.id, receiverTwo.id],
      participants: [
        ...room.participants,
        {
          visitor: receiverTwo,
          role: 'receiver',
          joinedAt: 1,
          status: 'online',
        },
      ],
    }
    boundary.createRoom.mockResolvedValueOnce({ room: roomWithTwoReceivers })

    await enterRoom('sender')

    expect(screen.getByTestId('transfer-panel').dataset.receiverIds).toBe(receiver.id)
  })

  test('passes receiver identity and room peers to the receiver panel', async () => {
    await enterRoom('receiver')

    const panel = screen.getByTestId('receiver-panel')
    expect(panel.dataset.visitorId).toBe(receiver.id)
    expect(panel.dataset.senderId).toBe(sender.id)
    expect(panel.dataset.receiverIds).toBe(receiver.id)
    expect(screen.queryByRole('button', { name: '分享房间' })).toBeNull()
  })

  test('returns to a clean lobby when attached membership is no longer valid', async () => {
    await enterRoom('receiver')
    emit({
      type: 'transfer:text-received',
      peerId: sender.id,
      transferId: 'text-before-expiry',
      text: '只应显示到房间失效为止',
    })
    expect(screen.getByRole('dialog', { name: '收到文本' })).toBeTruthy()

    act(() => realtime.emitMessage({
      type: 'error',
      code: 'ROOM_MEMBERSHIP_REQUIRED',
      message: 'membership required',
    }))

    expect(realtime.close).toHaveBeenCalledTimes(1)
    expect(peerSession.close).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: '收到文本' })).toBeNull()
    expect(screen.getByRole('button', { name: '创建测试房间' })).toBeTruthy()
    expect(boundary.showToast).toHaveBeenCalledWith(
      '房间连接已失效，请重新加入',
      'info',
    )
  })

  test('lets a receiver leave the current room and return to join another one', async () => {
    const user = await enterRoom('receiver')
    emit({
      type: 'transfer:file-requested',
      peerId: sender.id,
      transferId: 'files-before-leave',
      files: [{
        fileId: 'file-before-leave',
        streamId: 19,
        name: '离开前.txt',
        mimeType: 'text/plain',
        byteLength: 1,
        lastModified: 1,
        chunkSize: 1024,
        chunkCount: 1,
      }],
    })

    await user.click(screen.getByRole('button', { name: '退出房间' }))

    expect(peerSession.rejectFiles).toHaveBeenCalledWith(sender.id, 'files-before-leave')
    expect(realtime.send).toHaveBeenLastCalledWith({
      type: 'room:leave',
      roomCode: room.code,
    })
    expect(realtime.close).toHaveBeenCalledTimes(1)
    expect(peerSession.close).toHaveBeenCalledTimes(1)
    expect(boundary.showToast).toHaveBeenCalledWith('已退出房间', 'info')
    expect(screen.queryByTestId('receiver-panel')).toBeNull()
    expect(screen.getByRole('button', { name: '请求加入测试房间' })).toBeTruthy()
  })

  test('closes the receiver room when the sender leaves terminally', async () => {
    await enterRoom('receiver')
    emit({
      type: 'transfer:file-requested',
      peerId: sender.id,
      transferId: 'file-before-sender-left',
      files: [{
        fileId: 'file-before-sender-left',
        streamId: 9,
        name: '未完成.txt',
        mimeType: 'text/plain',
        byteLength: 1,
        lastModified: 1,
        chunkSize: 1024,
        chunkCount: 1,
      }],
    })
    expect(screen.getByRole('dialog', { name: '收到文件' })).toBeTruthy()

    act(() => realtime.emitMessage({
      type: 'participant:left',
      roomCode: room.code,
      visitorId: sender.id,
    }))

    expect(realtime.close).toHaveBeenCalledTimes(1)
    expect(peerSession.close).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: '收到文件' })).toBeNull()
    expect(screen.getByRole('button', { name: '创建测试房间' })).toBeTruthy()
    expect(boundary.showToast).toHaveBeenCalledWith(
      '发送者已退出，房间自动关闭',
      'info',
    )
  })

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
    let now = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)

    try {
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

      emit(receivingProgress('files-receive', 'file-1', 0, 4))
      act(() => {
        const callback = frameCallbacks.get(1)
        frameCallbacks.delete(1)
        callback?.(0)
      })
      now += 1_000
      emit(receivingProgress('files-receive', 'file-1', 2, 4))
      act(() => {
        const callback = frameCallbacks.get(2)
        frameCallbacks.delete(2)
        callback?.(0)
      })
      expect(screen.getByTestId('incoming-file-speed').textContent).toBe('2')
      expect(screen.getByTestId('incoming-file-eta').textContent).toBe('1')

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
      expect(screen.getByTestId('incoming-file-speed').textContent).toBe('')
      expect(screen.getByTestId('incoming-file-eta').textContent).toBe('')
      await user.click(screen.getByRole('button', { name: '关闭文件弹窗' }))
      expect(revokeObjectUrl).toHaveBeenCalledTimes(1)
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test-1')
    } finally {
      nowSpy.mockRestore()
    }
  })

  test('tracks receiving progress independently per file without regressions', async () => {
    const user = await enterRoom('receiver')
    emit({
      type: 'transfer:file-requested',
      peerId: sender.id,
      transferId: 'files-progress',
      files: [
        {
          fileId: 'file-1',
          streamId: 11,
          name: '第一份.bin',
          mimeType: 'application/octet-stream',
          byteLength: 100,
          lastModified: 1,
          chunkSize: 1024,
          chunkCount: 1,
        },
        {
          fileId: 'file-2',
          streamId: 12,
          name: '第二份.bin',
          mimeType: 'application/octet-stream',
          byteLength: 100,
          lastModified: 1,
          chunkSize: 1024,
          chunkCount: 1,
        },
        {
          fileId: 'file-empty',
          streamId: 13,
          name: '空文件.txt',
          mimeType: 'text/plain',
          byteLength: 0,
          lastModified: 1,
          chunkSize: 1024,
          chunkCount: 0,
        },
      ],
    })

    await user.click(screen.getByRole('button', { name: '接收测试文件' }))
    expect(JSON.parse(screen.getByTestId('incoming-file-progress').textContent!)).toEqual({
      'file-1': 0,
      'file-2': 0,
      'file-empty': 1,
    })

    emit(receivingProgress('files-progress', 'file-1', 25, 100))
    emit(receivingProgress('files-progress', 'file-2', 75, 100))
    act(() => {
      const callback = frameCallbacks.get(1)
      frameCallbacks.delete(1)
      callback?.(0)
    })
    expect(JSON.parse(screen.getByTestId('incoming-file-progress').textContent!)).toEqual({
      'file-1': 0.25,
      'file-2': 0.75,
      'file-empty': 1,
    })

    emit(receivingProgress('files-progress', 'file-1', 10, 100))
    act(() => {
      const callback = frameCallbacks.get(2)
      frameCallbacks.delete(2)
      callback?.(0)
    })
    expect(JSON.parse(screen.getByTestId('incoming-file-progress').textContent!)).toMatchObject({
      'file-1': 0.25,
      'file-2': 0.75,
    })
  })

  test('clears incoming speed and ETA when the transfer fails and closes', async () => {
    let now = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)

    try {
      const user = await enterRoom('receiver')
      emit({
        type: 'transfer:file-requested',
        peerId: sender.id,
        transferId: 'files-speed-error',
        files: [{
          fileId: 'file-speed-error',
          streamId: 14,
          name: '中断.bin',
          mimeType: 'application/octet-stream',
          byteLength: 100,
          lastModified: 1,
          chunkSize: 1024,
          chunkCount: 1,
        }],
      })
      await user.click(screen.getByRole('button', { name: '接收测试文件' }))

      emit(receivingProgress('files-speed-error', 'file-speed-error', 0, 100))
      act(() => {
        const callback = frameCallbacks.get(1)
        frameCallbacks.delete(1)
        callback?.(0)
      })
      now += 1_000
      emit(receivingProgress('files-speed-error', 'file-speed-error', 50, 100))
      act(() => {
        const callback = frameCallbacks.get(2)
        frameCallbacks.delete(2)
        callback?.(0)
      })

      expect(screen.getByTestId('incoming-file-speed').textContent).toBe('50')
      expect(screen.getByTestId('incoming-file-eta').textContent).toBe('1')

      emit({
        type: 'transfer:terminal',
        peerId: sender.id,
        transferId: 'files-speed-error',
        outcome: 'failed',
      })

      expect(screen.getByTestId('file-dialog-status').textContent).toBe('error')
      expect(screen.getByTestId('incoming-file-speed').textContent).toBe('')
      expect(screen.getByTestId('incoming-file-eta').textContent).toBe('')

      await user.click(screen.getByRole('button', { name: '关闭文件弹窗' }))
      expect(screen.queryByRole('dialog', { name: '收到文件' })).toBeNull()
    } finally {
      nowSpy.mockRestore()
    }
  })

  test('cancels an active incoming batch and clears pending progress safely', async () => {
    const user = await enterRoom('receiver')
    emit({
      type: 'transfer:file-requested',
      peerId: sender.id,
      transferId: 'files-cancel',
      files: [{
        fileId: 'file-cancel',
        streamId: 14,
        name: '取消.bin',
        mimeType: 'application/octet-stream',
        byteLength: 100,
        lastModified: 1,
        chunkSize: 1024,
        chunkCount: 1,
      }],
    })

    await user.click(screen.getByRole('button', { name: '接收测试文件' }))
    emit(receivingProgress('files-cancel', 'file-cancel', 25, 100))
    expect(requestFrame).toHaveBeenCalledTimes(1)
    peerSession.cancelTransfer.mockImplementationOnce(transferId => {
      peerSession.emit({
        type: 'transfer:terminal',
        peerId: sender.id,
        transferId,
        outcome: 'cancelled',
      })
      return true
    })

    await user.click(screen.getByRole('button', { name: '取消测试接收' }))

    expect(peerSession.cancelTransfer).toHaveBeenCalledTimes(1)
    expect(peerSession.cancelTransfer).toHaveBeenCalledWith('files-cancel')
    expect(cancelFrame).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('file-dialog-status')).toBeNull()
    expect(screen.getByTestId('receiver-panel').textContent).toBe('waiting')
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

  test('keeps real multi-receiver progress and speed isolated through peer terminals', async () => {
    let now = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const roomWithTwoReceivers: PublicRoom = {
      ...room,
      receivers: [receiver.id, receiverTwo.id],
      participants: [
        ...room.participants,
        {
          visitor: receiverTwo,
          role: 'receiver',
          joinedAt: 1,
          status: 'online',
        },
      ],
    }
    boundary.createRoom.mockResolvedValueOnce({ room: roomWithTwoReceivers })
    peerSession.readyPeerIdList = [receiver.id, receiverTwo.id]
    peerSession.offerFiles.mockReturnValueOnce({
      transferId: 'files-1',
      peerIds: [receiver.id, receiverTwo.id],
      peerCount: 2,
      unsupportedPeerIds: [],
    })

    try {
      const user = await enterRoom('sender')
      expect(screen.getByTestId('transfer-panel').dataset.receiverIds).toBe(
        `${receiver.id},${receiverTwo.id}`,
      )
      await user.click(screen.getByRole('button', { name: '添加测试文件' }))
      await user.click(screen.getByRole('button', { name: '发送测试文件' }))
      const fileId = peerSession.offerFiles.mock.calls[0]?.[0][0]?.fileId
      expect(fileId).toBeTruthy()

      for (const peerId of [receiver.id, receiverTwo.id]) {
        emit({
          type: 'transfer:file-decision',
          peerId,
          transferId: 'files-1',
          decision: 'accept',
        })
        emit({
          type: 'transfer:file-progress',
          peerId,
          transferId: 'files-1',
          fileId: fileId!,
          direction: 'sending',
          fileBytes: 0,
          fileTotalBytes: 100,
          batchBytes: 0,
          batchTotalBytes: 100,
        })
      }
      act(() => {
        const callback = frameCallbacks.get(1)
        frameCallbacks.delete(1)
        callback?.(0)
      })

      now += 1_000
      for (const [peerId, fileBytes] of [[receiver.id, 20], [receiverTwo.id, 80]] as const) {
        emit({
          type: 'transfer:file-progress',
          peerId,
          transferId: 'files-1',
          fileId: fileId!,
          direction: 'sending',
          fileBytes,
          fileTotalBytes: 100,
          batchBytes: fileBytes,
          batchTotalBytes: 100,
        })
      }
      act(() => {
        const callback = frameCallbacks.get(2)
        frameCallbacks.delete(2)
        callback?.(0)
      })

      expect(screen.getByTestId('file-speed').textContent).toBe('20')
      expect(screen.getByTestId('file-eta').textContent).toBe('4')

      now += 1_000
      emit({
        type: 'transfer:file-progress',
        peerId: receiverTwo.id,
        transferId: 'files-1',
        fileId: fileId!,
        direction: 'sending',
        fileBytes: 90,
        fileTotalBytes: 100,
        batchBytes: 90,
        batchTotalBytes: 100,
      })
      expect(frameCallbacks.has(3)).toBe(true)

      emit({
        type: 'transfer:terminal',
        peerId: receiver.id,
        transferId: 'files-1',
        outcome: 'completed',
      })

      expect(frameCallbacks.has(3)).toBe(true)
      expect(screen.getByTestId('file-progress').textContent).toBe('0.8')
      expect(screen.getByTestId('file-speed').textContent).toBe('80')
      expect(screen.getByTestId('file-eta').textContent).toBe('0.25')

      act(() => {
        const callback = frameCallbacks.get(3)
        frameCallbacks.delete(3)
        callback?.(0)
      })
      expect(screen.getByTestId('file-progress').textContent).toBe('0.9')
      expect(screen.getByTestId('file-speed').textContent).not.toBe('')

      emit({
        type: 'transfer:terminal',
        peerId: receiverTwo.id,
        transferId: 'files-1',
        outcome: 'completed',
      })

      expect(screen.getByTestId('file-speed').textContent).toBe('')
      expect(screen.getByTestId('file-eta').textContent).toBe('')
    } finally {
      nowSpy.mockRestore()
    }
  })

  test('keeps a terminal result until dismiss and retries the original payload', async () => {
    const user = await enterRoom('sender')

    await user.click(screen.getByRole('button', { name: '发送测试文本' }))
    emit({
      type: 'transfer:terminal',
      peerId: receiver.id,
      transferId: 'text-1',
      outcome: 'completed',
    })
    expect(screen.getByTestId('activity-phase').textContent).toBe('complete')

    peerSession.offerText.mockReturnValueOnce({
      transferId: 'text-2',
      peerIds: [receiver.id],
      peerCount: 1,
      unsupportedPeerIds: [],
    })
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(screen.getByTestId('activity-phase').textContent).toBe('complete')

    await user.click(screen.getByRole('button', { name: '再次发送' }))
    expect(peerSession.offerText).toHaveBeenLastCalledWith('精确文本\n🙂', ['receiver'])
    expect(screen.getByTestId('activity-phase').textContent).toBe('transferring')

    emit({
      type: 'transfer:terminal',
      peerId: receiver.id,
      transferId: 'text-2',
      outcome: 'completed',
    })
    expect(screen.getByTestId('activity-phase').textContent).toBe('complete')
    await user.click(screen.getByRole('button', { name: '关闭结果' }))
    expect(screen.getByTestId('activity-phase').textContent).toBe('idle')
  })

  test('opens About from the lobby and closes it without changing the join flow', async () => {
    const user = userEvent.setup()
    render(<App initialNavigation={absentNavigation} />)

    await user.click(await screen.findByRole('button', {
      name: '关于 P2P Transmission',
    }))

    const dialog = screen.getByRole('dialog', {
      name: '关于 P2P Transmission',
    })
    expect(dialog.textContent).toContain('https://p2p.yxswy.com')
    expect(dialog.textContent).toContain('开发构建')

    await user.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', {
      name: '关于 P2P Transmission',
    })).toBeNull())
    expect(screen.getByRole('button', { name: '创建测试房间' })).not.toBeNull()
  })

  test('opens the same About dialog from the room toolbar', async () => {
    const user = await enterRoom('sender')

    await user.click(screen.getByRole('button', {
      name: '关于 P2P Transmission',
    }))

    const dialog = screen.getByRole('dialog', {
      name: '关于 P2P Transmission',
    })
    expect(dialog.textContent).toContain('不注册，不上传，直接把内容传给对方。')

    await user.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', {
      name: '关于 P2P Transmission',
    })).toBeNull())
    expect(screen.getByTestId('transfer-panel')).not.toBeNull()
  })

  test('wires room copy plus sender text, file, and cancel intents', async () => {
    const user = await enterRoom('sender')
    expect(screen.getAllByText('012345')).toHaveLength(1)
    expect(screen.getByTestId('room-code-copy-value').textContent).toBe('012345')
    await user.click(screen.getByRole('button', { name: '复制测试房间码' }))
    expect(clipboardWrite).toHaveBeenCalledWith('012345')
    expect(boundary.showToast).toHaveBeenCalledWith('房间码已复制', 'success')

    await user.click(screen.getByRole('button', { name: '发送测试文本' }))
    expect(peerSession.offerText).toHaveBeenCalledWith('精确文本\n🙂', ['receiver'])
    await user.click(screen.getByRole('button', { name: '取消测试传输' }))
    expect(peerSession.cancelTransfer).toHaveBeenCalledWith('text-1')
  })
})
