# Transfer UI Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the room-code copy control visually secondary, keep sender file rows stable before and after Send, and show receiver progress as independent background fills inside the same file-row design.

**Architecture:** Add one presentation-only `FileTransferRow` component that owns file metadata layout, progress fill, labels, and progressbar semantics. `TransferPanel` maps outgoing state into that component, while `IncomingFileRequestDialog` receives a normalized `progressByFileId` record maintained by `App` through the existing animation-frame scheduler. Clipboard behavior, transfer protocol, consent, chunking, and Blob URL ownership remain unchanged.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS 4, Vitest, Testing Library, Bun, Vite.

## Global Constraints

- The room-code button always renders the `content_copy` icon, including copying, success, and error states.
- The room-code button remains at least 44 × 44 px, becomes borderless and circular, and uses only hover/focus background changes.
- Sender rows before and after Send use the same shared row surface and metadata geometry.
- Sender progress remains the slowest accepted peer's per-file progress.
- Receiver progress is normalized per file from `fileBytes / fileTotalBytes`, monotonic, and keyed by the current file ID.
- Receiver file rows use background fill; no standalone batch progress bar remains.
- A zero-byte received file starts visually complete.
- No transfer protocol, consent, receipt, file-limit, cancellation, or Blob URL behavior changes.
- Progress animation is motion-safe and becomes instant for reduced motion.
- Existing Chinese UI copy and 10-file/100-MiB limits remain unchanged.

---

### Task 1: Make the Room-Code Copy Control Secondary

**Files:**
- Modify: `apps/web/src/components/RoomCodeCopyButton.tsx`
- Modify: `apps/web/src/components/RoomCodeCopyButton.test.tsx`

**Interfaces:**
- Consumes: existing `RoomCodeCopyButtonProps` and `onCopy(code): Promise<void>`.
- Produces: the same public component API, stable `data-status`, and stable `复制房间码` accessible name.

- [ ] **Step 1: Write failing visual and single-icon tests**

Extend the success test and add a deferred-copy test:

```tsx
test('is circular and keeps one copy icon through an async copy', async () => {
  const user = userEvent.setup()
  let resolveCopy!: () => void
  const onCopy = vi.fn(() => new Promise<void>(resolve => {
    resolveCopy = resolve
  }))
  render(<RoomCodeCopyButton code="012345" onCopy={onCopy} />)

  const button = screen.getByRole('button', { name: '复制房间码' })
  const icon = screen.getByText('content_copy')
  expect(button.className).toContain('rounded-full')
  expect(button.className).not.toMatch(/(?:^|\s)border(?:-|\s|$)/)
  expect(button.className).toContain('hover:bg-white/5')
  expect(button.className).toContain('focus-visible:bg-white/5')

  await user.click(button)
  expect(screen.getByText('content_copy')).toBe(icon)
  expect(screen.queryByText('progress_activity')).toBeNull()
  resolveCopy()
  await waitFor(() => expect(button.getAttribute('data-status')).toBe('copied'))
  expect(screen.getByText('content_copy')).toBe(icon)
})
```

Also assert the rejected-copy test still renders `content_copy` and no `error` icon.

- [ ] **Step 2: Run the component test and verify it fails**

Run:

```bash
bun run --cwd apps/web test -- src/components/RoomCodeCopyButton.test.tsx
```

Expected: FAIL because the button still uses `rounded-lg`, border classes, and state-specific icons.

- [ ] **Step 3: Keep announcements but render one static icon**

Replace the icon-bearing status map with announcements only:

```tsx
const statusAnnouncement: Record<CopyStatus, string> = {
  idle: '',
  copying: '正在复制房间码',
  copied: '房间码已复制',
  error: '无法复制房间码',
}
```

Use this button and icon shape:

```tsx
<button
  type="button"
  className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-amber-50/50 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:bg-white/5 focus-visible:text-amber-50/80 focus-visible:outline-none disabled:cursor-wait disabled:bg-transparent disabled:text-amber-50/20"
  aria-label="复制房间码"
  data-status={status}
  disabled={status === 'copying'}
  onClick={() => { void handleCopy() }}
>
  <span
    className="material-symbols-outlined"
    style={{ fontSize: '17px' }}
    aria-hidden="true"
  >
    content_copy
  </span>
</button>
<span className="sr-only" aria-live="polite" aria-atomic="true">
  {statusAnnouncement[status]}
</span>
```

- [ ] **Step 4: Run the copy-button tests**

Run:

```bash
bun run --cwd apps/web test -- src/components/RoomCodeCopyButton.test.tsx
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
```

Expected: all commands PASS with no warnings.

- [ ] **Step 5: Commit the copy-button change**

```bash
git add apps/web/src/components/RoomCodeCopyButton.tsx apps/web/src/components/RoomCodeCopyButton.test.tsx
git commit -m "style: simplify room code copy control"
```

---

### Task 2: Extract the Shared File Transfer Row

**Files:**
- Create: `apps/web/src/components/FileTransferRow.tsx`
- Create: `apps/web/src/components/FileTransferRow.test.tsx`

**Interfaces:**
- Consumes: file metadata, normalized progress, visual state, and an optional trailing React node.
- Produces:

```ts
export type FileTransferRowState = 'queued' | 'transferring' | 'completed' | 'error'

export type FileTransferRowProps = {
  fileId: string
  name: string
  byteLength: number
  progress: number
  state: FileTransferRowState
  action?: ReactNode
}
```

- [ ] **Step 1: Write failing shared-row tests**

Create tests that render queued, transferring, completed, and error rows:

```tsx
const baseProps: FileTransferRowProps = {
  fileId: 'file-1',
  name: '设计稿.png',
  byteLength: 2048,
  progress: 0.376,
  state: 'transferring',
}
const { rerender } = render(
  <FileTransferRow
    {...baseProps}
    action={<button type="button">移除</button>}
  />,
)

const row = screen.getByTestId('file-transfer-row-file-1')
const progress = screen.getByRole('progressbar', { name: '设计稿.png 传输进度' })
expect(row.className).toContain('bg-white/5')
expect(progress.getAttribute('aria-valuenow')).toBe('38')
expect(progress.getAttribute('style')).toContain('38%')
expect(screen.getByText('38%').textContent).toBe('38%')
expect(screen.getByText('2.0 KiB').textContent).toBe('2.0 KiB')
expect(screen.getByRole('button', { name: '移除' })).not.toBeNull()

rerender(<FileTransferRow {...baseProps} progress={2} state="completed" />)
expect(progress.getAttribute('aria-valuenow')).toBe('100')
expect(screen.getByText('已完成')).not.toBeNull()

rerender(<FileTransferRow {...baseProps} progress={-1} state="error" />)
expect(progress.getAttribute('aria-valuenow')).toBe('0')
expect(screen.getByText('传输失败')).not.toBeNull()
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
bun run --cwd apps/web test -- src/components/FileTransferRow.test.tsx
```

Expected: FAIL because `FileTransferRow.tsx` does not exist.

- [ ] **Step 3: Implement normalized progress and labels**

Create the component with these helpers:

```tsx
import type { ReactNode } from 'react'

export type FileTransferRowState = 'queued' | 'transferring' | 'completed' | 'error'

export type FileTransferRowProps = {
  fileId: string
  name: string
  byteLength: number
  progress: number
  state: FileTransferRowState
  action?: ReactNode
}

const clampProgress = (progress: number) => {
  if (!Number.isFinite(progress)) return 0
  return Math.min(1, Math.max(0, progress))
}

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

const stateLabel = (state: FileTransferRowState, progress: number) => {
  if (state === 'completed') return '已完成'
  if (state === 'error') return '传输失败'
  if (state === 'transferring') return `${String(Math.round(progress * 100))}%`
  return '等待传输'
}
```

Render one stable row structure:

```tsx
const normalized = state === 'completed' ? 1 : clampProgress(progress)
const percentage = Math.round(normalized * 100)

return (
  <div
    data-testid={`file-transfer-row-${fileId}`}
    className="relative overflow-hidden rounded-lg bg-white/5"
  >
    <div
      className="absolute inset-y-0 left-0 bg-accent/15 motion-safe:transition-[width] motion-safe:duration-150"
      style={{ width: `${String(percentage)}%` }}
      role="progressbar"
      aria-label={`${name} 传输进度`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percentage}
      aria-valuetext={stateLabel(state, normalized)}
    />
    <div className="relative z-10 flex min-h-11 items-center gap-3 px-3 py-2">
      <span className="material-symbols-outlined shrink-0 text-amber-50/40" style={{ fontSize: '16px' }} aria-hidden="true">description</span>
      <span className="min-w-0 flex-1 truncate text-xs text-amber-50/75" title={name}>{name}</span>
      <span className="shrink-0 text-xs tabular-nums text-amber-50/50">{formatSize(byteLength)}</span>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-amber-50/60">{stateLabel(state, normalized)}</span>
      {action}
    </div>
  </div>
)
```

- [ ] **Step 4: Run shared-row tests and static checks**

Run:

```bash
bun run --cwd apps/web test -- src/components/FileTransferRow.test.tsx
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
```

Expected: all commands PASS.

- [ ] **Step 5: Commit the shared row**

```bash
git add apps/web/src/components/FileTransferRow.tsx apps/web/src/components/FileTransferRow.test.tsx
git commit -m "feat: add shared file progress row"
```

---

### Task 3: Keep Sender Rows Stable Across Send

**Files:**
- Modify: `apps/web/src/components/TransferPanel.tsx`
- Modify: `apps/web/src/components/TransferPanel.test.tsx`

**Interfaces:**
- Consumes: `FileTransferRow`, outgoing `activity.files`, `aggregateFileProgress`, and the existing remove callback.
- Produces: unchanged `TransferPanelProps` and the same picker/send/cancel behavior.

- [ ] **Step 1: Write a failing before/after consistency test**

Render one selected file, switch to the file tab, capture the shared row, then rerender with an active transfer:

```tsx
const { rerender } = render(<TransferPanel {...initialProps} />)
await user.click(screen.getByRole('tab', { name: '传输文件' }))

const selectedRow = screen.getByTestId('file-transfer-row-file-progress')
const selectedClassName = selectedRow.className
expect(screen.getByRole('button', { name: '移除 progress.bin' })).not.toBeNull()

rerender(<TransferPanel {...initialProps} activity={createActiveFileTransfer('file-progress')} />)
const transferringRow = screen.getByTestId('file-transfer-row-file-progress')
expect(transferringRow.className).toBe(selectedClassName)
expect(screen.queryByRole('button', { name: '移除 progress.bin' })).toBeNull()
expect(screen.getByText('35%')).not.toBeNull()

const dropZone = screen.getByRole('button', { name: '选择要传输的文件' })
expect(dropZone.className).not.toContain('opacity-60')
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
bun run --cwd apps/web test -- src/components/TransferPanel.test.tsx
```

Expected: FAIL because no shared row test ID exists and the locked drop zone applies `opacity-60`.

- [ ] **Step 3: Replace inline sender rows with `FileTransferRow`**

Import the shared component and delete the local size/state-label helpers. Keep `terminalErrorProgress`, then map each selection:

```tsx
const presentation = activity?.files[selection.fileId]
const progress = presentation
  ? presentation.state === 'error'
    ? terminalErrorProgress(activity, selection.fileId)
    : aggregateFileProgress(activity, selection.fileId)
  : 0
const state = presentation?.state ?? 'queued'

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
```

Change only the locked visual branch of the file drop zone:

```tsx
${locked ? 'cursor-default' : 'cursor-pointer hover:border-amber-50/30'}
```

Keep `aria-disabled`, input disabling, drop rejection, and tab locking unchanged.

- [ ] **Step 4: Run sender component tests**

Run:

```bash
bun run --cwd apps/web test -- src/components/FileTransferRow.test.tsx src/components/TransferPanel.test.tsx
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
```

Expected: all commands PASS; progress remains 35% and failed terminal progress remains 42%.

- [ ] **Step 5: Commit sender unification**

```bash
git add apps/web/src/components/TransferPanel.tsx apps/web/src/components/TransferPanel.test.tsx
git commit -m "refactor: unify sender file rows"
```

---

### Task 4: Render Per-File Receiving Progress in Row Backgrounds

**Files:**
- Modify: `apps/web/src/components/IncomingFileRequestDialog.tsx`
- Modify: `apps/web/src/components/IncomingFileRequestDialog.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/index.css`

**Interfaces:**
- Consumes: receiving `transfer:file-progress` events and the shared `FileTransferRow`.
- Produces:

```ts
export type IncomingFileRequestDialogState =
  | { status: 'pending' }
  | { status: 'receiving'; progressByFileId: Readonly<Record<string, number>> }
  | { status: 'received'; files: readonly DownloadableReceivedFile[] }
  | { status: 'error'; message?: string }
```

- [ ] **Step 1: Write failing receiver dialog tests**

Replace the aggregate receiving test with two independent rows:

```tsx
render(
  <IncomingFileRequestDialog
    sender={sender}
    files={files}
    state={{
      status: 'receiving',
      progressByFileId: {
        'file-1': 0.25,
        'file-2': 0.756,
      },
    }}
    {...actions}
  />,
)

const first = screen.getByRole('progressbar', { name: '设计稿.png 传输进度' })
const second = screen.getByRole('progressbar', { name: '说明.txt 传输进度' })
expect(first.getAttribute('aria-valuenow')).toBe('25')
expect(first.getAttribute('style')).toContain('25%')
expect(second.getAttribute('aria-valuenow')).toBe('76')
expect(second.getAttribute('style')).toContain('76%')
expect(screen.queryByLabelText('接收进度')).toBeNull()
expect((screen.getByRole('button', { name: '接收' }) as HTMLButtonElement).disabled).toBe(true)
expect((screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement).disabled).toBe(true)
```

- [ ] **Step 2: Write a failing App test for monotonic file progress**

Expose `progressByFileId` from the mocked dialog:

```tsx
{state.status === 'receiving' && (
  <output data-testid="incoming-file-progress">
    {JSON.stringify(state.progressByFileId)}
  </output>
)}
```

Then request two files, accept, emit progress for both, flush one animation frame, and emit a stale regression:

```tsx
emit(fileRequestWithTwoFiles)
await user.click(screen.getByRole('button', { name: '接收测试文件' }))

emit(receivingProgress('file-1', 25, 100))
emit(receivingProgress('file-2', 75, 100))
act(() => frameCallbacks.get(1)?.(0))
expect(JSON.parse(screen.getByTestId('incoming-file-progress').textContent!)).toEqual({
  'file-1': 0.25,
  'file-2': 0.75,
})

emit(receivingProgress('file-1', 10, 100))
act(() => frameCallbacks.get(2)?.(0))
expect(JSON.parse(screen.getByTestId('incoming-file-progress').textContent!))
  .toMatchObject({ 'file-1': 0.25 })
```

Include a zero-byte requested file and assert its initialized progress is `1` immediately after acceptance.

- [ ] **Step 3: Run focused tests and verify they fail**

Run:

```bash
bun run --cwd apps/web test -- src/components/IncomingFileRequestDialog.test.tsx src/App.test.tsx
```

Expected: FAIL because receiving state still accepts one aggregate percentage and the dialog renders a standalone bar.

- [ ] **Step 4: Change receiving state to a per-file record**

In `IncomingFileRequestDialog.tsx`, replace `progress` with `progressByFileId` in the receiving variant and import `FileTransferRow`.

For pending and receiving files, map the visual state:

```tsx
const progress = state.status === 'receiving'
  ? state.progressByFileId[file.fileId] ?? 0
  : 0
const fileState = state.status === 'receiving'
  ? progress >= 1
    ? 'completed'
    : progress > 0
      ? 'transferring'
      : 'queued'
  : 'queued'

<FileTransferRow
  fileId={file.fileId}
  name={file.name}
  byteLength={file.byteLength}
  progress={progress}
  state={fileState}
/>
```

Delete the complete `state.status === 'receiving'` block that renders `aria-label="接收进度"` and its nested horizontal bar.

- [ ] **Step 5: Update `App` initialization and frame-coalesced updates**

Initialize progress after acceptance:

```tsx
const progressByFileId = Object.fromEntries(
  current.files.map(file => [file.fileId, file.byteLength === 0 ? 1 : 0]),
)
replaceIncomingFile({
  ...current,
  state: { status: 'receiving', progressByFileId },
})
```

Replace aggregate progress reduction in `flushProgressEvents` with:

```tsx
const progressByFileId = { ...current.state.progressByFileId }
const knownFileIds = new Set(current.files.map(file => file.fileId))
let changed = false

for (const event of events) {
  if (
    event.direction !== 'receiving'
    || event.peerId !== current.peerId
    || event.transferId !== current.transferId
    || !knownFileIds.has(event.fileId)
  ) {
    continue
  }

  const next = event.fileTotalBytes <= 0
    ? 1
    : Math.min(1, Math.max(0, event.fileBytes / event.fileTotalBytes))
  const previous = progressByFileId[event.fileId] ?? 0
  if (next <= previous) continue
  progressByFileId[event.fileId] = next
  changed = true
}

if (changed) {
  replaceIncomingFile({
    ...current,
    state: { status: 'receiving', progressByFileId },
  })
}
```

Keep the existing peer/transfer/direction generation guards, scheduler clearing, completion, rejection, failure, and reset paths unchanged.

- [ ] **Step 6: Remove obsolete dialog progress CSS**

Delete `.transfer-dialog-progress` and its reduced-motion rule from `apps/web/src/index.css`; `FileTransferRow` now uses `motion-safe` utilities directly.

- [ ] **Step 7: Run receiver and App tests**

Run:

```bash
bun run --cwd apps/web test -- src/components/FileTransferRow.test.tsx src/components/IncomingFileRequestDialog.test.tsx src/App.test.tsx
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
```

Expected: all commands PASS; two receiver files retain independent monotonic percentages and no standalone receiving bar exists.

- [ ] **Step 8: Commit receiver progress**

```bash
git add apps/web/src/components/IncomingFileRequestDialog.tsx apps/web/src/components/IncomingFileRequestDialog.test.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/index.css
git commit -m "feat: show per-file receiving progress"
```

---

### Task 5: Complete Verification and Delivery

**Files:**
- Verify: `apps/web/src/components/RoomCodeCopyButton.tsx`
- Verify: `apps/web/src/components/FileTransferRow.tsx`
- Verify: `apps/web/src/components/TransferPanel.tsx`
- Verify: `apps/web/src/components/IncomingFileRequestDialog.tsx`
- Verify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: all completed UI tasks.
- Produces: a clean, tested `main` branch pushed to `origin/main`.

- [ ] **Step 1: Run the complete Web verification**

```bash
bun run --cwd apps/web test
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
bun run --cwd apps/web build
```

Expected: every Web test passes, including the new copy-button and file-row tests.

- [ ] **Step 2: Run repository verification**

```bash
bun run verify
git diff --check
git status --short
```

Expected: all workspace lint, tests, typechecks, and builds pass; no whitespace errors or uncommitted files remain.

- [ ] **Step 3: Perform browser visual verification**

Start the API and Web with TURN off for local UI verification:

```powershell
$env:PORT='3100'
$env:CORS_ALLOWED_ORIGINS='http://127.0.0.1:5713'
$api = Start-Process -FilePath 'bun' -ArgumentList 'run','src/index.ts' -WorkingDirectory 'X:\p2p-transmission\services\api' -WindowStyle Hidden -PassThru

$env:VITE_API_URL='http://127.0.0.1:3100'
$env:VITE_TURN_MODE='off'
$web = Start-Process -FilePath 'bun' -ArgumentList 'run','dev','--','--host','127.0.0.1' -WorkingDirectory 'X:\p2p-transmission\apps\web' -WindowStyle Hidden -PassThru
```

Using the in-app browser, verify:

1. the room-code copy button is circular, borderless, and remains a copy icon;
2. its hover/focus surface is visible but secondary;
3. the sender file rows use the same surface and geometry before and during transfer;
4. receiver rows show independent background fills with no separate bar;
5. browser console errors and warnings are empty.

Use component tests as the authoritative verification for file-picker and two-peer states that cannot be safely constructed in one in-app browser tab.

After verification, stop only the two test processes created above:

```powershell
Stop-Process -Id $api.Id,$web.Id -Force
```

- [ ] **Step 4: Push `main`**

```bash
git push origin main
git status --short --branch
git rev-parse main
git rev-parse origin/main
```

Expected: local and remote `main` resolve to the same commit and the working tree is clean.
