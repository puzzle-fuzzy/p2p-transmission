# Release Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the current browser transfer product to a buildable, testable release candidate with working deep links, receiver recovery, consistent transfer limits, truthful share/privacy feedback, and correct speed tracking.

**Architecture:** Keep the existing React/Elysia/contracts boundaries and avoid a broad `App.tsx` refactor. Add one pure room-invite parser, repair the existing speed tracker around compound peer keys, and change lifecycle ordering only where persistence currently conflicts with runtime cleanup.

**Tech Stack:** Bun workspaces, React 19, Vite, TypeScript, Vitest/Testing Library, Bun test, Tailwind CSS v4, GitHub Actions.

## Global Constraints

- A file batch contains at most 10 files and at most 100 MiB.
- Shared URLs prefill a valid six-digit code but never join without a user click.
- Only receiver room recovery is supported in this release.
- No new runtime dependency is introduced.
- Preserve the existing Dark Workshop visual system and the local `TransferPanel` clear-button / “暂无接收者连接” work.
- Do not implement invitation-token authorization or receiver approval in this plan.
- Every task runs focused tests before its commit; the final task runs `bun run verify`.

---

### Task 1: Restore the transfer contract and preserve the pending file-action UX

**Files:**
- Modify: `packages/contracts/src/transfer.ts:5-6`
- Modify: `packages/contracts/src/transfer.test.ts:2-12,115-196`
- Modify: `apps/web/src/features/transfer/file-selection.ts:48-54`
- Modify: `apps/web/src/features/transfer/file-selection.test.ts`
- Modify: `apps/web/src/components/TransferPanel.tsx:68-75,302-307,388-425`
- Modify: `apps/web/src/components/TransferPanel.test.tsx:236-304`
- Modify: `apps/web/README.md:3-5`

**Interfaces:**
- Consumes: `MAX_FILE_COUNT`, `MAX_FILE_BATCH_BYTES` from `@p2p/contracts`.
- Produces: one consistent 10-file/100-MiB boundary for the selector, protocol, UI, tests, and documentation.

- [ ] **Step 1: Correct the failing contract tests first**

Import the missing constant and express boundaries from the constants:

```ts
import {
  DEFAULT_FILE_CHUNK_BYTES,
  encodeTransferMessage,
  MAX_CONTROL_FRAME_BYTES,
  MAX_FILE_BATCH_BYTES,
  MAX_FILE_COUNT,
  parseTransferMessage,
  sanitizeFileName,
  textByteLength,
  type FileDescriptor,
  type TransferProtocolMessage,
} from './transfer'
```

Replace the stale `eleven` fixture with `MAX_FILE_COUNT + 1` descriptors, and keep the exact-boundary test at `MAX_FILE_COUNT`.

- [ ] **Step 2: Run the contract test and confirm the current constants make the restored expectation fail**

Run: `bun run --cwd packages/contracts test`

Expected before implementation: the overflow assertion accepts 11 files because `MAX_FILE_COUNT` is still 50.

- [ ] **Step 3: Restore the contract constants**

```ts
export const MAX_FILE_COUNT = 10
export const MAX_FILE_BATCH_BYTES = 100 * 1024 * 1024
```

- [ ] **Step 4: Restore web validation and visible limit copy**

Use `文件总大小不能超过 100 MiB` in `file-selection.ts` and `一次最多 10 个文件，总计不超过 100 MiB` in `TransferPanel.tsx`. Keep the pre-existing local `清空` button, `fileSubmitLabel`, and disabled `暂无接收者连接` state unchanged.

- [ ] **Step 5: Update selection and component boundary tests**

The tests must cover exactly 10 files, reject 11, accept exactly 100 MiB, reject 100 MiB plus one byte, clear the current list, and retain the no-receiver label.

- [ ] **Step 6: Run focused validation**

Run:

```bash
bun run --cwd packages/contracts test
bun run --cwd apps/web test src/features/transfer/file-selection.test.ts src/components/TransferPanel.test.tsx
```

Expected: all selected suites pass.

- [ ] **Step 7: Commit the coherent transfer-limit and pending UX change**

```bash
git add packages/contracts/src/transfer.ts packages/contracts/src/transfer.test.ts apps/web/src/features/transfer/file-selection.ts apps/web/src/features/transfer/file-selection.test.ts apps/web/src/components/TransferPanel.tsx apps/web/src/components/TransferPanel.test.tsx apps/web/README.md
git commit -m "fix: restore safe transfer limits"
```

### Task 2: Add safe room-link prefill and truthful lobby copy

**Files:**
- Create: `apps/web/src/features/room/room-invite.ts`
- Create: `apps/web/src/features/room/room-invite.test.ts`
- Create: `apps/web/src/components/RoomJoin.test.tsx`
- Modify: `apps/web/src/components/RoomJoin.tsx:3-16,53-113`
- Modify: `apps/web/src/App.tsx:1280-1290`

**Interfaces:**
- Produces: `parseRoomCodeFromSearch(search: string): string | undefined`.
- Produces: optional `RoomJoinProps.initialCode?: string`.
- Consumes: browser `window.location.search` only at the `App` composition boundary.

- [ ] **Step 1: Write pure parser tests**

Cover:

```ts
expect(parseRoomCodeFromSearch('?room=123456')).toBe('123456')
expect(parseRoomCodeFromSearch('?room=12345')).toBeUndefined()
expect(parseRoomCodeFromSearch('?room=1234567')).toBeUndefined()
expect(parseRoomCodeFromSearch('?room=12a456')).toBeUndefined()
expect(parseRoomCodeFromSearch('?room=123456&room=654321')).toBeUndefined()
expect(parseRoomCodeFromSearch('')).toBeUndefined()
```

- [ ] **Step 2: Run the parser test and confirm it fails because the helper does not exist**

Run: `bun run --cwd apps/web test src/features/room/room-invite.test.ts`

Expected: module resolution failure.

- [ ] **Step 3: Implement the pure parser**

```ts
export const parseRoomCodeFromSearch = (search: string) => {
  const values = new URLSearchParams(search).getAll('room')
  if (values.length !== 1) return undefined
  const [value] = values
  return value && /^\d{6}$/u.test(value) ? value : undefined
}
```

- [ ] **Step 4: Write RoomJoin interaction tests**

Render with `initialCode="123456"`, assert six inputs contain the six digits, assert `onJoinRoom` is not called during render, click “加入房间”, then assert it receives `123456`. Render with no initial code and assert every input is empty.

- [ ] **Step 5: Implement controlled prefill and privacy copy**

Initialize digits with a normalization helper:

```ts
const initialDigits = (code?: string) =>
  /^\d{6}$/u.test(code ?? '') ? Array.from(code as string) : Array.from({ length: 6 }, () => '')
```

Replace the lobby statement with the exact approved wording from the design spec. Use at least `text-amber-50/60` for this 12px trust text.

- [ ] **Step 6: Compose the parser in App**

```ts
const initialRoomCode = parseRoomCodeFromSearch(window.location.search)
```

Pass `initialCode={initialRoomCode}` to `RoomJoin`; do not call `handleJoinRoom` from the query parameter.

- [ ] **Step 7: Run focused validation and commit**

Run:

```bash
bun run --cwd apps/web test src/features/room/room-invite.test.ts src/components/RoomJoin.test.tsx
bun run --cwd apps/web typecheck
```

The typecheck may still report the already-known App speed/share issues, but it must report no errors in the new parser or `RoomJoin`.

Commit:

```bash
git add apps/web/src/features/room/room-invite.ts apps/web/src/features/room/room-invite.test.ts apps/web/src/components/RoomJoin.tsx apps/web/src/components/RoomJoin.test.tsx apps/web/src/App.tsx
git commit -m "feat: prefill shared room links"
```

### Task 3: Repair receiver persistence and remove the first-render crash

**Files:**
- Modify: `apps/web/src/App.tsx:421-525,940-1020`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/lib/room-session.ts:5-17`
- Add or modify: `apps/web/src/lib/room-session.test.ts`

**Interfaces:**
- Consumes: `handleJoinRoom(code: string): Promise<void>` after its declaration.
- Produces: persisted receiver-only `RoomSession` values and one recovery attempt per app boot.

- [ ] **Step 1: Add failing App tests for lifecycle ordering**

Add tests that prove:

- App mounts in StrictMode without throwing.
- A valid saved receiver room causes exactly one join after visitor boot.
- Recovery does not delete the stored room before the join resolves.
- Successful join updates the stored expiry after `connectRealtime` initializes.
- Sender room creation never persists a recoverable room entry.
- Expired receiver entries are cleared and do not join.

- [ ] **Step 2: Run the App suite and observe the existing TDZ failure**

Run: `bun run --cwd apps/web test src/App.test.tsx`

Expected: `Cannot access 'handleJoinRoom' before initialization`.

- [ ] **Step 3: Move the recovery effect below `handleJoinRoom`**

The effect body remains guarded by lobby phase, available visitor session, and `roomRecoveryAttemptedRef`. It handles only `role === 'receiver'`, does not call `clearRoomSession()` before joining, and invokes the promise explicitly:

```ts
void handleJoinRoom(roomSession.roomCode)
```

- [ ] **Step 4: Persist only after realtime initialization**

For receiver join, call `connectRealtime(...)` first, then save:

```ts
connectRealtime(result.session, result.value, 'receiver', rtcConfiguration, operationGeneration)
saveRoomSession({
  roomCode: result.value.room.code,
  role: 'receiver',
  expiresAt: result.value.room.expiresAt,
})
```

Remove sender `saveRoomSession` because sender recovery is unsupported in this release.

- [ ] **Step 5: Narrow the persisted role contract**

```ts
export type RoomSession = {
  roomCode: string
  role: 'receiver'
  expiresAt: number
}
```

Validate the exact role and exact six-digit room code when loading.

- [ ] **Step 6: Run focused validation and commit**

Run:

```bash
bun run --cwd apps/web test src/App.test.tsx src/lib/room-session.test.ts
```

Expected: the App integration suite no longer fails at first render and all new recovery assertions pass.

Commit:

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/lib/room-session.ts apps/web/src/lib/room-session.test.ts
git commit -m "fix: stabilize receiver room recovery"
```

### Task 4: Make speed and ETA tracking peer-safe

**Files:**
- Modify: `apps/web/src/features/transfer/transfer-speed-tracker.ts`
- Create: `apps/web/src/features/transfer/transfer-speed-tracker.test.ts`
- Modify: `apps/web/src/App.tsx:49-54,252-326`
- Modify: `apps/web/src/App.test.tsx`

**Interfaces:**
- Produces: `speedSampleKey(event)` or equivalent stable compound key.
- Produces: `SpeedTracker.record(key, bytes, totalBytes)`, `getSpeed(key)`, `getEta(key)`, `reset(key)`, and `clear()`.
- Consumes: `FileProgressEvent` fields `direction`, `transferId`, `peerId`, `fileId`, `fileBytes`, and `fileTotalBytes`.

- [ ] **Step 1: Add deterministic tracker tests**

Using an injected clock, cover two samples producing a finite speed, ETA using the stored total, throttled samples, byte regression, reset, clear, and two compound keys for the same file remaining isolated.

- [ ] **Step 2: Run the tracker test and confirm the old signature/behavior fails**

Run: `bun run --cwd apps/web test src/features/transfer/transfer-speed-tracker.test.ts`

Expected: ETA/interface and key-isolation assertions fail.

- [ ] **Step 3: Store total bytes in each sample**

```ts
export type SpeedSample = {
  timestamp: number
  bytes: number
  totalBytes: number
}
```

`getEta(key)` reads the last sample’s total, subtracts the last byte count, and divides by the current speed. Remove unused standalone formatting imports from `App.tsx`; `FileTransferRow` owns presentation formatting.

- [ ] **Step 4: Integrate compound keys and aggregation in App**

For every progress event, record its compound key regardless of direction. For incoming rows, select that event’s sample. For outgoing rows, examine active accepted peers for each file and expose the minimum positive speed plus maximum finite ETA. Never mix a receiver’s byte regression into another receiver’s sample.

- [ ] **Step 5: Add multi-peer integration coverage**

Push progress for two peers carrying the same file at different rates; assert the displayed data follows the slower peer and remains finite when the faster peer completes.

- [ ] **Step 6: Run focused validation and commit**

Run:

```bash
bun run --cwd apps/web test src/features/transfer/transfer-speed-tracker.test.ts src/App.test.tsx src/components/FileTransferRow.test.tsx
bun run --cwd apps/web typecheck
```

Expected: no speed-tracker TypeScript errors and the focused suites pass, apart from any still-unfixed ShareDialog/session-test errors assigned to later tasks.

Commit:

```bash
git add apps/web/src/features/transfer/transfer-speed-tracker.ts apps/web/src/features/transfer/transfer-speed-tracker.test.ts apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "fix: isolate transfer speed samples"
```

### Task 5: Make sharing and clipboard feedback truthful

**Files:**
- Create: `apps/web/src/components/ShareDialog.test.tsx`
- Modify: `apps/web/src/components/ShareDialog.tsx:4-8,63-88,143-153`
- Modify: `apps/web/src/App.tsx:1255-1264,1388-1394`
- Modify: `apps/web/src/App.test.tsx`

**Interfaces:**
- Changes: `ShareDialogProps.onCopy(value: string): Promise<void>`.
- Produces: App clipboard helper with a value-specific success message.

- [ ] **Step 1: Add failing ShareDialog tests**

Cover room-code copy success, room-link fallback success, rejected copy, native-share success, and native-share `AbortError`. Assert “已复制” appears only after a copy promise resolves.

- [ ] **Step 2: Run the tests and observe premature success**

Run: `bun run --cwd apps/web test src/components/ShareDialog.test.tsx`

Expected: current synchronous `onCopy` behavior fails asynchronous assertions.

- [ ] **Step 3: Await clipboard operations**

```ts
const handleCopyCode = async () => {
  await onCopy(roomCode)
  setCopyStatus('copied')
}
```

Use `onClick={() => { void handleCopyCode() }}` and catch rejection without changing to a success state.

- [ ] **Step 4: Safely detect native share**

Resolve an optional function from a narrowed navigator shape:

```ts
const nativeShare = (navigator as {
  share?: (data?: ShareData) => Promise<void>
}).share
```

Only call when `typeof nativeShare === 'function'`. Return silently on `AbortError`; use awaited URL copy only when native sharing is unavailable or fails for a non-cancellation reason.

- [ ] **Step 5: Split clipboard success messages in App**

The App callback receives both value and message, writes the exact value, and shows either `房间码已复制` or `房间链接已复制`. On failure it shows a matching recovery toast and rethrows so the dialog does not report success.

- [ ] **Step 6: Run focused validation and commit**

Run:

```bash
bun run --cwd apps/web test src/components/ShareDialog.test.tsx src/App.test.tsx
bun run --cwd apps/web typecheck
```

Commit:

```bash
git add apps/web/src/components/ShareDialog.tsx apps/web/src/components/ShareDialog.test.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "fix: report room sharing results accurately"
```

### Task 6: Clear remaining test and presentation regressions

**Files:**
- Modify: `apps/web/src/components/IncomingFileRequestDialog.tsx:220-228`
- Modify: `apps/web/src/components/TransferPeerFlow.test.tsx`
- Modify: `apps/web/src/features/room/session-lifecycle.test.ts:31,50`
- Modify only if required by focused failures: corresponding existing component tests.

**Interfaces:**
- Preserves: 44px circular per-file download target.
- Preserves: Tailwind v4 `max-sm:size-8!` important modifier.

- [ ] **Step 1: Restore the circular download target**

Add `rounded-full` to the existing `size-11` download link. Do not add a border or shadow.

- [ ] **Step 2: Align Tailwind v4 assertions**

Change stale test expectations from `max-sm:!size-8` to `max-sm:size-8!`; do not rewrite the already-correct production class.

- [ ] **Step 3: Make test timer handles explicit**

Use the deliberate cross-environment cast:

```ts
1 as unknown as ReturnType<typeof setTimeout>
```

and the equivalent for the second fixture. Production timer types remain unchanged.

- [ ] **Step 4: Run the full web validation**

Run:

```bash
bun run --cwd apps/web test
bun run --cwd apps/web lint
bun run --cwd apps/web typecheck
bun run --cwd apps/web build
```

Expected: all web tests pass, lint has zero warnings, typecheck passes, and Vite produces a production bundle.

- [ ] **Step 5: Commit presentation/test cleanup**

```bash
git add apps/web/src/components/IncomingFileRequestDialog.tsx apps/web/src/components/TransferPeerFlow.test.tsx apps/web/src/features/room/session-lifecycle.test.ts
git commit -m "fix: align transfer presentation tests"
```

### Task 7: Add the release verification gate and run the repository audit

**Files:**
- Create: `.github/workflows/verify.yml`
- Modify only if final verification exposes a directly related stabilization regression: the responsible file from Tasks 1-6.

**Interfaces:**
- Produces: a CI gate for pull requests and pushes to `main`.

- [ ] **Step 1: Add the pinned CI workflow**

```yaml
name: Verify

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - run: bun install --frozen-lockfile
      - run: bun run verify
```

- [ ] **Step 2: Run dependency and workspace verification locally**

Run:

```bash
bun install --frozen-lockfile
bun run verify
```

Expected:

- contracts tests pass;
- API tests pass;
- web tests pass;
- every lint and typecheck task passes;
- API and Web production builds pass.

- [ ] **Step 3: Review the final diff and worktree**

Run:

```bash
git diff --check
git status --short --branch
git log --oneline --decorate -10
```

Confirm no generated `dist`, `.env`, secret, or unrelated user file is staged.

- [ ] **Step 4: Commit the CI gate**

```bash
git add .github/workflows/verify.yml
git commit -m "ci: verify main release quality"
```

- [ ] **Step 5: Run one final post-commit verification**

Run: `bun run verify`

Expected: exit code 0 with all workspace tasks successful.

