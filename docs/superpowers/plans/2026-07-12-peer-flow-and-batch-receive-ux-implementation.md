# Peer Flow and Batch Receive UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put an accurate, state-aware peer flow in the sender header, make the room code one copy target, bound long sender file lists, and improve the reliable whole-batch receiver flow.

**Architecture:** Replace count-only peer readiness with exact ready peer IDs, then derive the sender's connection count and avatars from one source. Keep transfer current transfer protocol unchanged. Reuse `TransferPeerFlow` and `FileTransferRow` across stable sender and receiver states, while `App` continues to own peer-session orchestration and Blob URL cleanup.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS 4, Vitest, Testing Library, Bun, Vite, WebRTC DataChannel.

## Global Constraints

- File transfer remains whole-batch accept or reject under current transfer protocol.
- Selective transfer, ZIP generation, directory-picker integration, and automatic multi-file download remain out of scope.
- Only the `transferring` phase animates the peer connector.
- No ready receiver means sender avatar only; a ready receiver adds a neutral line; active transfer replaces the line with accent dots.
- The connection label and peer flow remain on one horizontal line at every viewport.
- At most three receiver avatars are visible before the `+n` overflow indicator.
- The room number and copy icon are one exact-once, borderless copy button.
- Sender file rows scroll inside a 13 rem maximum height, 14 rem from `sm` upward; `添加更多文件` remains outside the scroll region.
- Receiver pending actions use a one-third Reject and two-thirds `接收全部` layout.
- Receiving exposes one `取消接收` action; completed files expose individual native download links.
- All interaction targets remain at least 44 by 44 px.
- Existing text/file limits, validation, chunking, receipts, TURN behavior, timers, progress monotonicity, and Blob URL ownership remain unchanged.

---

### Task 1: Track Exact Ready Peer Identities

**Files:**
- Modify: `apps/web/src/features/transfer/peer-session.ts`
- Modify: `apps/web/src/features/transfer/peer-session.test.ts`
- Modify: `apps/web/src/features/room/state.ts`
- Modify: `apps/web/src/features/room/state.test.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: the existing internal `readyEntries()` ordering and `peer:state` events.
- Produces:

```ts
export type PeerSession = {
  syncRoom(room: PublicRoom): void
  handleSignal(message: SignalServerMessage): Promise<void>
  offerText(text: string): TransferOfferResult
  acknowledgeText(peerId: string, transferId: string): boolean
  discardText(peerId: string, transferId: string): boolean
  offerFiles(files: readonly FileSelection[]): TransferOfferResult
  acceptFiles(peerId: string, transferId: string): boolean
  rejectFiles(peerId: string, transferId: string): boolean
  cancelTransfer(transferId: string): boolean
  readyPeerIds(): readonly string[]
  subscribe(listener: (event: PeerSessionEvent) => void): () => void
  close(): void
}
```

```ts
export type RoomFlowState = {
  phase: RoomPhase
  session?: VisitorSession
  room?: PublicRoom
  role?: ParticipantRole
  readyPeerIds: readonly string[]
  error: string
}
```

- [ ] **Step 1: Write a failing peer-session identity test**

Add this test after the existing generation/channel test in `peer-session.test.ts`:

```ts
test('returns exact ready peer IDs in room order and removes closed peers', async () => {
  const first = new FakePeerConnection()
  const second = new FakePeerConnection()
  const receiverTwo = {
    ...receiver,
    id: 'vis_receiver_2',
    avatarSeed: 'receiver-2',
    displayName: '接收者二',
  }
  const { session } = senderHarness([first, second])
  session.syncRoom(room([receiver, receiverTwo]))
  await settle()

  const firstChannel = first.channels[0] as FakeDataChannel
  const secondChannel = second.channels[0] as FakeDataChannel
  expect(session.readyPeerIds()).toEqual([])

  secondChannel.open()
  expect(session.readyPeerIds()).toEqual([receiverTwo.id])

  firstChannel.open()
  const snapshot = session.readyPeerIds()
  expect(snapshot).toEqual([receiver.id, receiverTwo.id])
  expect(session.readyPeerIds()).not.toBe(snapshot)

  firstChannel.close()
  expect(session.readyPeerIds()).toEqual([receiverTwo.id])

  session.close()
  expect(session.readyPeerIds()).toEqual([])
})
```

- [ ] **Step 2: Replace count-based room-state tests with identity tests**

Replace the current readiness test with:

```ts
test('peer readiness IDs control the phase and are copied and deduplicated', () => {
  const peerIds = ['vis_2', 'vis_3', 'vis_2']
  const readyState = roomFlowReducer({
    ...initialRoomFlowState,
    phase: 'connecting',
    room,
    role: 'sender',
    session: visitorSession,
  }, { type: 'peer:ready-ids', peerIds })
  peerIds.length = 0

  expect(readyState.phase).toBe('ready')
  expect(readyState.readyPeerIds).toEqual(['vis_2', 'vis_3'])

  const connectingState = roomFlowReducer(readyState, {
    type: 'peer:ready-ids',
    peerIds: [],
  })
  expect(connectingState.phase).toBe('connecting')
  expect(connectingState.readyPeerIds).toEqual([])
})
```

Update every remaining state fixture with the following exact field mapping:

```ts
readyPeerIds: ['vis_2']
```

```ts
expect(state.readyPeerIds).toEqual([])
```

The participant-left test must retain `['vis_2']`, because membership updates do not guess DataChannel state. The realtime-disconnect test must clear to `[]`.

- [ ] **Step 3: Run the focused tests and verify the red state**

Run:

```bash
bun run --cwd apps/web test -- src/features/transfer/peer-session.test.ts src/features/room/state.test.ts
```

Expected: FAIL because `readyPeerIds()` and the `peer:ready-ids` action do not exist.

- [ ] **Step 4: Implement `readyPeerIds()` and remove the count-only query**

Replace `readyPeerCount()` in the public type and returned session object with:

```ts
readyPeerIds() {
  return readyEntries().map(entry => entry.peerId)
},
```

The method returns a new ordered snapshot each time. Do not expose the internal `Map` or a mutable shared array.

- [ ] **Step 5: Migrate the room reducer to ready peer IDs**

Use these exact types and phase derivation:

```ts
export type RoomFlowState = {
  phase: RoomPhase
  session?: VisitorSession
  room?: PublicRoom
  role?: ParticipantRole
  readyPeerIds: readonly string[]
  error: string
}

export type RoomFlowAction =
  | { type: 'visitor:ready'; session: VisitorSession }
  | { type: 'room:joining' }
  | { type: 'room:created'; room: PublicRoom }
  | { type: 'room:joined'; room: PublicRoom }
  | { type: 'realtime:connected' }
  | { type: 'realtime:disconnected' }
  | { type: 'peer:ready-ids'; peerIds: readonly string[] }
  | { type: 'server:message'; message: ServerRealtimeMessage }
  | { type: 'error'; message: string }

export const initialRoomFlowState: RoomFlowState = {
  phase: 'booting',
  readyPeerIds: [],
  error: '',
}

const readyPhaseFor = (readyPeerIds: readonly string[]): RoomPhase =>
  readyPeerIds.length > 0 ? 'ready' : 'connecting'
```

Replace every reset occurrence of `readyPeerCount: 0` in the visitor-ready, room-joining, room-created, room-joined, realtime-connected, and realtime-disconnected branches with:

```ts
readyPeerIds: [],
```

Replace the old count action branch with:

```ts
if (action.type === 'peer:ready-ids') {
  const readyPeerIds = Array.from(new Set(action.peerIds))

  return {
    ...state,
    phase: readyPhaseFor(readyPeerIds),
    readyPeerIds,
    error: '',
  }
}
```

- [ ] **Step 6: Wire `App` to identity snapshots without changing `TransferPanel` yet**

Change the peer event dispatch:

```tsx
if (event.type === 'peer:state') {
  dispatch({
    type: 'peer:ready-ids',
    peerIds: peerSession.readyPeerIds(),
  })
```

For this task, keep the existing `TransferPanel` API compiling by deriving its count:

```tsx
readyPeerCount={state.readyPeerIds.length}
```

Change the page connection copy to:

```tsx
{state.readyPeerIds.length > 0 ? '点对点已连接' : '正在建立点对点连接'}
```

Update `FakePeerSession` in `App.test.tsx`:

```ts
readonly readyPeerIds = vi.fn((): readonly string[] => [receiver.id])
```

Delete its `readyPeerCount` fake. Add `readyPeerCount: number` to `MockTransferPanelProps`, expose it as `data-ready-peer-count`, and assert after `enterRoom('sender')`:

```tsx
expect(screen.getByTestId('transfer-panel').getAttribute('data-ready-peer-count'))
  .toBe('1')
```

- [ ] **Step 7: Run identity tests and static checks**

Run:

```bash
bun run --cwd apps/web test -- src/features/transfer/peer-session.test.ts src/features/room/state.test.ts src/App.test.tsx
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
```

Expected: all tests pass; typecheck and lint have no warnings or errors.

- [ ] **Step 8: Commit the identity migration**

```bash
git add apps/web/src/features/transfer/peer-session.ts apps/web/src/features/transfer/peer-session.test.ts apps/web/src/features/room/state.ts apps/web/src/features/room/state.test.ts apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "refactor: track ready peer identities"
```

---

### Task 2: Make Peer Flow Static Until Transfer

**Files:**
- Modify: `apps/web/src/components/TransferPeerFlow.tsx`
- Modify: `apps/web/src/components/TransferPeerFlow.test.tsx`

**Interfaces:**
- Consumes: existing `TransferPeerFlowProps` and exact ready/active receiver arrays supplied by callers.
- Produces: the same public props, sender-only idle rendering, neutral `.transfer-peer-flow__line`, and animated `.transfer-peer-flow__dot` nodes only for `phase="transferring"`.

- [ ] **Step 1: Write failing sender-only and connector-state tests**

Add these tests using the existing `createVisitor` fixture:

```tsx
test('renders only the sender when no receiver is connected', () => {
  const sender = createVisitor('sender', 'Sender')
  render(
    <TransferPeerFlow
      sender={sender}
      receivers={[]}
      phase="idle"
      accessibleLabel="等待接收者连接"
    />,
  )

  const status = screen.getByRole('status', { name: '等待接收者连接' })
  expect(screen.getByTitle('Sender')).not.toBeNull()
  expect(status.querySelector('.transfer-peer-flow__line')).toBeNull()
  expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(0)
  expect(status.getAttribute('data-active')).toBe('false')
})

test('uses a static line except while transferring', () => {
  const sender = createVisitor('sender', 'Sender')
  const receiver = createVisitor('receiver', 'Receiver')
  const { rerender } = render(
    <TransferPeerFlow
      sender={sender}
      receivers={[receiver]}
      phase="requesting"
      accessibleLabel="等待接收确认"
    />,
  )

  const status = screen.getByRole('status')
  expect(status.getAttribute('data-active')).toBe('false')
  expect(status.querySelector('.transfer-peer-flow__line')).not.toBeNull()
  expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(0)

  rerender(
    <TransferPeerFlow
      sender={sender}
      receivers={[receiver]}
      phase="transferring"
      accessibleLabel="正在传输"
    />,
  )

  expect(status.getAttribute('data-active')).toBe('true')
  expect(status.querySelector('.transfer-peer-flow__line')).toBeNull()
  expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(3)
})
```

Update the overflow assertions to:

```tsx
expect(screen.getByTitle('Receiver 1').textContent).toBe('R1')
expect(screen.getByTitle('Receiver 3').textContent).toBe('R3')
expect(screen.queryByTitle('Receiver 4')).toBeNull()
expect(screen.getByText('+3').textContent).toBe('+3')
```

- [ ] **Step 2: Run the component test and verify it fails**

```bash
bun run --cwd apps/web test -- src/components/TransferPeerFlow.test.tsx
```

Expected: FAIL because idle/requesting still render dots and four receivers remain visible.

- [ ] **Step 3: Implement the sender-only, line, and transfer-dot states**

Replace the component with:

```tsx
import type { PublicVisitor } from '../shared/contracts'
import Avatar from './Avatar'

export type TransferPeerFlowPhase =
  | 'idle'
  | 'requesting'
  | 'transferring'
  | 'complete'
  | 'error'

export type TransferPeerFlowProps = {
  sender: PublicVisitor
  receivers: PublicVisitor[]
  phase: TransferPeerFlowPhase
  accessibleLabel: string
}

const MAX_VISIBLE_RECEIVERS = 3

export default function TransferPeerFlow({
  sender,
  receivers,
  phase,
  accessibleLabel,
}: TransferPeerFlowProps) {
  const visibleReceivers = receivers.slice(0, MAX_VISIBLE_RECEIVERS)
  const overflow = Math.max(0, receivers.length - visibleReceivers.length)
  const active = phase === 'transferring'
  const hasReceivers = visibleReceivers.length > 0

  return (
    <div
      className="transfer-peer-flow flex min-w-0 items-center gap-3"
      data-active={active ? 'true' : 'false'}
      data-phase={phase}
      role="status"
      aria-label={accessibleLabel}
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="flex min-w-0 items-center gap-3" aria-hidden="true">
        <Avatar
          seed={sender.avatarSeed}
          label={sender.displayName}
          className="shrink-0"
        />

        {hasReceivers && (
          <>
            <span className="flex w-8 shrink-0 items-center justify-center">
              {active ? (
                <span className="flex items-center gap-1.5">
                  <span className="transfer-peer-flow__dot size-1 rounded-full bg-accent" />
                  <span className="transfer-peer-flow__dot size-1 rounded-full bg-accent" />
                  <span className="transfer-peer-flow__dot size-1 rounded-full bg-accent" />
                </span>
              ) : (
                <span className="transfer-peer-flow__line h-px w-full bg-amber-50/20" />
              )}
            </span>

            <span className="flex min-w-0 items-center">
              {visibleReceivers.map((receiver, index) => (
                <Avatar
                  key={receiver.id}
                  seed={receiver.avatarSeed}
                  label={receiver.displayName}
                  className={`shrink-0 ${index === 0 ? '' : '-ml-2'}`}
                />
              ))}
              {overflow > 0 && (
                <span className="-ml-2 flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-[#2d2d2d] bg-white/10 text-[11px] tabular-nums text-amber-50/70">
                  +{overflow}
                </span>
              )}
            </span>
          </>
        )}
      </div>
    </div>
  )
}
```

Keep the existing `dot-wave`, active-dot selectors, and reduced-motion rule in `index.css`; they already animate only nodes under `data-active="true"`.

- [ ] **Step 4: Run flow tests and static checks**

```bash
bun run --cwd apps/web test -- src/components/TransferPeerFlow.test.tsx
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
```

Expected: all commands pass.

- [ ] **Step 5: Commit the peer-flow behavior**

```bash
git add apps/web/src/components/TransferPeerFlow.tsx apps/web/src/components/TransferPeerFlow.test.tsx
git commit -m "feat: show connected peer flow in stable states"
```

---

### Task 3: Make the Room Code One Copy Target

**Files:**
- Modify: `apps/web/src/components/RoomCodeCopyButton.tsx`
- Modify: `apps/web/src/components/RoomCodeCopyButton.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes and preserves:

```ts
export type RoomCodeCopyButtonProps = {
  code: string
  onCopy(code: string): Promise<void>
}
```

- Produces: one button containing both the visible room code and static `content_copy` icon.

- [ ] **Step 1: Write a failing composite-control test**

Import `within` and add:

```tsx
test('makes the code and icon one exact-once copy target', async () => {
  const user = userEvent.setup()
  const onCopy = vi.fn(async () => undefined)
  render(<RoomCodeCopyButton code="012345" onCopy={onCopy} />)

  const button = screen.getByRole('button', { name: '复制房间码' })
  const code = within(button).getByText('012345')
  const icon = within(button).getByText('content_copy')

  expect(button.className).toContain('min-h-11')
  expect(button.className).toContain('group')
  expect(icon.parentElement?.className).toContain('rounded-full')

  await user.click(code)
  await waitFor(() => expect(button.getAttribute('data-status')).toBe('copied'))
  expect(onCopy).toHaveBeenLastCalledWith('012345')

  await user.click(icon)
  expect(onCopy).toHaveBeenCalledTimes(2)
})
```

Update the existing deferred-copy test to retain a stable icon reference without asserting the complete button text:

```tsx
const button = screen.getByRole('button', { name: '复制房间码' })
const icon = within(button).getByText('content_copy')
expect(icon.parentElement?.className).toContain('rounded-full')

await user.click(button)
expect(button.getAttribute('data-status')).toBe('copying')
expect(within(button).getByText('content_copy')).toBe(icon)

resolveCopy?.()
await waitFor(() => expect(button.getAttribute('data-status')).toBe('copied'))
expect(within(button).getByText('content_copy')).toBe(icon)
```

In the rejected-copy test, query `within(button).getByText('content_copy')`, assert `data-status="error"`, keep the stable `复制房间码` accessible name, and keep the exact `无法复制房间码` live announcement. Remove the old outer-button `rounded-full`, `hover:bg-white/5`, `focus-visible:bg-white/5`, and complete `textContent === 'content_copy'` assertions; the composite test now verifies those visual rules on the icon container.

- [ ] **Step 2: Run the copy-button test and verify it fails**

```bash
bun run --cwd apps/web test -- src/components/RoomCodeCopyButton.test.tsx
```

Expected: FAIL because the visible room code is outside the icon-only component.

- [ ] **Step 3: Render the room code and icon inside one button**

Keep the existing status machine and replace only the JSX with:

```tsx
return (
  <>
    <button
      type="button"
      className="group flex min-h-11 cursor-pointer items-center rounded-xl bg-transparent text-amber-50/50 focus-visible:outline-none disabled:cursor-wait"
      aria-label="复制房间码"
      data-status={status}
      disabled={status === 'copying'}
      onClick={() => { void handleCopy() }}
    >
      <span className="font-mono text-xl tracking-[0.2em] text-amber-50/80 tabular-nums transition-colors group-hover:text-amber-50 group-focus-visible:text-amber-50">
        {code}
      </span>
      <span className="ml-2 flex size-11 shrink-0 items-center justify-center rounded-full transition-colors group-hover:bg-white/5 group-hover:text-amber-50/80 group-focus-visible:bg-white/5 group-focus-visible:text-amber-50/80 group-disabled:bg-transparent group-disabled:text-amber-50/20">
        <span
          className="material-symbols-outlined"
          style={{ fontSize: '17px' }}
          aria-hidden="true"
        >
          content_copy
        </span>
      </span>
    </button>
    <span className="sr-only" aria-live="polite" aria-atomic="true">
      {statusAnnouncement[status]}
    </span>
  </>
)
```

- [ ] **Step 4: Remove the duplicate App room-code node**

Replace the room-code block with:

```tsx
<div>
  <div className="text-xs text-amber-50/50">房间码</div>
  <div className="mt-1">
    <RoomCodeCopyButton
      code={roomView.room.code}
      onCopy={handleCopyRoomCode}
    />
  </div>
</div>
```

Update the App test mock so it renders the passed code exactly once:

```tsx
vi.mock('./components/RoomCodeCopyButton', () => ({
  default: ({
    code,
    onCopy,
  }: {
    code: string
    onCopy(code: string): Promise<void>
  }) => (
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
```

Extend the existing room-copy integration assertion:

```tsx
expect(screen.getAllByText('012345')).toHaveLength(1)
await user.click(screen.getByRole('button', { name: '复制测试房间码' }))
expect(clipboardWrite).toHaveBeenCalledWith('012345')
```

- [ ] **Step 5: Run copy and App tests**

```bash
bun run --cwd apps/web test -- src/components/RoomCodeCopyButton.test.tsx src/App.test.tsx
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
```

Expected: all commands pass.

- [ ] **Step 6: Commit the composite copy control**

```bash
git add apps/web/src/components/RoomCodeCopyButton.tsx apps/web/src/components/RoomCodeCopyButton.test.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat: make room code fully copyable"
```

---

### Task 4: Integrate Peer Flow and Bound the Sender File List

**Files:**
- Modify: `apps/web/src/components/FileTransferRow.tsx`
- Modify: `apps/web/src/components/FileTransferRow.test.tsx`
- Modify: `apps/web/src/components/TransferPanel.tsx`
- Modify: `apps/web/src/components/TransferPanel.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `RoomFlowState.readyPeerIds`, `TransferPeerFlow`, `OutgoingActivity.peerIds`, and the existing file-selection callbacks.
- Produces:

```ts
export type TransferPanelProps = {
  visitor: PublicVisitor
  receivers: PublicVisitor[]
  activity?: OutgoingActivity
  files: FileSelection[]
  selectionError: string
  onFilesAdded(files: readonly File[]): void
  onFileRemoved(fileId: string): void
  onSendText(text: string): Promise<void>
  onSendFiles(): Promise<void>
  onCancel(): void
}
```

- [ ] **Step 1: Write failing FileTransferRow action-slot tests**

Extend the optional-action test:

```tsx
const content = screen.getByTestId('file-transfer-content-file-1')
const actionSlot = screen.getByTestId('file-transfer-action-file-1')

expect(content.className).toContain('min-h-11')
expect(content.className).toContain('pr-14')
expect(actionSlot.className).toContain('absolute')
expect(actionSlot.className).toContain('inset-y-0')
expect(actionSlot.className).toContain('right-0')

rerender(<FileTransferRow {...baseProps} action={undefined} />)
expect(screen.queryByTestId('file-transfer-action-file-1')).toBeNull()
expect(screen.getByTestId('file-transfer-content-file-1').className)
  .toContain('pr-3')
```

- [ ] **Step 2: Write failing sender-header and bounded-list tests**

Delete the `PublicRoom` import, room fixture, `room`, and `readyPeerCount` from `createProps` after changing the component API. Add:

```tsx
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

test('keeps connected status and active peer flow beside the tabs', () => {
  const initialProps = createProps({ receivers: [] })
  const { rerender } = render(<TransferPanel {...initialProps} />)

  expect(screen.getByText('等待接收者连接')).not.toBeNull()
  expect(screen.getByTitle(sender.displayName)).not.toBeNull()
  expect(screen.queryByTitle(receiverOne.displayName)).toBeNull()
  expect(screen.queryByText(/房间 012345/u)).toBeNull()

  rerender(
    <TransferPanel
      {...initialProps}
      receivers={[receiverOne, receiverTwo]}
    />,
  )
  expect(screen.getByText('2 位接收者已连接')).not.toBeNull()
  expect(screen.getByTitle(receiverOne.displayName)).not.toBeNull()
  expect(screen.getByRole('status').querySelector('.transfer-peer-flow__line'))
    .not.toBeNull()

  rerender(
    <TransferPanel
      {...initialProps}
      receivers={[receiverOne, receiverTwo]}
      activity={createActiveTextTransfer()}
    />,
  )
  expect(screen.queryByTitle(receiverOne.displayName)).toBeNull()
  expect(screen.getByTitle(receiverTwo.displayName)).not.toBeNull()
  expect(screen.getByRole('status').getAttribute('data-active')).toBe('true')
})

test('bounds ten selected rows while keeping Add more outside the scroller', async () => {
  const user = userEvent.setup()
  const files = Array.from({ length: 10 }, (_, index) =>
    createSelection(
      `file-${String(index)}`,
      new File(['body'], `file-${String(index)}.txt`),
    ))

  render(<TransferPanel {...createProps({ files })} />)
  await user.click(screen.getByRole('tab', { name: '传输文件' }))

  const scroll = screen.getByTestId('selected-file-scroll')
  expect(scroll.className).toContain('native-scrollbar')
  expect(scroll.className).toContain('max-h-52')
  expect(scroll.className).toContain('sm:max-h-56')
  expect(scroll.className).toContain('overflow-y-auto')
  expect(scroll.className).toContain('overscroll-contain')
  expect(screen.getAllByTestId(/^file-transfer-row-/u)).toHaveLength(10)

  const addMore = screen.getByRole('button', { name: '添加更多文件' })
  expect(scroll.contains(addMore)).toBe(false)
})
```

- [ ] **Step 3: Run row and panel tests and verify they fail**

```bash
bun run --cwd apps/web test -- src/components/FileTransferRow.test.tsx src/components/TransferPanel.test.tsx
```

Expected: FAIL because the action is still in normal flow, the panel still owns a room/count prop, the flow is not persistent, and the selected list is unbounded.

- [ ] **Step 4: Position FileTransferRow actions without changing row geometry**

Replace the content wrapper and trailing action placement with:

```tsx
<div
  data-testid={`file-transfer-content-${fileId}`}
  className={`relative z-10 flex min-h-11 items-center gap-3 py-2 pl-3 ${
    action ? 'pr-14' : 'pr-3'
  }`}
>
  <span
    className="material-symbols-outlined shrink-0 text-amber-50/40"
    style={{ fontSize: '16px' }}
    aria-hidden="true"
  >
    description
  </span>
  <span
    className="min-w-0 flex-1 truncate text-xs text-amber-50/75"
    title={name}
  >
    {name}
  </span>
  <span className="shrink-0 text-xs tabular-nums text-amber-50/50">
    {formatSize(byteLength)}
  </span>
  <span className="w-16 shrink-0 text-right text-xs tabular-nums text-amber-50/60">
    {label}
  </span>
</div>
{action && (
  <div
    data-testid={`file-transfer-action-${fileId}`}
    className="absolute inset-y-0 right-0 z-20 flex items-center"
  >
    {action}
  </div>
)}
```

Delete the previous in-flow `{action}`.

- [ ] **Step 5: Replace TransferPanel count/room props with ready receivers**

Remove `PublicRoom` and `Avatar` imports, remove `room` and `readyPeerCount` from the public props, and derive:

```tsx
const connectedCount = receivers.length
const locked = isTransferLocked({ activity }) || submitting
const activePeerIds = new Set(activity?.peerIds ?? [])
const flowReceivers = activity
  ? receivers.filter(receiver => activePeerIds.has(receiver.id))
  : receivers
const connectedLabel = connectedCount > 0
  ? `${String(connectedCount)} 位接收者已连接`
  : '等待接收者连接'
const flowPhase = activity?.phase ?? 'idle'
```

Keep the existing activity wording, but only evaluate it when an activity exists:

```tsx
const flowLabel = activity
  ? activity.kind === 'file'
    ? activity.phase === 'requesting'
      ? '正在等待接收方确认文件'
      : activity.phase === 'transferring'
        ? '正在传输文件'
        : activity.phase === 'complete'
          ? '文件传输完成'
          : '文件传输结束，但有接收方未完成'
    : activity.phase === 'complete'
      ? '文本传输完成'
      : activity.phase === 'error'
        ? '文本传输结束，但有接收方未完成'
        : '正在传输文本'
  : connectedLabel
```

Use `flowLabel` for the terminal transfer button label as well.

Replace the top area with:

```tsx
<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
  <div
    className="flex w-full rounded-xl bg-white/5 p-1 sm:w-auto"
    role="tablist"
    aria-label="传输类型"
  >
    <button
      ref={textTabRef}
      id={`${tabId}-text-tab`}
      type="button"
      role="tab"
      aria-selected={tab === 'text'}
      aria-controls={`${tabId}-text-panel`}
      tabIndex={tab === 'text' ? 0 : -1}
      disabled={locked}
      className={`min-h-11 flex-1 rounded-lg border border-transparent px-4 text-sm transition-colors focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed sm:flex-none ${
        tab === 'text'
          ? 'bg-white/10 text-amber-50/80'
          : 'text-amber-50/60 hover:text-amber-50/80'
      }`}
      onClick={() => selectTab('text')}
      onKeyDown={handleTabKeyDown}
    >
      传输文本
    </button>
    <button
      ref={fileTabRef}
      id={`${tabId}-file-tab`}
      type="button"
      role="tab"
      aria-selected={tab === 'file'}
      aria-controls={`${tabId}-file-panel`}
      tabIndex={tab === 'file' ? 0 : -1}
      disabled={locked}
      className={`min-h-11 flex-1 rounded-lg border border-transparent px-4 text-sm transition-colors focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed sm:flex-none ${
        tab === 'file'
          ? 'bg-white/10 text-amber-50/80'
          : 'text-amber-50/60 hover:text-amber-50/80'
      }`}
      onClick={() => selectTab('file')}
      onKeyDown={handleTabKeyDown}
    >
      传输文件
    </button>
  </div>

  <div className="flex w-full min-w-0 items-center justify-between gap-3 sm:w-auto sm:justify-end">
    <div className="shrink-0 text-xs tabular-nums text-amber-50/60">
      {connectedLabel}
    </div>
    <TransferPeerFlow
      sender={visitor}
      receivers={flowReceivers}
      phase={flowPhase}
      accessibleLabel={flowLabel}
    />
  </div>
</div>
```

Delete the duplicated `房间 {room.code}` text and delete the complete conditional activity block that currently renders the standalone rounded peer-flow card below the header.

- [ ] **Step 6: Bound only the selected file rows**

Inside the non-empty file branch, use:

```tsx
<div className="flex flex-1 flex-col gap-2" onClick={event => event.stopPropagation()}>
  <div
    data-testid="selected-file-scroll"
    className="native-scrollbar max-h-52 space-y-2 overflow-y-auto overscroll-contain pr-1 sm:max-h-56"
  >
    {files.map(selection => {
      const presentation = activity?.files[selection.fileId]
      const progress = presentation
        ? presentation.state === 'error'
          ? terminalErrorProgress(activity, selection.fileId)
          : aggregateFileProgress(activity, selection.fileId)
        : 0
      const state = presentation?.state ?? 'queued'

      return (
        <FileTransferRow
          key={selection.fileId}
          fileId={selection.fileId}
          name={selection.file.name}
          byteLength={selection.file.size}
          progress={progress}
          state={state}
          action={!locked ? (
            <button
              type="button"
              className="flex size-11 shrink-0 items-center justify-center rounded-full text-amber-50/50 transition-colors hover:bg-white/5 hover:text-amber-50 focus-visible:bg-white/5 focus-visible:text-amber-50 focus-visible:outline-none"
              onClick={event => {
                event.stopPropagation()
                onFileRemoved(selection.fileId)
              }}
              aria-label={`移除 ${selection.file.name}`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }} aria-hidden="true">close</span>
            </button>
          ) : undefined}
        />
      )
    })}
  </div>

  {!locked && (
    <button
      type="button"
      className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-transparent text-xs text-amber-50/60 transition-colors hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
      onClick={event => {
        event.stopPropagation()
        fileInputRef.current?.click()
      }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: '16px' }} aria-hidden="true">add</span>
      添加更多文件
    </button>
  )}
</div>
```

- [ ] **Step 7: Map ready IDs to visitors in App**

Replace the transfer-specific receiver branch with:

```tsx
const roomReceivers = receiversFromRoom(roomView?.room)
const readyPeerIds = new Set(state.readyPeerIds)
const connectedReceivers = roomReceivers.filter(receiver =>
  readyPeerIds.has(receiver.id))
```

Render:

```tsx
<TransferPanel
  visitor={roomView.session.visitor}
  receivers={connectedReceivers}
  activity={transferUiState.activity}
  files={fileSelections}
  selectionError={selectionError}
  onFilesAdded={handleFilesAdded}
  onFileRemoved={handleFileRemoved}
  onSendText={handleSendText}
  onSendFiles={handleSendFiles}
  onCancel={handleCancelTransfer}
/>
```

Remove `room` and `readyPeerCount` from the call.

In `App.test.tsx`, replace the count attribute in `MockTransferPanelProps` with:

```tsx
receivers: PublicVisitor[]
```

Expose:

```tsx
data-receiver-ids={props.receivers.map(receiver => receiver.id).join(',')}
```

Add this fixture beside the existing receiver:

```ts
const receiverTwo = visitor('receiver-2', '接收者二')
```

Add this App integration test:

```tsx
test('passes only exact ready receiver identities to the sender panel', async () => {
  const twoReceiverRoom: PublicRoom = {
    ...room,
    receivers: [receiver.id, receiverTwo.id],
    participants: [
      ...room.participants,
      {
        visitor: receiverTwo,
        role: 'receiver',
        joinedAt: 2,
        status: 'online',
      },
    ],
  }
  boundary.createRoom.mockResolvedValueOnce({ room: twoReceiverRoom })
  peerSession.readyPeerIds.mockReturnValue([receiverTwo.id])

  await enterRoom('sender')

  expect(screen.getByTestId('transfer-panel').getAttribute('data-receiver-ids'))
    .toBe(receiverTwo.id)
})
```

- [ ] **Step 8: Run sender and App tests**

```bash
bun run --cwd apps/web test -- src/components/TransferPeerFlow.test.tsx src/components/FileTransferRow.test.tsx src/components/TransferPanel.test.tsx src/App.test.tsx
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
```

Expected: all commands pass; the panel has no repeated room code and ten rows remain inside the bounded scroller.

- [ ] **Step 9: Commit sender integration**

```bash
git add apps/web/src/components/FileTransferRow.tsx apps/web/src/components/FileTransferRow.test.tsx apps/web/src/components/TransferPanel.tsx apps/web/src/components/TransferPanel.test.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat: integrate peer flow into sender header"
```

---

### Task 5: Improve Whole-Batch Receiver Consent and Downloads

**Files:**
- Modify: `apps/web/src/components/IncomingFileRequestDialog.tsx`
- Modify: `apps/web/src/components/IncomingFileRequestDialog.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: the existing batch-only `acceptFiles`, `rejectFiles`, `cancelTransfer`, `DownloadableReceivedFile`, and `FileTransferRow`.
- Produces:

```ts
export type IncomingFileRequestDialogProps = {
  sender: PublicVisitor
  files: readonly IncomingFileRequestItem[]
  state: IncomingFileRequestDialogState
  onAccept(): void
  onReject(): void
  onCancel(): void
  onClose(): void
}
```

- [ ] **Step 1: Write failing receiver action and completed-row tests**

Add `onCancel` to the callback fixture:

```ts
const callbacks = () => ({
  onAccept: vi.fn(),
  onReject: vi.fn(),
  onCancel: vi.fn(),
  onClose: vi.fn(),
})
```

Extend the pending test:

```tsx
const accept = screen.getByRole('button', { name: '接收全部' })
expect(accept.parentElement?.className)
  .toContain('grid-cols-[minmax(0,1fr)_minmax(0,2fr)]')
```

Replace every real-dialog query whose accessible name is `接收` with `接收全部`. The mocked App dialog keeps its test-only `接收测试文件` label.

Replace disabled receiving-button assertions with:

```tsx
const cancel = screen.getByRole('button', { name: '取消接收' })
expect(screen.queryByRole('button', { name: '拒绝' })).toBeNull()
expect(screen.queryByRole('button', { name: '接收全部' })).toBeNull()

fireEvent.click(cancel)
fireEvent.click(cancel)
expect(actions.onCancel).toHaveBeenCalledTimes(1)
```

Replace the old `保存` link assertions in the received test with the shared row and native download assertions:

```tsx
expect(screen.getByTestId('file-transfer-row-file-1')).not.toBeNull()
expect(
  screen.getByRole('progressbar', { name: '设计稿.png 传输进度' })
    .getAttribute('aria-valuenow'),
).toBe('100')

const download = screen.getByRole('link', { name: '下载 设计稿.png' })
expect(download.getAttribute('href')).toBe('blob:file-1')
expect(download.getAttribute('download')).toBe('设计稿.png')
```

Add this complete receiving Escape test:

```tsx
test('Escape cancels receiving exactly once', () => {
  const actions = callbacks()
  render(
    <IncomingFileRequestDialog
      sender={sender}
      files={files}
      state={{
        status: 'receiving',
        progressByFileId: { 'file-1': 0.25, 'file-2': 0 },
      }}
      {...actions}
    />,
  )

  const dialog = screen.getByRole('dialog')
  fireEvent(dialog, new Event('cancel', { cancelable: true }))
  fireEvent(dialog, new Event('cancel', { cancelable: true }))

  expect(actions.onCancel).toHaveBeenCalledTimes(1)
  expect(actions.onReject).not.toHaveBeenCalled()
  expect(actions.onClose).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the dialog test and verify it fails**

```bash
bun run --cwd apps/web test -- src/components/IncomingFileRequestDialog.test.tsx
```

Expected: FAIL because there is no cancel callback, the buttons remain equal width, and received files use the separate Save list.

- [ ] **Step 3: Add exact-once receiving cancellation**

Add `onCancel` to the destructured `IncomingFileRequestDialog` props. Add the receiving action ref:

```tsx
const cancelButtonRef = useRef<HTMLButtonElement>(null)
```

Focus the correct state action:

```tsx
useEffect(() => {
  if (state.status === 'pending') {
    rejectButtonRef.current?.focus()
    return
  }

  if (state.status === 'receiving') {
    cancelButtonRef.current?.focus()
    return
  }

  closeButtonRef.current?.focus()
}, [state.status])
```

Add the exact-once handler:

```tsx
const cancelOnce = () => {
  if (state.status !== 'receiving' || closingRef.current) return

  closingRef.current = true
  dialogRef.current?.close()
  onCancel()
}
```

Use the dialog's native cancel event:

```tsx
onCancel={event => {
  event.preventDefault()
  if (state.status === 'pending') rejectOnce()
  else if (state.status === 'receiving') cancelOnce()
  else closeOnce()
}}
```

- [ ] **Step 4: Render one file list for every dialog state**

Before the return, derive:

```tsx
const listedFiles = state.status === 'received' ? state.files : files
const downloadableFiles = new Map<string, DownloadableReceivedFile>(
  state.status === 'received'
    ? state.files.map(file => [file.fileId, file] as const)
    : [],
)
```

Replace both current file lists with:

```tsx
<ul
  className="native-scrollbar mt-5 max-h-52 space-y-2 overflow-y-auto overscroll-contain sm:max-h-56"
  aria-label={state.status === 'received' ? '已接收文件' : '待接收文件'}
>
  {listedFiles.map(file => {
    const progress = state.status === 'receiving'
      ? state.progressByFileId[file.fileId] ?? 0
      : state.status === 'received'
        ? 1
        : 0
    const fileState = state.status === 'received'
      ? 'completed'
      : state.status === 'error'
        ? 'error'
        : state.status === 'receiving'
          ? progress >= 1
            ? 'completed'
            : progress > 0
              ? 'transferring'
              : 'queued'
          : 'queued'
    const downloadable = downloadableFiles.get(file.fileId)

    return (
      <li key={file.fileId}>
        <FileTransferRow
          fileId={file.fileId}
          name={file.name}
          byteLength={file.byteLength}
          progress={progress}
          state={fileState}
          action={downloadable ? (
            <a
              href={downloadable.url}
              download={downloadable.name}
              aria-label={`下载 ${downloadable.name}`}
              className="flex size-11 shrink-0 items-center justify-center rounded-full text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:bg-white/5 focus-visible:text-amber-50/80 focus-visible:outline-none"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '17px' }} aria-hidden="true">download</span>
            </a>
          ) : undefined}
        />
      </li>
    )
  })}
</ul>
```

Delete the old `state.status !== 'received'` wrapper and the entire separate received Save-list block.

- [ ] **Step 5: Replace footer actions by state**

Use:

```tsx
{state.status === 'pending' && (
  <div className="mt-5 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
    <button
      ref={rejectButtonRef}
      type="button"
      className="min-h-11 rounded-xl border border-amber-50/15 px-4 text-sm tracking-[0.05em] text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:text-amber-50/20"
      disabled={decisionMade}
      onClick={rejectOnce}
    >
      拒绝
    </button>
    <button
      type="button"
      className="min-h-11 rounded-xl border border-accent bg-accent px-4 text-sm tracking-[0.05em] text-white/90 transition-[filter,border-color] hover:brightness-110 active:brightness-90 focus-visible:border-amber-50/80 focus-visible:outline-none disabled:cursor-not-allowed disabled:brightness-75"
      disabled={decisionMade}
      onClick={acceptOnce}
    >
      接收全部
    </button>
  </div>
)}

{state.status === 'receiving' && (
  <button
    ref={cancelButtonRef}
    type="button"
    className="mt-5 min-h-11 w-full rounded-xl border border-amber-50/15 px-4 text-sm tracking-[0.05em] text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
    onClick={cancelOnce}
  >
    取消接收
  </button>
)}

{(state.status === 'received' || state.status === 'error') && (
  <button
    ref={closeButtonRef}
    type="button"
    className="mt-5 min-h-11 w-full rounded-xl border border-amber-50/15 px-4 text-sm tracking-[0.05em] text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
    onClick={closeOnce}
  >
    关闭
  </button>
)}
```

Delete `pendingActionsDisabled`; state-specific rendering now prevents invalid actions.

- [ ] **Step 6: Wire cancellation in App and its test mock**

Add this App callback:

```tsx
const handleCancelFiles = useCallback(() => {
  const current = incomingFileRef.current
  if (!current || current.state.status !== 'receiving') return

  const { transferId } = current
  progressSchedulerRef.current?.clear()
  replaceIncomingFile()
  setReceiverPanelState({ status: 'waiting' })
  peerSessionRef.current?.cancelTransfer(transferId)
}, [replaceIncomingFile])
```

Pass:

```tsx
onCancel={handleCancelFiles}
```

Update the mocked dialog props with `onCancel(): void`, and render in receiving state:

```tsx
{state.status === 'receiving' && (
  <button type="button" onClick={onCancel}>取消测试接收</button>
)}
```

Add this complete App integration test:

```tsx
test('cancels an active incoming batch and ignores its stale terminal event', async () => {
  const user = await enterRoom('receiver')
  emit({
    type: 'transfer:file-requested',
    peerId: sender.id,
    transferId: 'files-cancel',
    files: [{
      fileId: 'file-cancel',
      streamId: 21,
      name: '取消.bin',
      mimeType: 'application/octet-stream',
      byteLength: 4,
      lastModified: 1,
      chunkSize: 1024,
      chunkCount: 1,
    }],
  })

  await user.click(screen.getByRole('button', { name: '接收测试文件' }))
  expect(screen.getByTestId('file-dialog-status').textContent).toBe('receiving')

  await user.click(screen.getByRole('button', { name: '取消测试接收' }))
  expect(peerSession.cancelTransfer).toHaveBeenCalledTimes(1)
  expect(peerSession.cancelTransfer).toHaveBeenCalledWith('files-cancel')
  expect(screen.queryByTestId('file-dialog-status')).toBeNull()
  expect(screen.getByTestId('receiver-panel').textContent).toBe('waiting')

  emit({
    type: 'transfer:terminal',
    peerId: sender.id,
    transferId: 'files-cancel',
    outcome: 'cancelled',
  })
  expect(screen.queryByTestId('file-dialog-status')).toBeNull()
})
```

- [ ] **Step 7: Run receiver and App tests**

```bash
bun run --cwd apps/web test -- src/components/FileTransferRow.test.tsx src/components/IncomingFileRequestDialog.test.tsx src/App.test.tsx
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
```

Expected: all commands pass; received Blob URLs remain downloadable and are still revoked exactly once on close/reset/unmount.

- [ ] **Step 8: Commit the batch receiver UX**

```bash
git add apps/web/src/components/IncomingFileRequestDialog.tsx apps/web/src/components/IncomingFileRequestDialog.test.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat: improve batch receive actions"
```

---

### Task 6: Complete Verification and Delivery

**Files:**
- Verify: `apps/web/src/features/transfer/peer-session.ts`
- Verify: `apps/web/src/features/room/state.ts`
- Verify: `apps/web/src/components/TransferPeerFlow.tsx`
- Verify: `apps/web/src/components/RoomCodeCopyButton.tsx`
- Verify: `apps/web/src/components/FileTransferRow.tsx`
- Verify: `apps/web/src/components/TransferPanel.tsx`
- Verify: `apps/web/src/components/IncomingFileRequestDialog.tsx`
- Verify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: all completed tasks.
- Produces: a clean, verified `main` branch pushed to `origin/main`.

- [ ] **Step 1: Run complete Web verification**

```bash
bun run --cwd apps/web test
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
bun run --cwd apps/web build
```

Expected: all Web tests pass and Vite produces the production bundle with no warnings or type errors.

- [ ] **Step 2: Run repository verification and inspect the final diff**

```bash
bun run verify
git diff --check
git status --short --branch
git log --oneline origin/main..main
```

Expected: every Turbo task succeeds; no whitespace errors or uncommitted files remain.

- [ ] **Step 3: Perform browser visual verification**

Start local API and Web processes with TURN disabled:

```powershell
$env:PORT = '3100'
$env:CORS_ALLOWED_ORIGINS = 'http://127.0.0.1:5713'
$api = Start-Process -FilePath 'bun' -ArgumentList 'run','src/index.ts' -WorkingDirectory 'X:\p2p-transmission\services\api' -WindowStyle Hidden -PassThru

$env:VITE_API_URL = 'http://127.0.0.1:3100'
$env:VITE_TURN_MODE = 'off'
$web = Start-Process -FilePath 'bun' -ArgumentList 'run','dev','--','--host','127.0.0.1' -WorkingDirectory 'X:\p2p-transmission\apps\web' -WindowStyle Hidden -PassThru
```

Using the in-app browser, verify:

1. the visible room number and copy icon form one button and clicking either visual area uses the same copy action;
2. the sender-only flow contains no connector before a receiver is ready;
3. the connected label and flow share one line at desktop and 320 px viewport widths;
4. static and transferring connector states match the component tests;
5. the sender file scroller, receiver consent ratio, receiving cancellation, and completed download links match the focused component tests;
6. browser console warnings and errors are empty.

The in-app browser has one tab and cannot safely construct two simultaneous P2P peers or inject native file selections. Treat the focused component, state, peer-session, and App integration tests as authoritative for those states.

Stop only the processes created for verification:

```powershell
Stop-Process -Id $api.Id,$web.Id -Force
```

- [ ] **Step 4: Fetch and push `main`**

```bash
git fetch origin main
git status --short --branch
git push origin main
git status --short --branch
git rev-parse main
git rev-parse origin/main
```

Expected: local and remote `main` resolve to the same commit and the working tree is clean.
