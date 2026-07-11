# WebRTC Text Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a real sender-to-receiver WebRTC text transfer flow in which every receiver accepts or rejects an offer before the text body is sent.

**Architecture:** Keep Elysia as an authorized signaling-only service. Add platform-neutral wire contracts, a pure versioned DataChannel protocol parser, and a React-independent PeerSession that owns one RTCPeerConnection per receiver. React renders sender and receiver states, including a native confirmation dialog and a received-text view.

**Tech Stack:** Bun 1.3.14, Turborepo, TypeScript, Elysia, React 19, Vite 8, Tailwind CSS 4, Bun test, Vitest, browser WebRTC APIs.

## Global Constraints

- The server must never receive or relay transferred text.
- The text body must not be sent to a peer before that peer accepts.
- Only the room sender may initiate a text transfer.
- Text is limited to 500 JavaScript characters and its UTF-8 byte length must match protocol metadata.
- Every signaling frame carries a peerSessionId; every DataChannel frame carries v: 1.
- DataChannel label is p2p-transfer and protocol is p2p-transfer.v1.
- Transfer readiness is derived from RTCDataChannel.readyState === open, never room participant count.
- File transfer and TURN deployment are not part of this plan.
- The receive dialog uses the existing flat dark visual language and defaults focus to 拒绝.

---

### Task 1: Shared Platform-Neutral Contracts

**Files:**
- Create: packages/contracts/package.json
- Create: packages/contracts/tsconfig.json
- Create: packages/contracts/src/model.ts
- Create: packages/contracts/src/realtime.ts
- Create: packages/contracts/src/index.ts
- Modify: apps/web/package.json
- Modify: services/api/package.json
- Modify: apps/web/src/shared/contracts.ts
- Modify: services/api/src/modules/visitor/model.ts
- Modify: services/api/src/modules/room/model.ts
- Modify: services/api/src/modules/realtime/model.ts
- Modify: services/api/src/modules/realtime/routes.ts
- Modify: bun.lock

**Interfaces:**
- Produces: PublicVisitor, PublicRoom, ParticipantRole, ClientRealtimeMessage, ServerRealtimeMessage.
- Produces: SessionDescriptionDto, IceCandidateDto, SignalClientMessage, SignalServerMessage.
- Consumes: no DOM, React, Elysia, Bun, or storage APIs.

- [x] **Step 1: Create the contracts workspace**

~~~json
{
  "name": "@p2p/contracts",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "lint": "oxlint src"
  },
  "devDependencies": {
    "oxlint": "^1.71.0",
    "typescript": "~6.0.2"
  }
}
~~~

Use a strict ES2023/bundler tsconfig with no DOM library and include src.

- [x] **Step 2: Define public model DTOs**

Move the existing public visitor, participant, room, and API error shapes into packages/contracts/src/model.ts without changing their JSON field names.

- [x] **Step 3: Define explicit signaling DTOs**

~~~ts
export type SessionDescriptionDto =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }

export type IceCandidateDto = {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number | null
  usernameFragment: string | null
}

export type SignalClientMessage =
  | {
      type: 'signal:offer'
      roomCode: string
      to: string
      peerSessionId: string
      description: Extract<SessionDescriptionDto, { type: 'offer' }>
    }
  | {
      type: 'signal:answer'
      roomCode: string
      to: string
      peerSessionId: string
      description: Extract<SessionDescriptionDto, { type: 'answer' }>
    }
  | {
      type: 'signal:ice'
      roomCode: string
      to: string
      peerSessionId: string
      candidate: IceCandidateDto | null
    }
~~~

Keep room:join and room:leave. Remove transfer:prepare and transfer:state from WebSocket contracts because all transfer negotiation belongs to DataChannel.

- [x] **Step 4: Update Elysia runtime schemas**

Require peerSessionId on all signal messages, require description for offer/answer, allow candidate DTO or null for ICE, and remove WebSocket transfer schemas.

- [x] **Step 5: Re-export contracts in existing package boundaries**

apps/web/src/shared/contracts.ts becomes a compatibility re-export from @p2p/contracts. API model files retain internal Map/Set models but import or re-export their public DTO types from @p2p/contracts.

Add @p2p/contracts as a workspace dependency to Web and API. Add `lint: oxlint src` plus the existing Oxlint version to API so the root lint task finally covers backend source.

- [x] **Step 6: Install from the frozen workspace definition**

Run: bun install

Expected: one root bun.lock is updated only for the new workspace link and TypeScript workspace metadata; no npm lockfiles appear.

- [x] **Step 7: Run focused type checks**

Run: bun run --cwd packages/contracts typecheck

Expected: PASS with no DOM type dependency.

- [x] **Step 8: Commit**

~~~bash
git add packages/contracts apps/web/package.json apps/web/src/shared/contracts.ts services/api/package.json services/api/src/modules bun.lock
git commit -m "refactor: share realtime contracts"
~~~

---

### Task 2: Versioned DataChannel Transfer Protocol

**Files:**
- Create: packages/contracts/src/transfer.ts
- Create: packages/contracts/src/transfer.test.ts
- Modify: packages/contracts/src/index.ts

**Interfaces:**
- Produces: TransferProtocolMessage.
- Produces: parseTransferMessage(raw: string): TransferParseResult.
- Produces: encodeTransferMessage(message: TransferProtocolMessage): string.
- Produces: textByteLength(text: string): number.
- Limits: 500 characters, 4096 UTF-8 bytes per frame, 96 characters per transfer ID.

- [x] **Step 1: Write failing parser tests**

Cover request, decision, text, receipt, cancel, and error frames. Add failures for malformed JSON, unknown version/type, overlong ID, text over 500 characters, frame over 4096 bytes, and negative counts. The accepted-request byte-length match belongs to PeerSession tests because the parser does not own transfer state.

Use exact wire examples:

~~~ts
const request = {
  v: 1,
  type: 'transfer:request',
  transferId: 'tx_1',
  kind: 'text',
  characterCount: 4,
  byteLength: 6,
} as const
~~~

- [x] **Step 2: Run tests and confirm failure**

Run: bun test packages/contracts/src/transfer.test.ts

Expected: FAIL because transfer.ts does not exist.

- [x] **Step 3: Implement message types and strict guards**

~~~ts
export type TransferProtocolMessage =
  | {
      v: 1
      type: 'transfer:request'
      transferId: string
      kind: 'text'
      characterCount: number
      byteLength: number
    }
  | {
      v: 1
      type: 'transfer:decision'
      transferId: string
      decision: 'accept' | 'reject'
    }
  | { v: 1; type: 'transfer:text'; transferId: string; text: string }
  | { v: 1; type: 'transfer:receipt'; transferId: string; status: 'received' }
  | { v: 1; type: 'transfer:cancel'; transferId: string }
  | {
      v: 1
      type: 'transfer:error'
      transferId: string
      code: 'INVALID_STATE' | 'CONTENT_MISMATCH' | 'CONTENT_TOO_LARGE'
    }

export type TransferParseResult =
  | { ok: true; message: TransferProtocolMessage }
  | { ok: false; error: { code: 'PROTOCOL_ERROR'; message: string } }
~~~

Use unknown plus narrowing. Reject extra semantic inconsistencies in PeerSession where request state is available.

- [x] **Step 4: Run parser tests**

Run: bun test packages/contracts/src/transfer.test.ts

Expected: all protocol tests PASS.

- [x] **Step 5: Commit**

~~~bash
git add packages/contracts/src
git commit -m "feat: add text transfer protocol"
~~~

---

### Task 3: Authorize Signaling And Fix Socket Replacement

**Files:**
- Modify: services/api/src/modules/realtime/hub.ts
- Modify: services/api/src/modules/realtime/hub.test.ts
- Modify: services/api/README.md

**Interfaces:**
- Consumes: role-aware SignalClientMessage from @p2p/contracts.
- Produces realtime errors SIGNAL_NOT_ALLOWED and SIGNAL_TARGET_NOT_IN_ROOM.
- Preserves peerSessionId, description, and candidate exactly when forwarding.

- [x] **Step 1: Add failing authorization tests**

Add tests for:

- a sender offering to a receiver in the same room succeeds;
- a visitor that did not WebSocket-join the room cannot signal;
- a room member cannot target a visitor outside the room;
- a visitor cannot target itself;
- a receiver cannot send an offer;
- a sender cannot send an answer;
- ICE is allowed only between the sender and receiver in the same room;
- disconnecting an old replaced socket does not remove the new socket mapping.

Every rejection test must assert that the target socket received zero signal messages.

- [x] **Step 2: Run hub tests and confirm failure**

Run: bun test services/api/src/modules/realtime/hub.test.ts

Expected: new authorization tests FAIL because the current hub forwards directly.

- [x] **Step 3: Implement one room authorization gate**

Resolve the current room, assert connection.rooms contains the room code, assert the sending visitor remains a participant, and find the target participant. Apply role rules before sendToVisitor.

~~~ts
const authorizeSignal = (
  connection: Connection,
  message: SignalClientMessage,
): { ok: true } | { ok: false; error: RealtimeError } => {
  // Return stable errors for membership, target, self, and role failures.
}
~~~

Do not keep an alternate unguarded signal path.

- [x] **Step 4: Make socket replacement generation-safe**

When connecting a second socket for the same visitor, close or supersede the old connection. During disconnect, delete socketIdsByVisitor only when its current value equals the disconnecting socket ID.

- [x] **Step 5: Run API tests**

Run: bun test services/api/src/modules/realtime/hub.test.ts services/api/src/app.test.ts

Expected: all existing and new tests PASS.

- [x] **Step 6: Update API documentation**

Document peerSessionId, description/candidate DTOs, room/role authorization, and the removal of WebSocket transfer messages.

- [x] **Step 7: Commit**

~~~bash
git add services/api/src/modules/realtime services/api/README.md
git commit -m "fix: authorize realtime signaling"
~~~

---

### Task 4: React-Independent PeerSession

**Files:**
- Create: apps/web/src/features/transfer/peer-session.ts
- Create: apps/web/src/features/transfer/peer-session.test.ts
- Modify: apps/web/src/lib/config.ts

**Interfaces:**
- Consumes: selfId, roomCode, role, RTCConfiguration, sendSignal(message), createPeerConnection, createId, timers.
- Produces: syncRoom(room), handleSignal(message), offerText(text), acceptText(peerId, transferId), rejectText(peerId, transferId), readyPeerCount(), subscribe(listener), close().
- Produces events peer:state, transfer:request, transfer:decision, transfer:received, transfer:receipt, transfer:cancelled, and error.

- [x] **Step 1: Build fake WebRTC test doubles**

The fake peer connection records createOffer, createAnswer, setLocalDescription, setRemoteDescription, addIceCandidate, createDataChannel, and close calls. The fake channel records label, protocol, readyState, sent strings, and exposes open/message/close helpers.

- [x] **Step 2: Write failing peer lifecycle tests**

Cover:

- sender creates exactly one peer and one p2p-transfer.v1 channel per receiver;
- duplicate participant snapshots do not create another offer;
- receiver creates no channel and answers an offer;
- ICE before remote description queues, then flushes;
- old peerSessionId answer and ICE are ignored;
- channel open/close updates readyPeerCount;
- removed participants close peer and channel;
- close removes timers and all resources.

- [x] **Step 3: Write failing transfer state tests**

Cover:

- offerText snapshots the current text and sends only a request;
- request frame contains no text field and no original text substring;
- one of two receivers accepting sends payload only to that peer;
- a rejecting peer never receives payload;
- matching payload is accepted only after local acceptance;
- receipt, cancellation, 30-second decision timeout, 15-second payload timeout, duplicate decisions, and peer close are idempotent;
- malformed frames emit PROTOCOL_ERROR without a React event.

- [x] **Step 4: Run tests and confirm failure**

Run: bun run --cwd apps/web test -- src/features/transfer/peer-session.test.ts

Expected: FAIL because PeerSession does not exist.

- [x] **Step 5: Implement peer reconciliation and signaling**

Use a Map keyed by remote visitor ID. Store peerSessionId, RTCPeerConnection, channel, queued ICE, and transfer state together so old callbacks can compare their generation before emitting.

The sender creates the channel before createOffer. The receiver validates channel label/protocol in ondatachannel and closes unknown channels.

- [x] **Step 6: Implement transfer state machines**

Store sender state by transferId then peerId. Store receiver pending requests by transferId and peerId. Set the terminal state before sending terminal protocol frames so double-clicks and timeout races are harmless.

- [x] **Step 7: Add configurable ICE servers**

getRtcConfiguration reads comma-separated VITE_STUN_URLS and defaults to stun:stun.l.google.com:19302. No TURN username or credential is added.

- [x] **Step 8: Run focused tests**

Run: bun run --cwd apps/web test -- src/features/transfer/peer-session.test.ts

Expected: all PeerSession tests PASS.

- [x] **Step 9: Commit**

~~~bash
git add apps/web/src/features/transfer apps/web/src/lib/config.ts
git commit -m "feat: add WebRTC peer session"
~~~

---

### Task 5: Realtime Lifecycle And Stale Session Recovery

**Files:**
- Modify: apps/web/src/lib/realtime-client.ts
- Modify: apps/web/src/lib/realtime-client.test.ts
- Modify: apps/web/src/lib/api-client.ts
- Modify: apps/web/src/lib/api-client.test.ts
- Modify: apps/web/src/lib/visitor-session.ts

**Interfaces:**
- Produces: ApiClientError with code and status.
- Produces: RealtimeStatus = idle | connecting | open | reconnecting | closed.
- RealtimeClient adds subscribeStatus(listener) and bounded reconnect of at most three attempts.

- [x] **Step 1: Write failing API error tests**

Assert a non-2xx response throws ApiClientError whose code and status preserve the API response. Keep the existing human-readable message.

- [x] **Step 2: Implement ApiClientError**

~~~ts
export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
}
~~~

- [x] **Step 3: Write failing realtime status/reconnect tests**

Cover open status, unexpected close, reconnect delays, maximum three attempts, explicit close without reconnect, and room-join-before-queued-signal ordering after reconnect.

- [x] **Step 4: Implement status and bounded reconnect**

Emit open synchronously before flushing queued messages so App can re-send room:join first. Explicit close clears timers, pending signals, handlers, and reconnect state.

- [x] **Step 5: Run client tests**

Run: bun run --cwd apps/web test -- src/lib/api-client.test.ts src/lib/realtime-client.test.ts src/lib/visitor-session.test.ts

Expected: all client/session tests PASS.

- [x] **Step 6: Commit**

~~~bash
git add apps/web/src/lib
git commit -m "feat: recover signaling sessions"
~~~

---

### Task 6: Room State Uses DataChannel Readiness

**Files:**
- Modify: apps/web/src/features/room/state.ts
- Modify: apps/web/src/features/room/state.test.ts

**Interfaces:**
- RoomFlowState adds readyPeerCount: number.
- RoomFlowAction adds peer:ready-count and realtime:disconnected.
- room:participants updates membership only; it cannot mark the room ready.

- [x] **Step 1: Update reducer tests first**

Replace the test that two participants imply ready. Assert two participants remain connecting until peer:ready-count with count 1. Assert count 0 and realtime disconnect return to connecting.

- [x] **Step 2: Run reducer test and confirm failure**

Run: bun run --cwd apps/web test -- src/features/room/state.test.ts

Expected: FAIL because the new actions and state do not exist.

- [x] **Step 3: Implement minimal reducer changes**

Initialize readyPeerCount to 0. Preserve membership updates independently. peer:ready-count sets phase to ready only when count is greater than zero.

- [x] **Step 4: Run reducer tests**

Run: bun run --cwd apps/web test -- src/features/room/state.test.ts

Expected: PASS.

- [x] **Step 5: Commit**

~~~bash
git add apps/web/src/features/room
git commit -m "refactor: derive readiness from peers"
~~~

---

### Task 7: Receive Dialog And Receiver Result UI

**Files:**
- Create: apps/web/src/components/IncomingTextRequestDialog.tsx
- Create: apps/web/src/components/ReceivedTextView.tsx
- Modify: apps/web/src/components/TransferPanel.tsx
- Modify: apps/web/src/components/ui/useToast.ts
- Modify: apps/web/src/components/ui/Toast.tsx
- Modify: apps/web/src/index.css

**Interfaces:**
- IncomingTextRequestDialog consumes request, status, onAccept, and onReject.
- ReceivedTextView consumes waiting/receiving/received/error state and onCopy.
- TransferPanel becomes sender-only and consumes readyPeerCount plus onSendText.
- Toast adds tone error | success | info.

- [x] **Step 1: Implement the native receive dialog**

Use dialog.showModal(), cancel event handling, and a ref that focuses 拒绝. Clicking the backdrop does nothing. Escape calls onReject exactly once. Disable both actions after a decision.

Use:

~~~txt
m-auto w-[calc(100%-2rem)] max-w-md max-h-[calc(100svh-2rem)]
overflow-y-auto rounded-xl border border-amber-50/15 bg-[#373737]
p-0 text-amber-50/80 backdrop:bg-black/50
~~~

Do not show text preview. Show sender avatar, display name, character count, and byte count.

- [x] **Step 2: Implement receiver waiting/receiving/result states**

Received text uses whitespace-pre-wrap, overflow-wrap:anywhere, text-sm, leading-6, and a read-only bordered surface. Copy exact text through navigator.clipboard.writeText and announce only the copy status.

- [x] **Step 3: Remove mock transfer behavior**

TransferPanel on text submit calls onSendText(text). Remove random timers, random failures, and fake progress. Replace the file area with an explicit 下一阶段开放 state and a disabled action.

- [x] **Step 4: Make the layout responsive**

Replace fixed w-xl with w-[calc(100vw-2rem)] max-w-xl. Ensure buttons are at least 44px high and focus-visible rings are visible.

- [x] **Step 5: Add toast tones**

Errors remain muted red; success uses restrained green; info uses the existing warm-white border. Preserve flat surfaces and no shadow.

- [x] **Step 6: Run frontend lint and typecheck**

Run: bun run --cwd apps/web typecheck

Run: bun run --cwd apps/web lint

Expected: both PASS.

- [x] **Step 7: Commit**

~~~bash
git add apps/web/src/components apps/web/src/index.css
git commit -m "feat: add text receive experience"
~~~

---

### Task 8: Wire App To Realtime And PeerSession

**Files:**
- Modify: apps/web/src/App.tsx
- Modify: apps/web/index.html
- Modify: apps/web/README.md

**Interfaces:**
- App creates and disposes one PeerSession per active room.
- App forwards room snapshots and signal messages to PeerSession.
- App maintains a FIFO incoming request queue and one received text result.
- Room operations retry exactly once after VISITOR_NOT_FOUND with a fresh visitor.

- [x] **Step 1: Add room/session lifecycle helpers**

Keep refs for the active realtime client, PeerSession, current room, and cleanup subscriptions. A single closeRoomResources function closes all resources on unmount or terminal room error.

- [x] **Step 2: Wire realtime status**

On every open, send room:join before queued signal frames. On reconnecting/disconnected, dispatch realtime:disconnected, close PeerSession, clear pending consent, and disable transfer.

- [x] **Step 3: Wire room and signal messages**

room:participants updates reducer and calls syncRoom. signal:offer/answer/ice awaits handleSignal. Stable server errors use error toasts and terminal visitor/room errors return to recoverable UI.

- [x] **Step 4: Wire PeerSession events**

Peer open/close updates readyPeerCount. Incoming request events append to a queue capped at five; requests beyond the cap are rejected. Decision, receipt, cancel, and error events show accurate sender feedback.

- [x] **Step 5: Wire accept/reject/result**

Accept changes receiver view to receiving and calls acceptText. Reject calls rejectText and advances the queue. transfer:received stores exact text, closes the dialog, renders ReceivedTextView, and sends receipt through PeerSession.

- [x] **Step 6: Add one-time stale session recovery**

When create/join throws ApiClientError with VISITOR_NOT_FOUND, clear local storage, create/save a new visitor, dispatch visitor:ready, and retry only the original operation once.

- [x] **Step 7: Correct document metadata**

Set html lang to zh-CN and title to P2P Transmission.

- [x] **Step 8: Document local two-browser flow**

Replace the Vite template README with Bun commands, API URL configuration, STUN configuration, and the exact reject/accept verification flow.

- [x] **Step 9: Run all web tests**

Run: bun run --cwd apps/web test

Expected: all existing and new Web tests PASS.

- [x] **Step 10: Commit**

~~~bash
git add apps/web/src/App.tsx apps/web/index.html apps/web/README.md
git commit -m "feat: connect real text transfer flow"
~~~

---

### Task 9: Full Verification And Browser Acceptance

**Files:**
- Modify: docs/superpowers/plans/2026-07-11-webrtc-text-transfer.md
- Modify only if verification exposes a defect: files owned by Tasks 1-8.

**Interfaces:**
- Consumes all milestone behavior.
- Produces a verified two-browser text transfer and completed checklist.

- [x] **Step 1: Run complete repository verification**

Run: bun run test

Run: bun run typecheck

Run: bun run lint

Run: bun run build

Expected: every command exits 0. Confirm API is included in tests/typecheck and Web is included in lint/build.

- [x] **Step 2: Start API and Web**

Run API on localhost:3000 and Web on localhost:5713 using the root dev script or the two package dev scripts. Keep both processes hidden and capture logs.

- [x] **Step 3: Verify rejection with isolated sessions**

Open two isolated browser sessions. Create/join the same room and wait for DataChannel open. Send Chinese text containing a newline and emoji. Confirm the receiver dialog contains metadata but not text. Reject and confirm the receiver never sees the text and sender receives rejection feedback.

- [x] **Step 4: Verify acceptance**

Send a second exact text. Accept it. Confirm the receiver main panel displays byte-for-byte equivalent text, copy returns the exact text, and sender receives a receipt.

- [x] **Step 5: Verify disconnect**

Close the receiver. Confirm sender ready count returns to zero and transfer becomes disabled without a stale dialog or unhandled error.

- [x] **Step 6: Verify compact layout**

Repeat dialog and received-text checks at 360x800 and desktop width. Confirm no horizontal overflow, clipped actions, or inaccessible focus.

- [x] **Step 7: Check repository hygiene**

Run: git diff --check

Run: git status --short

Expected: only intentional source/docs changes; no dist, tsbuildinfo, logs, or screenshots are staged.

- [x] **Step 8: Mark this plan complete and commit**

~~~bash
git add docs/superpowers/plans/2026-07-11-webrtc-text-transfer.md
git commit -m "docs: complete WebRTC text transfer plan"
~~~
