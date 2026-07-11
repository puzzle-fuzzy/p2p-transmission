# Transfer Experience and File Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Deliver the confirmed receiver text dialog, room-code copy action, real transfer-avatar motion, and consent-gated WebRTC file batches of at most 10 files and 100 MiB.

**Architecture:** Upgrade the DataChannel contract to protocol v2, keep JSON control frames separate from headed ArrayBuffer chunks, and isolate binary pumping/backpressure in a file-transfer engine rather than growing PeerSession further. React consumes typed PeerSession events through pure presentation helpers; App is the sole owner of protocol acknowledgements, dialogs, clipboard calls, object URLs, progress-frame scheduling, and the 400 ms generation-safe terminal presentation.

**Tech Stack:** Bun workspaces, TypeScript 6, React 19, Vite 8, Vitest 4, Testing Library, Tailwind CSS 4, WebRTC RTCDataChannel.

## Global Constraints

- Preserve the Dark Workshop visual system: flat #2d2d2d surfaces, Signal Purple #5e11d1 only, no shadows, no gradients.
- Text is delivered immediately; its receiver dialog contains the exact body and only 复制 / 关闭 actions.
- Only file batches expose 接收 / 拒绝; rejected peers receive zero binary chunks.
- One active outgoing transfer exists at a time.
- A batch contains 1–10 files and no more than 100 MiB total.
- DataChannel protocol is p2p-transfer.v2; v1 is not accepted by PeerSession.
- Binary chunks use a 16-byte P2P2 header, negotiated payload size, strict index checking, and backpressure.
- No text or file body passes through WebSocket or API.
- Every timer, AbortController, Blob part, object URL, and backpressure waiter is cleaned on terminal state, room reset, or unmount.
- All visible normal text meets WCAG AA; all controls are keyboard accessible.
- prefers-reduced-motion disables looping Avatar motion.

---

## File Map

### Shared contracts

- Modify: packages/contracts/src/transfer.ts — protocol v2 control messages and validation.
- Create: packages/contracts/src/file-chunk.ts — binary frame encoder/parser.
- Modify: packages/contracts/src/transfer.test.ts — v2 control-frame coverage.
- Create: packages/contracts/src/file-chunk.test.ts — binary golden/invalid frame coverage.
- Modify: packages/contracts/src/index.ts — public exports.

### Web transfer domain

- Create: apps/web/src/features/transfer/file-selection.ts — local file-list rules.
- Create: apps/web/src/features/transfer/file-selection.test.ts.
- Create: apps/web/src/features/transfer/file-transfer-engine.ts — per-peer binary pump, drain, cancellation, and tombstones.
- Create: apps/web/src/features/transfer/file-transfer-engine.test.ts.
- Modify: apps/web/src/features/transfer/peer-session.ts — v2 orchestration and typed events.
- Modify: apps/web/src/features/transfer/peer-session.test.ts.
- Create: apps/web/src/features/transfer/ui-state.ts — pure outgoing activity/FIFO aggregation.
- Create: apps/web/src/features/transfer/ui-state.test.ts.
- Create: apps/web/src/features/transfer/progress-frame.ts — one React-facing progress flush per animation frame.
- Create: apps/web/src/features/transfer/progress-frame.test.ts.

### Web UI

- Create: apps/web/src/components/TransferPeerFlow.tsx.
- Create: apps/web/src/components/ReceivedTextDialog.tsx.
- Create: apps/web/src/components/IncomingFileRequestDialog.tsx.
- Create: apps/web/src/components/RoomCodeCopyButton.tsx.
- Create: apps/web/src/components/ReceiverPanel.tsx.
- Modify: apps/web/src/components/TransferPanel.tsx.
- Modify: apps/web/src/App.tsx.
- Create: apps/web/src/App.test.tsx.
- Modify: apps/web/src/index.css.
- Delete: apps/web/src/components/IncomingTextRequestDialog.tsx.
- Delete: apps/web/src/components/ReceivedTextView.tsx after ReceiverPanel replaces its remaining waiting states.

### Web component tests

- Create: apps/web/src/test/dom.ts.
- Create: apps/web/src/components/TransferPeerFlow.test.tsx.
- Create: apps/web/src/components/ReceivedTextDialog.test.tsx.
- Create: apps/web/src/components/IncomingFileRequestDialog.test.tsx.
- Create: apps/web/src/components/RoomCodeCopyButton.test.tsx.
- Create: apps/web/src/components/TransferPanel.test.tsx.
- Modify: apps/web/package.json and bun.lock for Testing Library/jsdom.

---

### Task 1: Protocol v2 Control and Binary Contracts

**Files:**
- Modify: packages/contracts/src/transfer.ts
- Create: packages/contracts/src/file-chunk.ts
- Modify: packages/contracts/src/transfer.test.ts
- Create: packages/contracts/src/file-chunk.test.ts
- Modify: packages/contracts/src/index.ts

**Interfaces:**
- Produces: FileDescriptor, TransferProtocolMessage, parseTransferMessage, encodeTransferMessage, sanitizeFileName.
- Produces: encodeFileChunkFrame, parseFileChunkFrame, FileChunkFrame.
- Consumes: no DOM, File, Blob, React, WebRTC, or service APIs.

- [ ] **Step 1: Replace existing parser expectations with failing v2 control tests**

Write table tests for every exact v2 frame plus boundary failures:

~~~ts
const files = [{
  fileId: 'file_1',
  streamId: 1,
  name: '设计稿.png',
  mimeType: 'image/png',
  byteLength: 3,
  lastModified: 1,
  chunkSize: 16_384,
  chunkCount: 1,
}]

expectProtocolMessage({
  v: 2,
  type: 'transfer:text',
  transferId: 'tx_1',
  text: '你好\n🙂',
})

expectProtocolMessage({
  v: 2,
  type: 'transfer:file-request',
  transferId: 'tx_2',
  files,
})
~~~

Add explicit cases for v1 rejection, 10 files, 11 files, exactly 100 MiB, 100 MiB + 1, duplicate fileId, duplicate/zero streamId, invalid chunkCount, UTF-8 name/MIME byte overflow, fractional/NaN/Infinity sizes, extra keys, and an over-16-KiB control frame. Test `sanitizeFileName` against `../secret`, Windows separators, NUL/C0/C1 controls, whitespace-only, `.`, and `..`; it strips controls and `/\\`, trims, and falls back to `未命名文件` when no safe display/download name remains.

- [ ] **Step 2: Add failing binary codec tests**

Use one golden frame and byte offsets:

~~~ts
const encoded = encodeFileChunkFrame({
  streamId: 0x01020304,
  chunkIndex: 0x05060708,
  payload: new Uint8Array([0xaa, 0xbb]),
}, 2)

expect(Array.from(new Uint8Array(encoded))).toEqual([
  0x50, 0x32, 0x50, 0x32,
  0x02, 0x01, 0x00, 0x10,
  0x01, 0x02, 0x03, 0x04,
  0x05, 0x06, 0x07, 0x08,
  0xaa, 0xbb,
])
~~~

Add invalid magic, version, type, header length, zero/fractional/out-of-uint32 streamId, negative/fractional/out-of-uint32 chunkIndex, empty payload, and configured payload-limit cases for both encoder and parser.

- [ ] **Step 3: Run contract tests and confirm red**

Run: bun test packages/contracts/src/transfer.test.ts packages/contracts/src/file-chunk.test.ts

Expected: FAIL because the current v1 parser rejects v2 and file-chunk.ts does not exist.

- [ ] **Step 4: Implement exact v2 types and validation**

Define these exported limits and descriptor:

~~~ts
export const TRANSFER_PROTOCOL_VERSION = 2
export const MAX_CONTROL_FRAME_BYTES = 16 * 1024
export const MAX_FILE_COUNT = 10
export const MAX_FILE_BATCH_BYTES = 100 * 1024 * 1024
export const MAX_FILE_NAME_CHARACTERS = 255
export const MAX_FILE_NAME_BYTES = 255
export const MAX_MIME_TYPE_CHARACTERS = 128
export const MAX_MIME_TYPE_BYTES = 128
export const DEFAULT_FILE_CHUNK_BYTES = 16 * 1024
export const FILE_CHUNK_HEADER_BYTES = 16

export type FileDescriptor = {
  fileId: string
  streamId: number
  name: string
  mimeType: string
  byteLength: number
  lastModified: number
  chunkSize: number
  chunkCount: number
}
~~~

Use discriminated receipt branches so text has no fileId and file requires fileId. Keep exact-key validation. Validate the aggregate with a single reduce and safe integers no larger than MAX_FILE_BATCH_BYTES. `sanitizeFileName` is pure and exported; PeerSession applies it to every remotely received descriptor before storing or emitting it, and local file selection applies it before descriptor creation. UI and download attributes never receive the raw remote name.

- [ ] **Step 5: Implement the binary codec**

~~~ts
export type FileChunkFrame = {
  streamId: number
  chunkIndex: number
  payload: Uint8Array
}

export const encodeFileChunkFrame = (
  frame: FileChunkFrame,
  maximumPayloadBytes: number,
): ArrayBuffer => {
  assertUint32(frame.streamId, { nonZero: true })
  assertUint32(frame.chunkIndex)
  assertPayload(frame.payload, maximumPayloadBytes)
  const bytes = new Uint8Array(FILE_CHUNK_HEADER_BYTES + frame.payload.byteLength)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x50325032)
  view.setUint8(4, 2)
  view.setUint8(5, 1)
  view.setUint16(6, FILE_CHUNK_HEADER_BYTES)
  view.setUint32(8, frame.streamId)
  view.setUint32(12, frame.chunkIndex)
  bytes.set(frame.payload, FILE_CHUNK_HEADER_BYTES)
  return bytes.buffer
}
~~~

The encoder throws `RangeError` unless streamId is a non-zero uint32, chunkIndex is a uint32, maximumPayloadBytes is a positive safe integer, and payload is a non-empty Uint8Array no larger than that negotiated maximum. `parseFileChunkFrame` accepts ArrayBuffer plus maximumPayloadBytes and returns a discriminated result without throwing on untrusted input under the same limits.

- [ ] **Step 6: Export and verify contracts**

Run:

~~~text
bun test packages/contracts/src/transfer.test.ts packages/contracts/src/file-chunk.test.ts
bun run --cwd packages/contracts typecheck
bun run --cwd packages/contracts lint
~~~

Expected: all new and existing contract checks PASS.

- [ ] **Step 7: Commit**

~~~bash
git add packages/contracts/src
git commit -m "feat: define file transfer protocol v2"
~~~

---

### Task 2: File Selection Rules

**Files:**
- Create: apps/web/src/features/transfer/file-selection.ts
- Create: apps/web/src/features/transfer/file-selection.test.ts

**Interfaces:**
- Consumes: MAX_FILE_COUNT and MAX_FILE_BATCH_BYTES from @p2p/contracts.
- Produces: FileSelection, addFileSelections, removeFileSelection, totalSelectionBytes.

- [ ] **Step 1: Write failing immutable selection tests**

~~~ts
const createFile = (name: string, size: number, lastModified = 1) =>
  ({ name, size, type: '', lastModified }) as File

expect(addFileSelections([], [createFile('a.bin', 1)], () => 'file_1')).toEqual({
  ok: true,
  selections: [{ fileId: 'file_1', file: expect.anything() }],
})
~~~

Cover append/remove, stable IDs, same-name different File objects, the same File object added twice, exactly 10 files, the 11th file, exactly 100 MiB, one byte over, zero-byte files, and failure preserving the old list.

- [ ] **Step 2: Run and confirm red**

Run: bun run --cwd apps/web test -- src/features/transfer/file-selection.test.ts

Expected: FAIL because file-selection.ts does not exist.

- [ ] **Step 3: Implement pure selection helpers**

~~~ts
export type FileSelection = {
  fileId: string
  file: File
}

export type FileSelectionResult =
  | { ok: true; selections: FileSelection[] }
  | {
      ok: false
      code: 'FILE_COUNT_LIMIT' | 'FILE_BATCH_SIZE_LIMIT' | 'DUPLICATE_FILE'
      message: string
    }
~~~

Duplicate means the same File object reference already selected; identical names alone are allowed. Generate IDs only after all incoming additions pass count/size/duplicate validation.

- [ ] **Step 4: Verify and commit**

Run:

~~~text
bun run --cwd apps/web test -- src/features/transfer/file-selection.test.ts
bun run --cwd apps/web typecheck
~~~

Expected: PASS.

~~~bash
git add apps/web/src/features/transfer/file-selection.ts apps/web/src/features/transfer/file-selection.test.ts
git commit -m "feat: validate file batch selections"
~~~

---

### Task 3: Binary File Transfer Engine

**Files:**
- Create: apps/web/src/features/transfer/file-transfer-engine.ts
- Create: apps/web/src/features/transfer/file-transfer-engine.test.ts

**Interfaces:**
- Consumes: encodeFileChunkFrame and FileDescriptor.
- Produces: resolveFileChunkSize, createFileTransferEngine, FileTransferEngine, createStreamTombstones.
- Does not know room state, React, dialogs, or signaling.

- [ ] **Step 1: Build failing fake channel/file fixtures**

The fake channel records strings/ArrayBuffers, increments bufferedAmount by frame size, and exposes drainTo:

~~~ts
type BinaryChannel = {
  readyState: RTCDataChannelState
  bufferedAmount: number
  bufferedAmountLowThreshold: number
  onbufferedamountlow: (() => void) | null
  send(data: string | ArrayBuffer): void
}
~~~

FakeFile records slice ranges and can defer or reject arrayBuffer reads. This proves no File.slice occurs before acceptance and no send occurs after abort.

- [ ] **Step 2: Write failing pump/backpressure tests**

Cover:

- resolveFileChunkSize(maxMessageSize) returns min(16 KiB, maxMessageSize - 16);
- undefined maxMessageSize uses a conservative 64 KiB transport maximum before subtracting the header and therefore resolves to the 16 KiB application cap;
- payload below 1 KiB returns FILE_TRANSFER_UNSUPPORTED;
- final short chunk and empty file;
- exact binary streamId/chunkIndex;
- stop before reading when next frame would exceed 1 MiB;
- resume only after crossing the 64 KiB low threshold;
- no timer polling and no concurrent pump re-entry;
- after a normal low-water wake at 64 KiB, zero-drain temporarily changes threshold to 0 and resolves only after a distinct drain-to-zero event, then restores 64 KiB;
- AbortSignal abort, send throw, and read rejection clean waiters; Task 5 separately proves PeerSession converts channel close/error into abort;
- progress is monotonic bytesQueued and never exceeds size.

- [ ] **Step 3: Run and confirm red**

Run: bun run --cwd apps/web test -- src/features/transfer/file-transfer-engine.test.ts

Expected: FAIL because the engine does not exist.

- [ ] **Step 4: Implement engine boundaries**

~~~ts
export type FileTransferEngine = {
  sendFile(options: {
    channel: BinaryChannel
    descriptor: FileDescriptor
    file: Blob
    signal: AbortSignal
    onProgress(bytesQueued: number): void
  }): Promise<void>
  waitForDrain(channel: BinaryChannel, signal: AbortSignal): Promise<void>
  close(): void
}

export function resolveFileChunkSize(maxMessageSize?: number):
  | { ok: true; chunkSize: number }
  | { ok: false; code: 'FILE_TRANSFER_UNSUPPORTED' }

export type StreamTombstones = {
  add(streamId: number): void
  has(streamId: number): boolean
  clear(): void
}

export function createStreamTombstones(options: {
  capacity?: number
  ttlMs?: number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}): StreamTombstones
~~~

Every await resumes through assertActive(channel, signal). Backpressure uses one promise per channel and restores onbufferedamountlow when settled. waitForDrain stores the previous threshold, sets it to 0, performs an immediate zero check, waits for a separate zero crossing when needed, and restores 64 KiB in finally. PeerSession owns channel onclose/onerror and must abort the peer transfer controller, which wakes the engine through the AbortSignal. Do not set intervals.

- [ ] **Step 5: Add bounded cancelled-stream tombstones**

Export a small pure registry from the engine module so each PeerSession peer entry can own/query it from the inbound binary path:

~~~ts
type StreamTombstones = {
  add(streamId: number): void
  has(streamId: number): boolean
  clear(): void
}
~~~

Keep 32 entries for 30 seconds using injected timers. Late chunks for tombstoned streams are ignored; unknown non-tombstoned streams remain protocol errors.

- [ ] **Step 6: Verify and commit**

Run:

~~~text
bun run --cwd apps/web test -- src/features/transfer/file-transfer-engine.test.ts
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
~~~

Expected: PASS with no unhandled promises.

~~~bash
git add apps/web/src/features/transfer/file-transfer-engine.ts apps/web/src/features/transfer/file-transfer-engine.test.ts
git commit -m "feat: add backpressured file transfer engine"
~~~

---

### Task 4: PeerSession v2 Text Delivery

**Files:**
- Modify: apps/web/src/features/transfer/peer-session.ts
- Modify: apps/web/src/features/transfer/peer-session.test.ts

**Interfaces:**
- Consumes: v2 control parser/encoder.
- Produces: direct text events plus acknowledgeText/discardText.
- Keeps existing peer negotiation and peerSessionId generation guards.

- [ ] **Step 1: Extend DataChannel test doubles**

Add binaryType, bufferedAmount, bufferedAmountLowThreshold, onbufferedamountlow, ArrayBuffer send recording, and optional sctp.maxMessageSize on PeerConnectionLike.

- [ ] **Step 2: Write failing direct-text tests**

Assert:

~~~ts
const offered = sender.offerText('secret body')
expect(parseControl(senderChannel.sent[0])).toEqual({
  v: 2,
  type: 'transfer:text',
  transferId: offered.transferId,
  text: 'secret body',
})
expect(senderChannel.sent.some(isDecisionFrame)).toBe(false)
~~~

Receiver emits transfer:text-received without receipt. acknowledgeText sends one receipt; discardText sends INVALID_STATE. Duplicate ACK/discard is false and sends nothing.

Cover multi-peer receipts, peer close, receipt timeout, and rejection of a second concurrent text offer. Text/file mutual exclusion is deferred to Task 5 where offerFiles exists.

- [ ] **Step 3: Run focused tests and confirm red**

Run: bun run --cwd apps/web test -- src/features/transfer/peer-session.test.ts

Expected: FAIL against current request/decision text behavior.

- [ ] **Step 4: Implement v2 channel identity and text state**

Set CHANNEL_PROTOCOL to p2p-transfer.v2. Replace IncomingTextRequest with:

~~~ts
type PendingIncomingText = {
  text: string
  state: 'awaiting-ui' | 'acknowledged' | 'discarded'
  timer?: ReturnType<typeof setTimeout>
}
~~~

Add methods:

~~~ts
acknowledgeText(peerId: string, transferId: string): boolean
discardText(peerId: string, transferId: string): boolean
~~~

The DataChannel handler only validates/stores/emits. App owns the capacity decision.

- [ ] **Step 5: Verify and commit**

Run:

~~~text
bun run --cwd apps/web test -- src/features/transfer/peer-session.test.ts
bun run --cwd apps/web typecheck
~~~

Expected: all peer negotiation regressions and new text tests PASS.

~~~bash
git add apps/web/src/features/transfer/peer-session.ts apps/web/src/features/transfer/peer-session.test.ts
git commit -m "feat: deliver text directly in protocol v2"
~~~

---

### Task 5: PeerSession File Batch State Machine

**Files:**
- Modify: apps/web/src/features/transfer/peer-session.ts
- Modify: apps/web/src/features/transfer/peer-session.test.ts
- Consume: apps/web/src/features/transfer/file-transfer-engine.ts

**Interfaces:**
- Produces: offerFiles, acceptFiles, rejectFiles, cancelTransfer.
- Produces: file request/progress/received/decision/receipt/terminal events.

- [ ] **Step 1: Write failing metadata/consent tests**

Assert request frames contain descriptors only and File.slice count is zero before accept. For two peers, resolve each descriptor chunkSize from that peer connection's sctp.maxMessageSize, accept one/reject one, and assert the rejecting channel records zero ArrayBuffer frames.

- [ ] **Step 2: Write failing receiver validation tests**

Cover file-start order, stream/index mismatch, wrong final-chunk size, overflow, duplicate start, mismatched end totals, per-file receipt, 10-file strict sequence, empty files, malicious remote names sanitized before event/Blob download metadata, exact reconstructed Blob bytes, and one final ordered `transfer:files-received` event containing every completed file.

- [ ] **Step 3: Write failing lifecycle tests**

Cover 30-second decision timeout, 60-second chunk inactivity, stalled drain, 30-second file receipt timeout, cancel, read failure, channel close/error aborting the engine waiter, peer replacement generation, tombstoned late chunks, text/file mutual exclusion, and close cleanup. Add two orchestration cases: (1) mixed supported/unsupported peers sends no request to the `<1 KiB` peer, records it terminal failed with `FILE_TRANSFER_UNSUPPORTED`, and lets supported peers proceed; (2) two peers accept, one pump remains stalled, and the other independently reaches receipt/completion without awaiting the stalled peer.

- [ ] **Step 4: Run and confirm red**

Run: bun run --cwd apps/web test -- src/features/transfer/peer-session.test.ts

Expected: FAIL because file methods/events do not exist.

- [ ] **Step 5: Implement per-peer batch records**

Use explicit records:

~~~ts
type OutgoingFilePeer = {
  state:
    | 'awaiting-decision'
    | 'sending'
    | 'draining'
    | 'awaiting-file-receipt'
    | 'received'
    | 'rejected'
    | 'cancelled'
    | 'failed'
  fileIndex: number
  abortController: AbortController
}

type IncomingFileBatch = {
  descriptors: FileDescriptor[]
  state: 'pending' | 'accepted' | 'receiving' | 'received'
  fileIndex: number
  nextChunkIndex: number
  parts: Uint8Array[]
  completedFiles: ReceivedFile[]
}

export type ReceivedFile = {
  fileId: string
  name: string
  mimeType: string
  byteLength: number
  lastModified: number
  blob: Blob
}
~~~

Each PeerEntry creates one StreamTombstones registry. Binary handler dispatches ArrayBuffer only, checks tombstones before active-stream validation, and clears the registry on peer close. String handler dispatches v2 control only. Never interleave files within a peer. An accepted decision starts that peer's pump with fire-and-track (`void pumpPeerBatch(...)` plus owned rejection handling); it never awaits another peer's pump.

- [ ] **Step 6: Implement typed public methods/events**

~~~ts
type TransferOfferResult = {
  transferId: string
  peerIds: string[]
  peerCount: number
  unsupportedPeerIds: string[]
}

offerFiles(files: readonly FileSelection[]): TransferOfferResult
acceptFiles(peerId: string, transferId: string): boolean
rejectFiles(peerId: string, transferId: string): boolean
cancelTransfer(transferId: string): boolean
~~~

`peerIds` contains every ready target, `peerCount` is the number actually offered, and `unsupportedPeerIds` is a subset seeded as terminal failed by App. If every peer is unsupported, no request is sent and the resulting activity enters the 400 ms error terminal hold before unlocking. Name sender progress bytesQueued and receiver progress bytesReceived. Terminal success requires receipts, not sender queue completion.

Every transfer:file-progress event includes fileId, fileBytes, fileTotalBytes, batchBytes, and batchTotalBytes so presentation can aggregate individual file rows without guessing.

Define and export the complete cross-task event contract rather than leaving UI consumers to infer it:

~~~ts
export type PeerSessionEvent =
  | { type: 'peer:state'; peerId: string; state: 'connecting' | 'ready' | 'closed' }
  | { type: 'transfer:text-received'; peerId: string; transferId: string; text: string }
  | { type: 'transfer:file-requested'; peerId: string; transferId: string; files: FileDescriptor[] }
  | { type: 'transfer:file-decision'; peerId: string; transferId: string; decision: 'accept' | 'reject' }
  | { type: 'transfer:file-progress'; peerId: string; transferId: string; fileId: string; direction: 'sending' | 'receiving'; fileBytes: number; fileTotalBytes: number; batchBytes: number; batchTotalBytes: number }
  | { type: 'transfer:file-receipt'; peerId: string; transferId: string; fileId: string }
  | { type: 'transfer:files-received'; peerId: string; transferId: string; files: ReceivedFile[] }
  | { type: 'transfer:terminal'; peerId: string; transferId: string; outcome: 'completed' | 'rejected' | 'cancelled' | 'failed' | 'timed-out'; code?: 'FILE_TRANSFER_UNSUPPORTED' | 'TRANSFER_ERROR' }
  | { type: 'error'; peerId?: string; transferId?: string; code: 'PEER_ERROR' | 'PROTOCOL_ERROR' | 'TRANSFER_ERROR'; message: string }
~~~

The final received event is emitted exactly once only after `completedFiles.length === descriptors.length`; cancellation/error clears parts and completed Blobs without exposing a partial final event.

- [ ] **Step 7: Verify and commit**

Run:

~~~text
bun run --cwd apps/web test -- src/features/transfer/peer-session.test.ts src/features/transfer/file-transfer-engine.test.ts
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
~~~

Expected: PASS.

~~~bash
git add apps/web/src/features/transfer
git commit -m "feat: transfer consented file batches"
~~~

---

### Task 6: Pure Transfer UI State

**Files:**
- Create: apps/web/src/features/transfer/ui-state.ts
- Create: apps/web/src/features/transfer/ui-state.test.ts
- Create: apps/web/src/features/transfer/progress-frame.ts
- Create: apps/web/src/features/transfer/progress-frame.test.ts

**Interfaces:**
- Consumes: PeerSessionEvent.
- Produces: TransferUiState, transferUiReducer, isTransferLocked, aggregateProgress, aggregateFileProgress, planIncomingText.
- Produces: createProgressFrameScheduler for one React-facing progress flush per animation frame.

- [ ] **Step 1: Write failing reducer tests**

Cover concrete peer state, new activity, file accept, progress, per-file and per-peer terminals, slowest accepted peer aggregation for the batch and each file, all-terminal complete/error, room reset, and disconnect.

Test `planIncomingText(queue, event, 5)` separately: queues the first five exact bodies with `disposition: 'acknowledge'`, leaves the queue unchanged for the sixth with `disposition: 'discard'`, and never calls PeerSession. App remains the only caller of acknowledgeText/discardText.

Generation-race test:

~~~ts
const old = createActivity({ generation: 1, transferId: 'old' })
const next = createActivity({ generation: 2, transferId: 'new' })
expect(clearTerminalHold(next, {
  generation: old.generation,
  transferId: old.transferId,
})).toBe(next)
~~~

- [ ] **Step 2: Run and confirm red**

Run: bun run --cwd apps/web test -- src/features/transfer/ui-state.test.ts

Expected: FAIL because ui-state.ts does not exist.

- [ ] **Step 3: Implement discriminated reducer state**

~~~ts
export type TransferPhase = 'idle' | 'requesting' | 'transferring' | 'complete' | 'error'

export type OutgoingActivity = {
  generation: number
  transferId: string
  kind: 'text' | 'file'
  phase: Exclude<TransferPhase, 'idle'>
  peerIds: string[]
  peers: Record<string, {
    accepted: boolean
    progress: number
    outcome?: TransferPeerOutcome
  }>
  files: Record<string, {
    state: 'queued' | 'transferring' | 'completed' | 'error'
    progress: number
    peers: Record<string, {
      progress: number
      outcome?: TransferPeerOutcome
    }>
  }>
}
~~~

The reducer and helpers are pure and produce no protocol effects. `planIncomingText` returns `{ queue, disposition: 'acknowledge' | 'discard' }`; App synchronously commits the returned queue/ref and then performs exactly one matching PeerSession call. `aggregateFileProgress(activity, fileId)` uses the slowest accepted non-terminal peer for that file; rejected peers are reported but do not hold progress below 100%.

- [ ] **Step 4: Write and implement animation-frame progress scheduling**

~~~ts
createProgressFrameScheduler({ requestFrame, cancelFrame, onFlush })
  => { push(event): void; clear(): void }
~~~

Coalesce the latest event per `peerId + fileId`, schedule at most one flush per animation frame, and flush a deterministic array. Tests cover many pushes in one frame, independent keys, latest-value wins, re-scheduling after flush, and `clear()` cancelling a pending frame and dropping buffered events.

- [ ] **Step 5: Verify and commit**

Run: bun run --cwd apps/web test -- src/features/transfer/ui-state.test.ts src/features/transfer/progress-frame.test.ts

Expected: PASS.

~~~bash
git add apps/web/src/features/transfer/ui-state.ts apps/web/src/features/transfer/ui-state.test.ts apps/web/src/features/transfer/progress-frame.ts apps/web/src/features/transfer/progress-frame.test.ts
git commit -m "feat: model transfer presentation state"
~~~

---

### Task 7: Receiver Dialogs, Avatar Flow, and Room Copy

**Files:**
- Modify: apps/web/package.json
- Modify: bun.lock
- Create: apps/web/src/test/dom.ts
- Create: apps/web/src/components/TransferPeerFlow.tsx
- Create: apps/web/src/components/TransferPeerFlow.test.tsx
- Create: apps/web/src/components/ReceivedTextDialog.tsx
- Create: apps/web/src/components/ReceivedTextDialog.test.tsx
- Create: apps/web/src/components/IncomingFileRequestDialog.tsx
- Create: apps/web/src/components/IncomingFileRequestDialog.test.tsx
- Create: apps/web/src/components/RoomCodeCopyButton.tsx
- Create: apps/web/src/components/RoomCodeCopyButton.test.tsx
- Create: apps/web/src/components/ReceiverPanel.tsx
- Modify: apps/web/src/index.css

**Interfaces:**
- UI components are controlled; App owns PeerSession calls and browser resource lifetime.
- No component imports PeerSession directly.

- [ ] **Step 1: Install the existing-runner DOM test dependencies**

Working directory: apps/web

Run: bun add -d @testing-library/react @testing-library/user-event jsdom

Expected: package.json and the root bun.lock update; no second lockfile appears.

- [ ] **Step 2: Create the jsdom helper**

Every component test starts with the Vitest environment pragma and imports this helper:

~~~ts
// @vitest-environment jsdom

import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(cleanup)

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
  configurable: true,
  value: vi.fn(function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }),
})
~~~

- [ ] **Step 3: Write and implement TransferPeerFlow**

Tests require real initials/colors through Avatar, four visible receivers plus +N, one accessible status, active class only in requesting/transferring, and no duplicate accessible avatar labels.

~~~ts
type TransferPeerFlowProps = {
  sender: PublicVisitor
  receivers: PublicVisitor[]
  phase: TransferPhase
  accessibleLabel: string
}
~~~

CSS applies dot-wave only under .transfer-peer-flow[data-active=true]. The reduced-motion media query forces animation: none and opacity: .6.

- [ ] **Step 4: Write and implement ReceivedTextDialog**

Tests assert exact newline/emoji text, no size, no 接收/拒绝, default Close focus, Copy success/failure without close, Escape closes, and backdrop does not.

~~~ts
type ReceivedTextDialogProps = {
  sender: PublicVisitor
  text: string
  copyStatus: 'idle' | 'copying' | 'copied' | 'error'
  onCopy(): void
  onClose(): void
}
~~~

- [ ] **Step 5: Write and implement IncomingFileRequestDialog**

Use states pending, receiving, received, error. Before accept, default focus Reject and Escape rejects once. During receive actions are disabled. Received renders explicit anchor downloads supplied by App and Close.

- [ ] **Step 6: Write and implement RoomCodeCopyButton**

~~~ts
type RoomCodeCopyButtonProps = {
  code: string
  onCopy(code: string): Promise<void>
}
~~~

Test exact code, success/failure callback state, aria-label 复制房间码, and a min-h/min-w 11 class.

- [ ] **Step 7: Implement ReceiverPanel waiting state**

ReceiverPanel shows sender identity and waiting/receiving connection state only. It never renders the received text body in the page behind the dialog.

- [ ] **Step 8: Run component tests and commit**

Run:

~~~text
bun run --cwd apps/web test -- src/components/TransferPeerFlow.test.tsx src/components/ReceivedTextDialog.test.tsx src/components/IncomingFileRequestDialog.test.tsx src/components/RoomCodeCopyButton.test.tsx
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
~~~

Expected: PASS.

~~~bash
git add apps/web/package.json bun.lock apps/web/src/test apps/web/src/components apps/web/src/index.css
git commit -m "feat: add transfer dialogs and avatar motion"
~~~

---

### Task 8: Functional Sender Panel

**Files:**
- Modify: apps/web/src/components/TransferPanel.tsx
- Create: apps/web/src/components/TransferPanel.test.tsx

**Interfaces:**
- Consumes selection and UI state; emits text/file/cancel intents.

- [ ] **Step 1: Write failing sender-panel tests**

Cover tab keyboard behavior, textarea exact value, absence of ring/shadow classes, border-accent focus class, click/file-input and drag/drop, append/remove, 10/100-MiB validation, actual progress rows, cancel, and locked state.

Assert source/runtime has no Math.random, setInterval, mockTransfer, or fake progress.

- [ ] **Step 2: Define controlled props**

~~~ts
type TransferPanelProps = {
  visitor: PublicVisitor
  room: PublicRoom
  receivers: PublicVisitor[]
  readyPeerCount: number
  activity?: OutgoingActivity
  files: FileSelection[]
  selectionError: string
  onFilesAdded(files: readonly File[]): void
  onFileRemoved(fileId: string): void
  onSendText(text: string): Promise<void>
  onSendFiles(): Promise<void>
  onCancel(): void
}
~~~

- [ ] **Step 3: Implement file drop/list/progress**

Keep the established dashed zone and 5% rows. Stop propagation on row actions. Show file size, status, and Signal Purple 15% progress fill. Each row reads `activity.files[selection.fileId]`; its percentage is the slowest accepted non-terminal peer for that file, while rejected/error peer outcomes remain visible without fabricating completion. The primary label is 发送 N 个文件; active state exposes 取消传输 as the only destructive action.

- [ ] **Step 4: Remove textarea focus shadow**

The textarea class keeps focus-visible:border-accent and removes every focus-visible:ring and ring-offset token. Do not replace it with box-shadow CSS.

- [ ] **Step 5: Verify and commit**

Run:

~~~text
bun run --cwd apps/web test -- src/components/TransferPanel.test.tsx
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
~~~

Expected: PASS.

~~~bash
git add apps/web/src/components/TransferPanel.tsx apps/web/src/components/TransferPanel.test.tsx
git commit -m "feat: enable sender file batches"
~~~

---

### Task 9: App Integration and Browser Resource Lifetime

**Files:**
- Modify: apps/web/src/App.tsx
- Create: apps/web/src/App.test.tsx
- Delete: apps/web/src/components/IncomingTextRequestDialog.tsx
- Delete: apps/web/src/components/ReceivedTextView.tsx
- Consume all previous components/domain modules.

**Interfaces:**
- App owns refs, operation generations, browser clipboard, object URLs, and 400 ms timer.
- PeerSession owns protocol, binary data, and transfer timers.

- [ ] **Step 1: Wire concrete peer identities and activity**

Build receiver visitors from current room participants and PeerSession peer IDs. offerText/offerFiles results create the pure OutgoingActivity with a new generation; `unsupportedPeerIds` are seeded as terminal failed before event subscription can race, while offered peers begin requesting.

- [ ] **Step 2: Wire text FIFO before ACK**

On `transfer:text-received`, call the pure helper and make App the sole effect owner:

~~~ts
const planned = planIncomingText(incomingTextsRef.current, event, 5)
incomingTextsRef.current = planned.queue
setIncomingTexts(planned.queue)

if (planned.disposition === 'acknowledge') {
  peerSession.acknowledgeText(event.peerId, event.transferId)
} else {
  peerSession.discardText(event.peerId, event.transferId)
}
~~~

ReceivedTextDialog Copy uses navigator.clipboard.writeText exact body. Failure sets error state/toast and never closes.

- [ ] **Step 3: Wire file consent, progress, and result URLs**

Accept/reject only file requests. Route raw progress into one `createProgressFrameScheduler`; its flush applies the latest event per peer/file to React state. Clear the scheduler on terminal transfer, room reset, disconnect, stale visitor refresh, and unmount. On complete create one URL per ReceivedFile:

~~~ts
const result = files.map(file => ({
  ...file,
  url: URL.createObjectURL(file.blob),
}))
~~~

Close, new room, disconnect, stale visitor refresh, and unmount revoke every URL exactly once.

- [ ] **Step 4: Wire generation-safe terminal hold**

Disable both send paths through the 400 ms terminal phase. Timer callback checks current transferId and generation before reset. Cleanup clears the timer.

- [ ] **Step 5: Wire Avatar flow and room copy**

Replace the sender-only Avatar header with TransferPeerFlow only while activity exists. Place RoomCodeCopyButton immediately beside the code. Success toast is 房间码已复制; failure is 无法复制房间码，请手动复制.

- [ ] **Step 6: Remove obsolete consent/result components**

Delete IncomingTextRequestDialog and ReceivedTextView imports/files. Confirm no text Accept/Reject strings remain.

- [ ] **Step 7: Add App integration/resource-lifetime tests**

Use jsdom/Testing Library, fake timers, a mocked API/realtime/PeerSession boundary, and stubs for `navigator.clipboard`, `URL.createObjectURL`, and `URL.revokeObjectURL`. Assert:

- FIFO admission commits before exactly one acknowledge; overflow performs exactly one discard;
- each received file URL is created once and revoked exactly once on dialog close and on every reset/unmount path;
- a stale 400 ms terminal callback cannot clear a newer transfer generation, while the matching callback unlocks send;
- progress bursts produce one React-facing flush per frame and pending frames are cancelled on cleanup;
- room-code copy, file Accept/Reject, and controlled sender-panel intents call the correct boundary methods.

- [ ] **Step 8: Run the complete Web suite**

Run:

~~~text
bun run --cwd apps/web test
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
bun run --cwd apps/web build
~~~

Expected: every command exits 0.

- [ ] **Step 9: Commit**

~~~bash
git add apps/web/src
git commit -m "feat: connect real file transfer experience"
~~~

---

### Task 10: Documentation and End-to-End Verification

**Files:**
- Modify: apps/web/README.md
- Modify: services/api/README.md only to state v2 payload boundaries; TURN details belong to the next plan.
- Modify: this plan checkboxes after completion.

- [ ] **Step 1: Document v2 text/file behavior**

Document text direct modal, file consent, 10/100-MiB limits, in-memory Blob fallback, no server payload, cancellation, and browser download behavior.

- [ ] **Step 2: Run repository verification**

Run: bun run verify

Expected: all Turbo tasks for @p2p/contracts, api, and web PASS.

- [ ] **Step 3: Browser-test two isolated sessions**

Verify:

- Chinese/newline/emoji text appears directly in dialog;
- Copy exact and Close; clipboard failure remains open;
- textarea focus has border only;
- room-code copy exact;
- Reject file batch sends zero binary frames;
- Accept two files, exact bytes/download names, real progress;
- one receiver accepts while another rejects;
- exact 10-file/100-MiB and both overflow cases;
- empty file, cancel, disconnect, and peer retry cleanup;
- Avatar uses real visitors and animates only during active transfer;
- 320 px, 360 px, desktop, and reduced-motion layouts.

- [ ] **Step 4: Check hygiene**

Run:

~~~text
git diff --check
git status --short
~~~

Expected: no dist, tsbuildinfo, Blob output, logs, or screenshots are staged.

- [ ] **Step 5: Mark plan complete and commit**

~~~bash
git add apps/web/README.md services/api/README.md docs/superpowers/plans/2026-07-11-transfer-experience-file-implementation.md
git commit -m "docs: complete file transfer milestone"
~~~
