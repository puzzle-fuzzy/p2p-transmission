# P1 Transfer UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add visible join guidance, multi-recipient selection, and persistent transfer results with retry while preserving the existing secure P2P protocol and minimal flow.

**Architecture:** Keep recipient intent in `TransferPanel`, expose it through a focused `RecipientPickerDialog`, and pass selected ready peer IDs through `App` into `PeerSession.offerText/offerFiles`. Reuse the existing `OutgoingActivity` per-peer outcome model for persistent terminal results; store the original outgoing payload in `App` only to implement retry without adding a second transfer state machine.

**Tech Stack:** React 19, TypeScript, native `<dialog>`, Tailwind CSS v4, Vitest/Testing Library, Playwright E2E, Bun/Turbo.

## Global Constraints

- Preserve the no-account, no-cloud-payload product model and current WebRTC data protocol.
- Preserve the short create/join-to-transfer path; do not add an onboarding wizard.
- Default selection must include every currently ready receiver so existing broadcast behavior is unchanged.
- Never send a transfer request to a peer ID that is not currently ready.
- Keep the existing dark flat visual system: no shadows, gradients, new accent colors, or decorative motion.
- Use accessible button, checkbox, dialog, focus, status, and alert semantics; color must not be the only state signal.
- Room leave, expiry, realtime disconnect, and peer-session disposal must clear transfer presentation and retry payloads.

---

### Task 1: Build the recipient picker dialog

**Files:**
- Create: `apps/web/src/components/RecipientPickerDialog.tsx`
- Create: `apps/web/src/components/RecipientPickerDialog.test.tsx`
- Modify: `apps/web/src/components/TransferPeerFlow.tsx`
- Modify: `apps/web/src/components/TransferPeerFlow.test.tsx`

**Interfaces:**
- Consumes: `PublicVisitor[]`, selected receiver IDs, `onConfirm(ids)`, and `onClose()`.
- Produces: a native dialog with accessible multi-select rows and a labelled avatar-group trigger contract that later `TransferPanel` can use.

- [ ] **Step 1: Write failing dialog tests**

Add tests covering:

```tsx
test('renders every receiver with checkbox semantics and selected state', () => {
  render(<RecipientPickerDialog
    receivers={[receiverOne, receiverTwo]}
    selectedIds={[receiverOne.id]}
    onConfirm={vi.fn()}
    onClose={vi.fn()}
  />)

  expect(screen.getByRole('dialog', { name: '选择接收者' })).toBeVisible()
  expect(screen.getByRole('checkbox', { name: receiverOne.displayName })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: receiverTwo.displayName })).not.toBeChecked()
})

test('supports select all, clear all, empty-selection validation, and confirmation', async () => {
  const onConfirm = vi.fn()
  const user = userEvent.setup()
  render(<RecipientPickerDialog
    receivers={[receiverOne, receiverTwo]}
    selectedIds={[receiverOne.id, receiverTwo.id]}
    onConfirm={onConfirm}
    onClose={vi.fn()}
  />)

  await user.click(screen.getByRole('button', { name: '清空选择' }))
  await user.click(screen.getByRole('button', { name: '确定' }))
  expect(screen.getByRole('alert')).toHaveTextContent('至少选择一位接收者')
  await user.click(screen.getByRole('checkbox', { name: receiverTwo.displayName }))
  await user.click(screen.getByRole('button', { name: '确定' }))
  expect(onConfirm).toHaveBeenCalledWith([receiverTwo.id])
})

test('Escape closes without changing the confirmed selection', async () => {
  const onClose = vi.fn()
  const user = userEvent.setup()
  render(<RecipientPickerDialog
    receivers={[receiverOne]}
    selectedIds={[receiverOne.id]}
    onConfirm={vi.fn()}
    onClose={onClose}
  />)
  await user.keyboard('{Escape}')
  expect(onClose).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bun run --cwd apps/web test -- RecipientPickerDialog.test.tsx`

Expected: FAIL because `RecipientPickerDialog` does not exist.

- [ ] **Step 3: Implement the dialog**

Use the existing `ShareDialog` and `IncomingFileRequestDialog` dialog patterns. The component must:

```tsx
export type RecipientPickerDialogProps = {
  receivers: readonly PublicVisitor[]
  selectedIds: readonly string[]
  onConfirm(ids: string[]): void
  onClose(): void
}
```

Keep local draft selection inside the dialog. Render each receiver as a `<label>` containing a native checkbox, `Avatar`, and visible `displayName`. Add `全选`, `清空选择`, `取消`, and `确定`. On empty confirmation, keep the dialog open and render `role="alert"`. On confirm, return IDs in the same order as `receivers`. Open/focus/close behavior must use the native dialog and return focus to the trigger through the parent.

- [ ] **Step 4: Update the peer-flow trigger contract and tests**

Add optional props to `TransferPeerFlow`:

```tsx
onClick?(): void
selectedCount?: number
```

When `onClick` exists, wrap the visible avatar flow in a `button` with `aria-label={`选择接收者，已选择 ${selectedCount} 位`}` and `title="选择接收者"`. Keep the existing avatar rendering and tests unchanged when `onClick` is absent. Add a test that the trigger is keyboard-focusable and exposes the selected count.

- [ ] **Step 5: Run focused dialog and peer-flow tests**

Run: `bun run --cwd apps/web test -- RecipientPickerDialog.test.tsx TransferPeerFlow.test.tsx`

Expected: all focused tests PASS.

---

### Task 2: Restrict PeerSession offers to selected ready peers

**Files:**
- Modify: `apps/web/src/features/transfer/peer-session.ts:214-224,1031-1165`
- Modify: `apps/web/src/features/transfer/peer-session.test.ts`

**Interfaces:**
- Consumes: optional `readonly string[]` target IDs.
- Produces: `offerText(text, targetPeerIds?)` and `offerFiles(files, targetPeerIds?)` that only create/send work for selected ready peers.

- [ ] **Step 1: Write failing target-filter tests**

Add tests to the existing sender harness:

```ts
test('offerText sends only to the selected ready peer', () => {
  const { session, first, second } = senderHarness()
  first.channel.open()
  second.channel.open()

  const result = session.offerText('targeted', [first.peer.id])

  expect(result.peerIds).toEqual([first.peer.id])
  expect(first.channel.sent).toContainEqual(expect.objectContaining({ type: 'transfer:text' }))
  expect(second.channel.sent).not.toContainEqual(expect.objectContaining({ type: 'transfer:text' }))
})

test('offerFiles does not request files from an unselected peer', async () => {
  const supported = new FakePeerConnection(4096)
  const second = new FakePeerConnection(4096)
  const secondReceiver = { ...receiver, id: 'vis_receiver_2' }
  const { session } = senderHarness([supported, second])
  session.syncRoom(room([receiver, secondReceiver]))
  await settle()
  const supportedChannel = supported.channels[0] as FakeDataChannel
  const secondChannel = second.channels[0] as FakeDataChannel
  supportedChannel.open()
  secondChannel.open()
  const file = new File([new Uint8Array([1, 2, 3])], 'target.txt')

  const result = session.offerFiles(
    [{ fileId: 'file_target', file }],
    [receiver.id],
  )

  expect(result.peerIds).toEqual([receiver.id])
  expect(controls(supportedChannel)).toContainEqual(expect.objectContaining({ type: 'transfer:file-request' }))
  expect(controls(secondChannel)).not.toContainEqual(expect.objectContaining({ type: 'transfer:file-request' }))
})
```

Replace the second snippet with a concrete call using `[first.peer.id]` and assert only the first channel receives `transfer:file-request`; the existing test helpers already provide a valid file selection. Also cover an empty or disconnected target set throwing `No connected receivers` and not leaving an outgoing transfer lock.

- [ ] **Step 2: Run the focused tests to verify the new cases fail**

Run: `bun run --cwd apps/web test -- peer-session.test.ts`

Expected: new target-filter assertions FAIL because the current methods always use every ready entry.

- [ ] **Step 3: Implement target filtering**

Change the public interface to:

```ts
offerText(text: string, targetPeerIds?: readonly string[]): TransferOfferResult
offerFiles(files: readonly FileSelection[], targetPeerIds?: readonly string[]): TransferOfferResult
```

Implement one helper:

```ts
const readyEntriesFor = (targetPeerIds?: readonly string[]) => {
  const entries = readyEntries()
  if (targetPeerIds === undefined) return entries
  const targetSet = new Set(targetPeerIds)
  return entries.filter(entry => targetSet.has(entry.peerId))
}
```

Use the helper in both offer methods. Preserve result ordering from the current peer map and keep unsupported-file-peer handling unchanged. If the filtered result is empty, throw before allocating a transfer ID or mutating `outgoingTransfers`.

- [ ] **Step 4: Run peer-session tests**

Run: `bun run --cwd apps/web test -- peer-session.test.ts`

Expected: all existing and new peer-session tests PASS.

---

### Task 3: Add selection state, join guidance, and terminal result controls to TransferPanel

**Files:**
- Modify: `apps/web/src/components/RoomJoin.tsx`
- Modify: `apps/web/src/components/RoomJoin.test.tsx`
- Modify: `apps/web/src/components/TransferPanel.tsx`
- Modify: `apps/web/src/components/TransferPanel.test.tsx`

**Interfaces:**
- Consumes: ready `receivers`, `OutgoingActivity`, `onSendText(text, peerIds)`, `onSendFiles(peerIds)`, `onRetry()`, and `onDismissActivity()`.
- Produces: selected peer IDs passed to send callbacks, accessible picker trigger, visible terminal summary, retry, and dismiss actions.

- [ ] **Step 1: Write failing RoomJoin and TransferPanel tests**

Add to `RoomJoin.test.tsx`:

```tsx
test('shows visible room-code guidance for first-time users', () => {
  render(<RoomJoin {...defaultProps} />)
  expect(screen.getByRole('heading', { name: '加入房间' })).toBeVisible()
  expect(screen.getByText('输入发送者提供的 6 位房间码，或直接打开邀请链接')).toBeVisible()
})
```

Add to `TransferPanel.test.tsx`:

```tsx
test('defaults to all receivers and passes a multi-selection to text and file sends', async () => {
  const onSendText = vi.fn().mockResolvedValue(undefined)
  const onSendFiles = vi.fn().mockResolvedValue(undefined)
  const user = userEvent.setup()
  render(<TransferPanel {...createProps({ receivers: [receiverOne, receiverTwo], onSendText, onSendFiles })} />)

  await user.click(screen.getByRole('button', { name: /选择接收者/u }))
  await user.click(screen.getByRole('checkbox', { name: receiverTwo.displayName }))
  await user.click(screen.getByRole('button', { name: '确定' }))
  await user.type(screen.getByRole('textbox', { name: '要传输的文本' }), 'hello')
  await user.click(screen.getByRole('button', { name: '发送给 1 位接收者' }))

  expect(onSendText).toHaveBeenCalledWith('hello', [receiverOne.id])
})
```

Add tests that empty selection disables sending, a terminal activity exposes `再次发送` and `关闭结果`, and the terminal activity remains visible after the component rerenders.

- [ ] **Step 2: Run focused UI tests to verify they fail**

Run: `bun run --cwd apps/web test -- RoomJoin.test.tsx TransferPanel.test.tsx`

Expected: FAIL because visible guidance, picker trigger, target-aware callbacks, and terminal actions are not implemented.

- [ ] **Step 3: Add visible join guidance**

In `RoomJoin`, add an `h1` with `加入房间` and a visible paragraph directly above the six-digit field. Keep the invitation-specific banner above it when in invite mode. Use the existing muted text scale and Chinese copy from the test. Do not remove the existing privacy explanation.

- [ ] **Step 4: Add selection state and picker integration**

In `TransferPanel`:

```tsx
const [selectedReceiverIds, setSelectedReceiverIds] = useState<string[] | undefined>()
const selectedIds = selectedReceiverIds ?? receivers.map(receiver => receiver.id)
const selectedReadyReceivers = receivers.filter(receiver => selectedIds.includes(receiver.id))
```

Reconcile an explicit selection with `receivers` in an effect by filtering disconnected IDs; preserve an explicit empty array so it does not silently reselect everyone. Pass `selectedReadyReceivers` to `onSendText` and `onSendFiles`. Render the picker dialog from `TransferPeerFlow` and keep the trigger enabled while idle or terminal, but disabled while an active transfer or submit is in progress. The send button must use `selectedReadyReceivers.length` for its disabled state and label.

- [ ] **Step 5: Add terminal summary, retry, and dismiss controls**

Define:

```tsx
const terminal = activity?.phase === 'complete' || activity?.phase === 'error'
const activeTransfer = activity && !terminal
```

Keep active-transfer cancellation unchanged. For a terminal activity, render a status block with `role="status"` for success and `role="alert"` for error, plus counts derived from `activity.peers`. Render `再次发送` and `关闭结果` buttons. Do not auto-clear the activity in `TransferPanel`; call the supplied callbacks. Keep file rows available for final progress inspection and use `activity.peerIds` as the terminal recipient set.

- [ ] **Step 6: Run focused UI tests**

Run: `bun run --cwd apps/web test -- RoomJoin.test.tsx TransferPanel.test.tsx RecipientPickerDialog.test.tsx`

Expected: all focused UI tests PASS.

---

### Task 4: Integrate target IDs and persistent retry state in App

**Files:**
- Modify: `apps/web/src/App.tsx:303-323,498-528,1694-1786,2050-2190`
- Modify: `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: target-aware `TransferPanel` callbacks and `PeerSession` offer methods.
- Produces: original outgoing payload retention, terminal dismissal, and retry using only still-ready selected peers.

- [ ] **Step 1: Write failing App integration tests**

Add tests covering:

```tsx
test('passes selected receiver IDs into text and file offers', async () => {
  // Render a sender room with two ready peers, select one in the real TransferPanel,
  // send text and file, and assert the peer-session mocks receive exactly that ID.
})

test('keeps a terminal result until dismiss and retries the original payload', async () => {
  // Emit terminal failure, assert the result stays visible after 500ms,
  // click retry, assert the same text/file payload is offered to still-ready peers,
  // then click dismiss and assert the activity is cleared.
})

test('does not retry to a peer that left the room', async () => {
  // Store a two-peer outgoing payload, remove one peer from the room,
  // click retry, and assert the offer receives only the remaining ready ID.
})
```

Use the existing App test boundary mocks and event helpers; do not bypass the real `TransferPanel` in the selection test.

- [ ] **Step 2: Run App tests to verify the new cases fail**

Run: `bun run --cwd apps/web test -- App.test.tsx`

Expected: new assertions FAIL because App currently clears terminal activity after 400ms and does not retain target-aware payloads.

- [ ] **Step 3: Add a typed outgoing payload ref**

Add:

```ts
type OutgoingPayload =
  | { kind: 'text'; text: string; peerIds: string[] }
  | { kind: 'file'; selections: FileSelection[]; peerIds: string[] }
```

Create `outgoingPayloadRef` next to the existing transfer refs. Set it only after `peerSession.offerText/offerFiles` returns successfully, using `result.peerIds` rather than the requested IDs. Clear it in `resetTransferPresentation` and when the room is disposed.

- [ ] **Step 4: Make terminal activity persistent and dismissible**

Change `armTerminalHold` so it clears the progress scheduler and speed presentation but does not schedule the 400ms terminal clear. Add `dismissTransferResult` that checks for a terminal activity, clears the hold ref, dispatches `terminal:clear` with the current generation and transfer ID, and clears the outgoing payload ref. Keep realtime disconnect and room reset paths unchanged so they still clear immediately.

- [ ] **Step 5: Make send and retry target-aware**

Change handlers to the following target-aware signatures and call the peer session with the requested IDs:

```ts
const handleSendText = useCallback(async (
  text: string,
  peerIds: readonly string[],
) => {
  const peerSession = peerSessionRef.current
  if (!peerSession) throw new Error('点对点连接尚未就绪')
  const result = peerSession.offerText(text, peerIds)
  lastOutgoingPayloadRef.current = {
    kind: 'text',
    text,
    peerIds: result.peerIds,
  }
  startActivity(createActivity({
    generation: ++transferGenerationRef.current,
    transferId: result.transferId,
    kind: 'text',
    peerIds: result.peerIds,
    unsupportedPeerIds: result.unsupportedPeerIds,
  }))
}, [startActivity])

const handleSendFiles = useCallback(async (peerIds: readonly string[]) => {
  const peerSession = peerSessionRef.current
  if (!peerSession) throw new Error('点对点连接尚未就绪')
  const selections = fileSelectionsRef.current
  const result = peerSession.offerFiles(selections, peerIds)
  lastOutgoingPayloadRef.current = {
    kind: 'file',
    selections,
    peerIds: result.peerIds,
  }
  startActivity(createActivity({
    generation: ++transferGenerationRef.current,
    transferId: result.transferId,
    kind: 'file',
    peerIds: result.peerIds,
    unsupportedPeerIds: result.unsupportedPeerIds,
    fileIds: selections.map(selection => selection.fileId),
  }))
}, [startActivity])
```

Add `retryOutgoingTransfer` that reads `outgoingPayloadRef.current`, intersects its `peerIds` with `peerSession.readyPeerIds()`, throws `选中的接收者已断开，请重新选择` when empty, and calls the matching offer method. The new result becomes the active activity and replaces the stored payload with the actual returned peer IDs. Do not create a transfer when the target intersection is empty.

- [ ] **Step 6: Wire the sender panel callbacks**

Pass `onSendText={handleSendText}`, `onSendFiles={handleSendFiles}`, `onRetry={retryOutgoingTransfer}`, and `onDismissActivity={dismissTransferResult}`. Keep receiver behavior unchanged. Ensure the sender panel receives all ready receiver visitor objects so the picker can show names and avatars.

- [ ] **Step 7: Run App tests**

Run: `bun run --cwd apps/web test -- App.test.tsx`

Expected: all existing and new App integration tests PASS.

---

### Task 5: Update E2E coverage and run the release checks

**Files:**
- Modify: `apps/web/e2e/room-transfer.spec.ts`
- Modify: `apps/web/e2e/fixtures.ts` only if a new multi-receiver fixture helper is needed

- [ ] **Step 1: Add a second receiver context to the E2E flow**

Create sender plus two isolated receiver contexts. Have both receivers request and get approved. Assert the sender shows two connected receivers, open `选择接收者`, uncheck the second receiver, confirm, and send text. Assert only the first receiver receives the text within the timeout and the second receiver remains without a text dialog. Then reopen the picker, select both, send a file, and assert both receiver dialogs appear and can accept/download.

- [ ] **Step 2: Add terminal result assertions**

Force a receiver context to close during an outgoing transfer or use the existing peer event boundary if the real timing is nondeterministic. Assert the sender keeps a visible failure result, exposes `再次发送` and `关闭结果`, and does not auto-clear after 500ms.

- [ ] **Step 3: Run the E2E suite**

Run: `bun run e2e`

Expected: all E2E tests PASS using real Chromium contexts and real WebRTC.

- [ ] **Step 4: Run the full repository verification**

Run: `bun run verify`

Expected: lint, 291+ Web tests, API/contracts tests, typecheck, and build all PASS. The Web test count should increase from the current 291 because of the new picker, selection, target filtering, and App coverage.

- [ ] **Step 5: Inspect the final diff and status**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; only the intended implementation/test files are changed in addition to the already-existing user worktree changes.
