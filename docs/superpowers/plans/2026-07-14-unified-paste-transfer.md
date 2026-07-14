# 统一上传与文本项复制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除发送端的文本/文件切换，将选择、拖拽和粘贴统一加入文件传输队列，并让接收方可以通过明确的“复制内容”按钮复制已接收 TXT 内容。

**Architecture:** 浏览器剪贴板事件只绑定到统一上传区域。剪贴板真实文件直接转为待确认文件项目；纯文本在确认后创建 UTF-8 `粘贴内容.txt`，复用现有 `FileSelection`、文件校验和 `PeerSession.offerFiles`。接收端保留旧文本协议的兼容接收路径，但新发送状态只产生文件 payload；已接收的文本文件保留 Blob，并由接收弹窗提供复制和下载两个独立操作。

**Tech Stack:** Bun 1.3.14、React、TypeScript、Tailwind CSS、Vitest、Playwright、现有 `@p2p/contracts` 和 WebRTC 文件传输引擎。

## Global Constraints

- 仅在上传区域获得焦点或被点击后识别粘贴，避免干扰房间码、弹窗和其他输入框。
- 粘贴文件或文本前弹出确认，不在确认后自动发送。
- 文本作为 UTF-8 的 `.txt` 传输项目进入现有文件队列，并复用文件数量、大小和批次校验。
- 所有新发送内容统一走文件传输协议；新版本不再提供文本发送入口。
- 删除 `transfer:text`、文本 receipt、文本接收队列和 `ReceivedTextDialog`；新版本只保留文件传输协议。
- 复制操作必须是明确按钮，不点击整行或文件名就执行；下载按钮继续保留。
- 不新增运行时依赖；沿用项目现有组件、样式、协议和测试工具。
- 每个任务完成后运行该任务的最小测试并创建一个独立提交。

---

## 文件边界

### 新建

- `apps/web/src/features/transfer/paste-upload.ts`：剪贴板候选解析和粘贴文本文件名生成。
- `apps/web/src/features/transfer/paste-upload.test.ts`：候选解析、文件优先级、文本文件命名测试。
- `apps/web/src/components/PasteConfirmDialog.tsx`：粘贴项目确认弹窗。
- `apps/web/src/components/PasteConfirmDialog.test.tsx`：确认、取消、文本预览和文件列表测试。

### 修改

- `apps/web/src/components/TransferPanel.tsx`：删除 Tab 和文本发送入口，接入统一上传区域、粘贴事件和确认弹窗。
- `apps/web/src/components/TransferPanel.test.tsx`：替换文本 Tab 测试，增加统一上传和粘贴确认测试。
- `apps/web/src/App.tsx`：只保留新发送的文件 payload，删除旧文本接收状态，并接入粘贴项目和接收文件 Blob/MIME 元数据。
- `apps/web/src/App.test.tsx`：更新 TransferPanel 接口、发送/重试断言和文件接收测试，删除旧文本接收测试。
- `apps/web/src/components/IncomingFileRequestDialog.tsx`：为已接收文本文件增加“复制内容”按钮和持续反馈。
- `apps/web/src/components/IncomingFileRequestDialog.test.tsx`：增加 TXT 复制成功、失败和下载共存测试。
- `packages/contracts/src/transfer.ts`、`packages/contracts/src/transfer.test.ts`、`packages/contracts/src/index.ts`：删除旧文本控制帧、文本 receipt 和文本字符数限制。
- `apps/web/src/features/transfer/peer-session.ts`、`apps/web/src/features/transfer/peer-session.test.ts`：删除文本 offer、文本接收事件和文本 receipt 方法。
- `apps/web/src/features/transfer/ui-state.ts`、`apps/web/src/features/transfer/ui-state.test.ts`：删除文本 outgoing activity 和文本接收队列规划器。
- 删除 `apps/web/src/components/ReceivedTextDialog.tsx`、`apps/web/src/components/ReceivedTextDialog.test.tsx`。
- `apps/web/e2e/room-transfer.spec.ts`：把旧文本发送 E2E 改为粘贴文本文件传输，并验证接收端复制内容。

## Task 1: 建立剪贴板候选和文本文件生成边界

**Files:**

- Create: `apps/web/src/features/transfer/paste-upload.ts`
- Test: `apps/web/src/features/transfer/paste-upload.test.ts`

**Interfaces:**

- Produces `PasteCandidate`, `readPasteCandidate(data: DataTransfer)`, `createPastedTextFile(text, existingNames, now?)` for Tasks 2–3.

- [ ] **Step 1: Write the failing unit tests**

```ts
import { describe, expect, test } from 'vitest'
import {
  createPastedTextFile,
  readPasteCandidate,
} from './paste-upload'

describe('readPasteCandidate', () => {
  test('prefers clipboard files over their text representation', () => {
    const data = new DataTransfer()
    data.items.add(new File(['image'], '截图.png', { type: 'image/png' }))
    data.setData('text/plain', '截图的文本表示')

    expect(readPasteCandidate(data)).toEqual({
      kind: 'files',
      files: [data.files[0]],
    })
  })

  test('returns plain text when no clipboard files exist', () => {
    const data = new DataTransfer()
    data.setData('text/plain', '第一行\n第二行')

    expect(readPasteCandidate(data)).toEqual({
      kind: 'text',
      text: '第一行\n第二行',
    })
  })

  test('returns undefined for an empty clipboard payload', () => {
    expect(readPasteCandidate(new DataTransfer())).toBeUndefined()
  })
})

test('creates a UTF-8 text file with a collision-safe name', () => {
  const file = createPastedTextFile(
    '保留换行\n和 Unicode 🙂',
    ['粘贴内容.txt'],
    123,
  )

  expect(file.name).toBe('粘贴内容 (2).txt')
  expect(file.type).toBe('text/plain')
  expect(file.lastModified).toBe(123)
})
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bun run --cwd apps/web test -- src/features/transfer/paste-upload.test.ts`

Expected: FAIL because `paste-upload.ts` and its exported functions do not exist.

- [ ] **Step 3: Implement the minimal helper**

```ts
export type PasteCandidate =
  | { kind: 'files'; files: readonly File[] }
  | { kind: 'text'; text: string }

export const readPasteCandidate = (
  data: DataTransfer,
): PasteCandidate | undefined => {
  const files = Array.from(data.files)
  if (files.length > 0) return { kind: 'files', files }

  const text = data.getData('text/plain')
  return text.length > 0 ? { kind: 'text', text } : undefined
}

export const createPastedTextFile = (
  text: string,
  existingNames: readonly string[],
  now = Date.now(),
): File => {
  const occupied = new Set(existingNames.map(name => name.toLocaleLowerCase()))
  let name = '粘贴内容.txt'
  let suffix = 2
  while (occupied.has(name.toLocaleLowerCase())) {
    name = `粘贴内容 (${String(suffix)}).txt`
    suffix += 1
  }

  return new File([text], name, {
    type: 'text/plain',
    lastModified: now,
  })
}
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `bun run --cwd apps/web test -- src/features/transfer/paste-upload.test.ts`

Expected: all candidate and file-name tests pass.

- [ ] **Step 5: Commit the helper boundary**

```bash
git add apps/web/src/features/transfer/paste-upload.ts apps/web/src/features/transfer/paste-upload.test.ts
git commit -m "feat(web): add paste transfer helpers"
```

## Task 2: 创建粘贴确认弹窗

**Files:**

- Create: `apps/web/src/components/PasteConfirmDialog.tsx`
- Test: `apps/web/src/components/PasteConfirmDialog.test.tsx`

**Interfaces:**

- Consumes `PasteCandidate` from Task 1.
- Produces `PasteConfirmDialogProps` with `candidate?: PasteCandidate`, `onConfirm(): void`, and `onCancel(): void`.

- [ ] **Step 1: Write the failing component tests**

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import PasteConfirmDialog from './PasteConfirmDialog'

test('confirms adding pasted text without sending it', async () => {
  const user = userEvent.setup()
  const onConfirm = vi.fn()

  render(
    <PasteConfirmDialog
      candidate={{ kind: 'text', text: '第一行\n第二行' }}
      onConfirm={onConfirm}
      onCancel={vi.fn()}
    />,
  )

  expect(screen.getByRole('dialog', { name: '确认添加粘贴内容' })).toContainText('粘贴内容.txt')
  expect(screen.getByRole('dialog')).toContainText('第一行')
  await user.click(screen.getByRole('button', { name: '添加到传输列表' }))

  expect(onConfirm).toHaveBeenCalledOnce()
})

test('cancelling pasted files does not confirm them', async () => {
  const user = userEvent.setup()
  const onCancel = vi.fn()

  render(
    <PasteConfirmDialog
      candidate={{
        kind: 'files',
        files: [new File(['data'], '报告.pdf', { type: 'application/pdf' })],
      }}
      onConfirm={vi.fn()}
      onCancel={onCancel}
    />,
  )

  expect(screen.getByRole('dialog')).toContainText('报告.pdf')
  await user.click(screen.getByRole('button', { name: '取消' }))

  expect(onCancel).toHaveBeenCalledOnce()
})
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bun run --cwd apps/web test -- src/components/PasteConfirmDialog.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the native dialog**

The component must return `null` for an undefined candidate, use a native `<dialog>` with accessible name `确认添加粘贴内容`, show either file names/count/size or a maximum 200-character text preview, and expose exactly these actions:

```tsx
export type PasteConfirmDialogProps = {
  candidate?: PasteCandidate
  onConfirm(): void
  onCancel(): void
}
```

Use a request key based on candidate kind plus file names or text length to reset focus when a new paste arrives. Focus `取消` when opened, close the dialog before invoking `onCancel`, and invoke `onConfirm` without modifying the clipboard or sending a transfer. Add `data-testid="paste-confirm-dialog"` to the `<dialog>` for focused tests.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `bun run --cwd apps/web test -- src/components/PasteConfirmDialog.test.tsx`

Expected: confirmation and cancellation tests pass.

- [ ] **Step 5: Commit the dialog**

```bash
git add apps/web/src/components/PasteConfirmDialog.tsx apps/web/src/components/PasteConfirmDialog.test.tsx
git commit -m "feat(web): add paste confirmation dialog"
```

## Task 3: 将 TransferPanel 改为统一上传入口

**Files:**

- Modify: `apps/web/src/components/TransferPanel.tsx`
- Test: `apps/web/src/components/TransferPanel.test.tsx`

**Interfaces:**

- Consumes `readPasteCandidate` and `createPastedTextFile` from Task 1 plus `PasteConfirmDialog` from Task 2.
- Changes `onFilesAdded(files: readonly File[]): void` to `onFilesAdded(files: readonly File[]): boolean` so a rejected paste remains in the confirmation flow until the parent reports success.
- Removes `onSendText`, `Tab`, text state, text refs, tab keyboard handling, text send handler, and text panel rendering.

- [ ] **Step 1: Replace old text/tab tests with unified upload tests**

Keep existing file selection, removal, drag/drop, recipient selection, error, retry, and progress tests. Remove assertions for `role="tab"`, `传输文本`, the text textarea, and `onSendText`. Add these behavior tests:

```tsx
test('shows one upload surface and no text/file tabs', () => {
  renderTransferPanel()

  expect(screen.getByRole('button', { name: '上传要传输的内容' })).toBeVisible()
  expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '要传输的文本' })).not.toBeInTheDocument()
})

test('opens paste confirmation only from the upload surface', async () => {
  const user = userEvent.setup()
  renderTransferPanel()
  const upload = screen.getByRole('button', { name: '上传要传输的内容' })
  const data = new DataTransfer()
  data.setData('text/plain', '粘贴的内容')

  await user.click(upload)
  fireEvent.paste(upload, { clipboardData: data })

  expect(screen.getByRole('dialog', { name: '确认添加粘贴内容' })).toBeVisible()
})

test('confirming pasted text adds one file item but does not send', async () => {
  const user = userEvent.setup()
  const onFilesAdded = vi.fn(() => true)
  const onSendFiles = vi.fn(async () => undefined)
  renderTransferPanel({ onFilesAdded, onSendFiles })
  const upload = screen.getByRole('button', { name: '上传要传输的内容' })
  const data = new DataTransfer()
  data.setData('text/plain', '要作为文本项目发送')

  fireEvent.paste(upload, { clipboardData: data })
  await user.click(screen.getByRole('button', { name: '添加到传输列表' }))

  expect(onFilesAdded).toHaveBeenCalledWith([
    expect.objectContaining({ name: '粘贴内容.txt', type: 'text/plain' }),
  ])
  expect(onSendFiles).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the focused tests to verify the new tests fail**

Run: `bun run --cwd apps/web test -- src/components/TransferPanel.test.tsx`

Expected: the old Tab/text tests fail after their assertions are replaced, because the current component still renders the old two-mode UI and has no paste handler.

- [ ] **Step 3: Implement the unified panel contract and state**

Change the props and local state to the following shape:

```tsx
export type TransferPanelProps = {
  visitor: PublicVisitor
  receivers: PublicVisitor[]
  activity?: OutgoingActivity
  files: FileSelection[]
  selectionError: string
  fileSpeedData?: Record<string, { speed: number; eta: number | undefined }>
  onFilesAdded(files: readonly File[]): boolean
  onFileRemoved(fileId: string): void
  onSendFiles(peerIds: ReadonlyArray<string>): Promise<void>
  onCancel(): void
  onRetry?(): Promise<void>
  onDismissActivity?(): void
}

const [pasteCandidate, setPasteCandidate] = useState<PasteCandidate>()
const canSend = selectedCount > 0 && files.length > 0 && !locked

const handlePasteConfirm = () => {
  if (!pasteCandidate || locked) return
  const nextFiles = pasteCandidate.kind === 'files'
    ? pasteCandidate.files
    : [createPastedTextFile(pasteCandidate.text, files.map(selection => selection.file.name))]
  if (onFilesAdded(nextFiles)) setPasteCandidate(undefined)
}
```

Render one always-visible drop zone with `role="button"`, `tabIndex={locked ? -1 : 0}`, `aria-label="上传要传输的内容"`, `onClick`, `onKeyDown`, drag handlers, and:

```tsx
onPaste={event => {
  if (locked) return
  const candidate = readPasteCandidate(event.clipboardData)
  if (!candidate) return
  event.preventDefault()
  setSendError('')
  setPasteCandidate(candidate)
}}
```

The empty-state copy must say that users can drag, click to choose, or paste content. The selected list keeps `FileTransferRow`, but the send label becomes `发送 N 项`. Render `PasteConfirmDialog` from the panel and do not call `onSendFiles` from its confirm callback.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `bun run --cwd apps/web test -- src/components/TransferPanel.test.tsx`

Expected: all retained file/recipient/progress tests and new unified paste tests pass; no `role="tab"` or text-input assertions remain.

- [ ] **Step 5: Commit the unified sender surface**

```bash
git add apps/web/src/components/TransferPanel.tsx apps/web/src/components/TransferPanel.test.tsx
git commit -m "feat(web): unify transfer panel uploads"
```

## Task 4: 统一 App 的新发送 payload 和重试

**Files:**

- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/App.test.tsx`

**Interfaces:**

- Consumes the boolean `onFilesAdded` contract from Task 3.
- Produces a single new-send payload shape: `{ kind: 'file'; selections: FileSelection[]; peerIds: string[] }`.
- Removes `incomingTexts`, `ReceivedTextDialog`, and all old text receiver state; the receiver accepts only file requests.

- [ ] **Step 1: Update App tests to describe the new sender contract**

Remove direct `onSendText` mock expectations and all incoming text event tests. Add assertions that the rendered sender receives only `onSendFiles`, and add a retry assertion that always calls the file offer path:

```ts
expect(peerSession.offerText).not.toHaveBeenCalled()
expect(peerSession.offerFiles).toHaveBeenCalledWith(
  expect.arrayContaining([
    expect.objectContaining({ file: expect.objectContaining({ name: '粘贴内容.txt' }) }),
  ]),
  ['peer-1'],
)
```

- [ ] **Step 2: Run the focused App tests to verify the new assertions fail**

Run: `bun run --cwd apps/web test -- src/App.test.tsx`

Expected: FAIL while `OutgoingPayload` still has a text branch and `handleSendText` still calls `offerText`.

- [ ] **Step 3: Remove only the new sender text branch**

Change `OutgoingPayload` to:

```ts
type OutgoingPayload = {
  kind: 'file'
  selections: FileSelection[]
  peerIds: string[]
}
```

Delete `handleSendText`, change `handleFilesAdded` to return `false` on `addFileSelections` failure and `true` after `replaceFileSelections`, and remove `onSendText` from the `TransferPanel` render. Simplify `handleRetry` so it validates `payload.kind === 'file'` and calls only `peerSession.offerFiles(payload.selections, targetPeerIds)`.

Do not keep any old text compatibility path in `App`: remove `incomingTexts`, `planIncomingText`, `ReceivedTextDialog`, and the `transfer:text-received` event branch. The protocol and PeerSession cleanup is handled in the next task.

- [ ] **Step 4: Run the focused App tests to verify they pass**

Run: `bun run --cwd apps/web test -- src/App.test.tsx`

Expected: new sender payload/retry assertions and file-only receiver tests pass.

- [ ] **Step 5: Commit the App sender state change**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "refactor(web): send pasted content as files"
```

## Task 5: 删除旧文本协议和文本接收 UI

**Files:**

- Modify: `packages/contracts/src/transfer.ts`, `packages/contracts/src/transfer.test.ts`, `packages/contracts/src/index.ts`
- Modify: `apps/web/src/features/transfer/peer-session.ts`, `apps/web/src/features/transfer/peer-session.test.ts`
- Modify: `apps/web/src/features/transfer/ui-state.ts`, `apps/web/src/features/transfer/ui-state.test.ts`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/App.test.tsx`
- Delete: `apps/web/src/components/ReceivedTextDialog.tsx`, `apps/web/src/components/ReceivedTextDialog.test.tsx`

**Interfaces:**

- Produces a file-only `TransferProtocolMessage`, `PeerSessionEvent`, `PeerSession`, `OutgoingActivity`, and `CreateActivityInput` surface.
- Removes `MAX_TEXT_CHARACTERS`, `transfer:text`, text receipt, `offerText`, `acknowledgeText`, `discardText`, `IncomingTextEvent`, and `planIncomingText`.

- [ ] **Step 1: Replace text protocol tests with file-only expectations**

Delete tests whose only purpose is accepting, sending, receiving, acknowledging, discarding, or rendering text transfers. Add a parser regression test:

```ts
test('rejects the removed text transfer frame', () => {
  expectProtocolError({
    v: 2,
    type: 'transfer:text',
    transferId: 'legacy-text',
    text: '旧文本',
  })
})
```

Remove the App mock methods `offerText`, `acknowledgeText`, and `discardText`, and remove assertions for `收到文本`. Keep file request, file receipt, file progress, retry, and TXT-as-file tests.

- [ ] **Step 2: Remove text from contracts**

In `packages/contracts/src/transfer.ts`, remove `MAX_TEXT_CHARACTERS`, the `transfer:text` union member, the text receipt union member, the `value.type === 'transfer:text'` parser branch, and the `value.kind === 'text'` receipt parser branch. Keep `textByteLength` because it still enforces UTF-8 byte limits for control frames and file metadata. Remove the corresponding export from `packages/contracts/src/index.ts` and update `packages/contracts/src/transfer.test.ts`.

- [ ] **Step 3: Remove text state and methods from PeerSession**

Delete `PendingIncomingText`, `OutgoingTextPeer`, `OutgoingTextTransfer`, the `incomingTexts` map, text timeout cleanup, the `transfer:text` control-frame branch, text receipt handling, `finishTextPeer`, and all text branches in cancel/error/close paths. Set `OutgoingTransfer = OutgoingFileTransfer`, remove the three text methods from `PeerSession`, and remove the text member from `PeerSessionEvent`. Keep file receipt/progress behavior unchanged.

The resulting public methods must be:

```ts
offerFiles(files: readonly FileSelection[], targetPeerIds?: readonly string[]): TransferOfferResult
acceptFiles(peerId: string, transferId: string): boolean
rejectFiles(peerId: string, transferId: string): boolean
cancelTransfer(transferId: string): boolean
```

- [ ] **Step 4: Remove text activity and App receiver state**

In `ui-state.ts`, change activity kind inputs to `'file'`, remove `IncomingTextEvent`, `IncomingTextPlan`, and `planIncomingText`, remove text phase/accepted-peer branches, and make `createActivity` initialize file activity as `requesting` with unaccepted peers.

In `App.tsx`, remove the `ReceivedTextDialog` import, `IncomingText` type, incoming text state/ref/replacement callback, text copy state/ref, `transfer:text-received` event branch, text queue cleanup, text copy handler, and rendered text dialog. Keep the file request/receive event flow and the file-only `OutgoingPayload` from Task 4. Delete both `ReceivedTextDialog` source and test files.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `bun run --cwd packages/contracts test`, `bun run --cwd apps/web test -- src/features/transfer/peer-session.test.ts src/features/transfer/ui-state.test.ts src/App.test.tsx`, and `bun run --cwd apps/web typecheck`.

Expected: old text frames are rejected, PeerSession exposes only file methods, UI-state has only file activities, App has no text receiver UI, and all focused tests/typecheck pass.

- [ ] **Step 6: Commit the file-only protocol cleanup**

```bash
git add packages/contracts/src/transfer.ts packages/contracts/src/transfer.test.ts packages/contracts/src/index.ts apps/web/src/features/transfer/peer-session.ts apps/web/src/features/transfer/peer-session.test.ts apps/web/src/features/transfer/ui-state.ts apps/web/src/features/transfer/ui-state.test.ts apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/components/ReceivedTextDialog.tsx apps/web/src/components/ReceivedTextDialog.test.tsx
git commit -m "refactor: remove legacy text transfer protocol"
```

## Task 6: 为接收完成的 TXT 增加复制内容操作

**Files:**

- Modify: `apps/web/src/components/IncomingFileRequestDialog.tsx`
- Test: `apps/web/src/components/IncomingFileRequestDialog.test.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**

- Extends `IncomingFileRequestItem` with optional `mimeType?: string`.
- Extends `DownloadableReceivedFile` with required `blob: Blob`.
- `App` must pass `event.files[].mimeType` into request items and preserve `event.files[].blob` with the object URL.

- [ ] **Step 1: Add failing copy tests**

Add a received-state fixture with `name: '粘贴内容.txt'`, `mimeType: 'text/plain'`, `blob: new Blob(['第一行\n第二行'], { type: 'text/plain' })`, and a fake URL. Mock the browser clipboard and verify the explicit action:

```tsx
test('copies received txt content and keeps download available', async () => {
  const user = userEvent.setup()
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.assign(navigator, { clipboard: { writeText } })

  renderDialog({
    files: [{ fileId: 'txt-1', name: '粘贴内容.txt', byteLength: 14, mimeType: 'text/plain' }],
    state: {
      status: 'received',
      files: [{
        fileId: 'txt-1',
        name: '粘贴内容.txt',
        byteLength: 14,
        mimeType: 'text/plain',
        blob: new Blob(['第一行\n第二行'], { type: 'text/plain' }),
        url: 'blob:txt-1',
      }],
    },
  })

  await user.click(screen.getByRole('button', { name: '复制粘贴内容.txt 的内容' }))

  expect(writeText).toHaveBeenCalledWith('第一行\n第二行')
  expect(screen.getByRole('button', { name: '已复制粘贴内容.txt 的内容' })).toBeVisible()
  expect(screen.getByRole('link', { name: '下载 粘贴内容.txt' })).toBeVisible()
})
```

Also test that a non-text file does not render a copy action and that a rejected clipboard write changes the button to `复制失败粘贴内容.txt 的内容` with an accessible error message.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bun run --cwd apps/web test -- src/components/IncomingFileRequestDialog.test.tsx`

Expected: FAIL because received files do not preserve Blob data and the dialog has no copy action.

- [ ] **Step 3: Preserve metadata and Blob data in App**

Change the incoming file request mapping to include `mimeType: file.mimeType` and change the received mapping to return:

```ts
return {
  fileId: file.fileId,
  name: file.name,
  byteLength: file.byteLength,
  mimeType: file.mimeType,
  blob: file.blob,
  url,
}
```

Continue storing and revoking the object URL exactly as before.

- [ ] **Step 4: Implement copy state and action rendering**

Use `type CopyStatus = 'idle' | 'copying' | 'copied' | 'error'`, a `Record<string, CopyStatus>`, and a timer map keyed by `fileId`. A file is copyable when `file.mimeType === 'text/plain'` or `file.name.toLowerCase().endsWith('.txt')`.

```ts
const copyText = async (file: DownloadableReceivedFile) => {
  setCopyStatusByFileId(current => ({ ...current, [file.fileId]: 'copying' }))
  try {
    if (typeof navigator.clipboard?.writeText !== 'function') {
      throw new Error('当前浏览器不支持剪贴板写入')
    }
    await navigator.clipboard.writeText(await file.blob.text())
    setCopyStatusByFileId(current => ({ ...current, [file.fileId]: 'copied' }))
    const timer = window.setTimeout(() => {
      setCopyStatusByFileId(current => ({ ...current, [file.fileId]: 'idle' }))
      copyTimersRef.current.delete(file.fileId)
    }, 2000)
    copyTimersRef.current.set(file.fileId, timer)
  } catch {
    setCopyStatusByFileId(current => ({ ...current, [file.fileId]: 'error' }))
  }
}
```

Clear all timers on unmount and when the request key changes. In the `FileTransferRow` action slot, render a compact group: a copy button for copyable received text and the existing download link. Use labels `复制文件名 的内容`, `已复制文件名 的内容`, or `复制失败文件名 的内容`, with `aria-live="polite"` status text. Keep both actions at least 44px high and stop click propagation where needed.

- [ ] **Step 5: Run the focused test to verify it passes**

Run: `bun run --cwd apps/web test -- src/components/IncomingFileRequestDialog.test.tsx`

Expected: TXT copy success, persistent success label, failure feedback, non-text behavior, and download tests pass.

- [ ] **Step 6: Commit the receiver copy action**

```bash
git add apps/web/src/components/IncomingFileRequestDialog.tsx apps/web/src/components/IncomingFileRequestDialog.test.tsx apps/web/src/App.tsx
git commit -m "feat(web): add copy action for received text files"
```

## Task 7: 更新真实浏览器 E2E

**Files:**

- Modify: `apps/web/e2e/room-transfer.spec.ts`

**Interfaces:**

- Consumes the stable accessible labels from Tasks 2–5: `上传要传输的内容`, `确认添加粘贴内容`, `添加到传输列表`, `复制粘贴内容.txt 的内容`.
- Produces coverage for the real two-context file request, accept, Blob receipt, clipboard copy, and focus-scoped paste flow.

- [ ] **Step 1: Replace the old text-transfer E2E flow**

In the first two-context test, remove the text textarea and `收到文本` assertions. Grant clipboard permissions, write text to the sender context clipboard, focus the upload surface, press `Control+V`, confirm adding to the list, and assert the sender shows `粘贴内容.txt` before sending.

```ts
await sender.grantPermissions(['clipboard-read', 'clipboard-write'])
await receiver.grantPermissions(['clipboard-read', 'clipboard-write'])
const text = `真实浏览器粘贴 ${Date.now()}`
const upload = senderPage.getByRole('button', { name: '上传要传输的内容' })

await senderPage.evaluate(value => navigator.clipboard.writeText(value), text)
await upload.focus()
await senderPage.keyboard.press('Control+V')

const pasteDialog = senderPage.getByRole('dialog', { name: '确认添加粘贴内容' })
await expect(pasteDialog).toBeVisible()
await pasteDialog.getByRole('button', { name: '添加到传输列表' }).click()
await expect(senderPage.getByText('粘贴内容.txt')).toBeVisible()
```

- [ ] **Step 2: Assert that the pasted text uses the file receiver flow**

Send the single item with the unified `发送 1 项` button. On the receiver, accept `收到文件`, wait for `复制粘贴内容.txt 的内容`, click it, and read the browser clipboard:

```ts
await senderPage.getByRole('button', { name: '发送 1 项' }).click()
const fileDialog = receiverPage.getByRole('dialog', { name: '收到文件' })
await fileDialog.getByRole('button', { name: '接收全部' }).click()

const copyButton = fileDialog.getByRole('button', { name: '复制粘贴内容.txt 的内容' })
await expect(copyButton).toBeVisible({ timeout: 30_000 })
await copyButton.click()
await expect(fileDialog.getByRole('button', { name: '已复制粘贴内容.txt 的内容' })).toBeVisible()
await expect.poll(() => receiverPage.evaluate(() => navigator.clipboard.readText())).toBe(text)
await expect(fileDialog.getByRole('link', { name: '下载 粘贴内容.txt' })).toBeVisible()
```

- [ ] **Step 3: Add a real-browser paste-file confirmation case**

Dispatch a `ClipboardEvent` with a browser-created `DataTransfer` and `File` on the focused upload surface, then assert cancellation leaves the selected list unchanged and confirmation adds the file. This validates file-priority clipboard handling in Chromium without bypassing the application event path:

```ts
await upload.evaluate(element => {
  const data = new DataTransfer()
  data.items.add(new File(['clipboard file'], '剪贴板文件.txt', { type: 'text/plain' }))
  element.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: data,
    bubbles: true,
    cancelable: true,
  }))
})
const filePasteDialog = senderPage.getByRole('dialog', { name: '确认添加粘贴内容' })
await filePasteDialog.getByRole('button', { name: '取消' }).click()
await expect(senderPage.getByText('剪贴板文件.txt')).toHaveCount(0)
```

- [ ] **Step 4: Remove obsolete Tab selectors from the receiver-targeting test**

Keep the existing two-receiver targeting assertions, but use the always-visible upload input/drop zone and `发送 1 项`; do not click `role="tab"` or assert a text receiver dialog.

- [ ] **Step 5: Run the focused E2E suite**

Run: `bun run --cwd apps/web e2e -- room-transfer.spec.ts`

Expected: both real browser contexts complete room join, file request, accept, TXT copy, and receiver targeting without using the old text UI.

- [ ] **Step 6: Commit the E2E migration**

```bash
git add apps/web/e2e/room-transfer.spec.ts
git commit -m "test(e2e): cover pasted text file transfer"
```

## Task 8: 完成全量验证和交付检查

**Files:**

- Verify: all files changed by Tasks 1–6.

- [ ] **Step 1: Run the web unit tests**

Run: `bun run --cwd apps/web test`

Expected: all web unit tests pass, including the new paste, sender, App, and receiver copy tests.

- [ ] **Step 2: Run the repository verification suite**

Run: `bun run verify`

Expected: lint, all workspace tests, typecheck, and production builds pass.

- [ ] **Step 3: Run the browser suite again from the repository command**

Run: `bun run e2e`

Expected: the complete Playwright suite passes with the updated unified transfer flow.

- [ ] **Step 4: Check formatting and working tree state**

Run: `git diff --check` and `git status --short --branch`.

Expected: `git diff --check` exits 0; only intentional feature commits are present and no generated files, clipboard contents, or environment secrets are staged.

- [ ] **Step 5: Record the implementation handoff**

Summarize the final user-visible behavior, test commands and results, the temporary `transfer:text` compatibility decision, and the exact commit hashes. Do not create a release tag as part of this feature unless explicitly requested.
