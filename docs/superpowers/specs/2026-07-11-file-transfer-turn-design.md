# File Transfer, Transfer Motion, and TURN Design

**Date:** 2026-07-11  
**Status:** Approved design, pending implementation plan  
**Branch:** `codex/file-transfer-turn`

## 1. Goal

Extend the existing room-based WebRTC text milestone into a complete browser-to-browser transfer experience:

- restore the historical sender-avatar → animated dots → receiver-avatars visual, but bind it to real transfer state and real visitors;
- change text reception so the body appears immediately in a receiver dialog with Copy and Close actions;
- add consent-gated, chunked file transfer for batches of at most 10 files and 100 MiB total;
- add secure TURN relay configuration with short-lived coturn credentials;
- add a room-code copy action and remove the textarea focus ring while retaining a visible border focus state.

The API remains signaling/configuration only. Text and file bodies must never pass through or be stored by the API or room bootstrap response.

## 2. Product and Visual Constraints

The implementation must preserve the existing “Dark Workshop” design language from `DESIGN.md`:

- `#2d2d2d` page background and Signal Purple `#5e11d1` as the only interactive color;
- flat surfaces, no shadows, no gradients, no glass effects;
- 8 px and 12 px radii only;
- visible normal text must meet WCAG AA contrast;
- one primary action per state;
- motion uses only transform and opacity and stops under `prefers-reduced-motion: reduce`.

No new animation library is needed. CSS keyframes and React state are sufficient.

## 3. Confirmed User Requirements

1. The text textarea keeps its purple border focus feedback but removes `focus-visible:ring-*` and ring-offset classes. No focus shadow is rendered.
2. A received text is shown directly inside a modal dialog. The dialog shows the text body, not file metadata or byte size.
3. A text dialog has exactly two actions: Copy and Close. Copy does not close the dialog.
4. Only file requests have Accept and Reject actions. File bytes are not sent before acceptance.
5. The sender header shows the historical avatar-transfer motif while a real transfer is active.
6. The room code has a compact copy button immediately to its right.
7. A file batch contains at most 10 files and at most 100 MiB in total.
8. After this UI work, the milestone includes real file transfer and TURN relay support.

## 4. Chosen Architecture

Use one ordered, reliable RTCDataChannel per sender/receiver pair for both JSON control frames and binary file chunks. This extends the current PeerSession boundary instead of opening a new channel for every file.

Why this approach:

- existing peer lifecycle, authorization, stale-session guards, receipts, and timeouts remain reusable;
- ordered delivery lets a `file:start` control frame, its binary chunks, and `file:end` be interpreted without a binary header on every chunk;
- one channel per peer avoids channel churn for a 10-file batch;
- DataChannel `bufferedAmount` and `bufferedamountlow` provide explicit backpressure.

Rejected alternatives:

- **One DataChannel per file:** simpler per-file routing, but creates unnecessary channel negotiation/lifecycle overhead and complicates multi-receiver aggregation.
- **API file relay/storage:** easier delivery reporting, but violates the product promise that content does not pass through or remain on a server.

## 5. Transfer Protocol v2

The channel subprotocol becomes `p2p-transfer.v2`, and JSON control frames use `v: 2`. Both peers in a room run the same deployed client, so no v1/v2 mixed-session compatibility layer is required. Existing v1 tests remain as historical coverage only if the v1 parser is retained; PeerSession uses v2 exclusively.

### 5.1 Limits

```ts
MAX_TEXT_CHARACTERS = 500
MAX_CONTROL_FRAME_BYTES = 16 * 1024
MAX_FILE_COUNT = 10
MAX_FILE_BATCH_BYTES = 100 * 1024 * 1024
MAX_FILE_NAME_CHARACTERS = 255
MAX_FILE_NAME_BYTES = 255
MAX_MIME_TYPE_CHARACTERS = 128
MAX_MIME_TYPE_BYTES = 128
FILE_CHUNK_BYTES = 16 * 1024
DATA_CHANNEL_HIGH_WATER_BYTES = 1024 * 1024
DATA_CHANNEL_LOW_WATER_BYTES = 256 * 1024
DECISION_TIMEOUT_MS = 30_000
TRANSFER_IDLE_TIMEOUT_MS = 30_000
RECEIPT_TIMEOUT_MS = 15_000
```

The file batch limit is evaluated before any request is sent and again at the receiver protocol boundary. Empty files are allowed and count toward the 10-file limit. Control frames are capped at 16 KiB of UTF-8 data; file names and MIME types must satisfy both their character and UTF-8 byte limits so a valid 10-file request always fits that frame budget.

### 5.2 Control Frames

```ts
type TransferProtocolMessage =
  | {
      v: 2
      type: 'transfer:text'
      transferId: string
      text: string
    }
  | {
      v: 2
      type: 'transfer:file-request'
      transferId: string
      files: Array<{
        fileId: string
        name: string
        mimeType: string
        byteLength: number
      }>
    }
  | {
      v: 2
      type: 'transfer:decision'
      transferId: string
      decision: 'accept' | 'reject'
    }
  | {
      v: 2
      type: 'transfer:file-start'
      transferId: string
      fileId: string
    }
  | {
      v: 2
      type: 'transfer:file-end'
      transferId: string
      fileId: string
      byteLength: number
    }
  | {
      v: 2
      type: 'transfer:receipt'
      transferId: string
      kind: 'text' | 'file'
      status: 'received'
    }
  | {
      v: 2
      type: 'transfer:cancel'
      transferId: string
    }
  | {
      v: 2
      type: 'transfer:error'
      transferId: string
      code:
        | 'INVALID_STATE'
        | 'CONTENT_MISMATCH'
        | 'CONTENT_TOO_LARGE'
        | 'BUFFER_ERROR'
    }
```

Control-frame parsing uses exact keys, finite bounded integers, capped strings, and aggregate batch validation. File names have control characters and path separators removed before display/download and are never used as filesystem paths by the application.

### 5.3 Text Flow

```text
sender clicks Send
→ sender sends transfer:text immediately to every ready peer
→ receiver validates, retains a pending incoming record, and emits transfer:text-received
→ App either queues the dialog then calls acknowledgeText, or reports queue overflow with discardText
→ acknowledgeText sends transfer:receipt only after the exact body is committed to the UI FIFO
→ receiver opens a text dialog containing the exact body
→ sender marks that peer complete
```

There is no request or decision frame for text. Closing the dialog only dismisses local UI; it does not retroactively reject the text. Multiple received texts use a FIFO queue capped at five dialogs. Overflow calls `discardText`, which sends `transfer:error` with `INVALID_STATE`, clears the pending incoming record, and does not overwrite the visible message. Receipt emission is therefore owned by an explicit App-to-PeerSession acknowledgement rather than happening automatically inside the DataChannel message handler.

### 5.4 File Flow

```text
sender selects 1–10 files
→ local limits pass
→ sender sends one transfer:file-request batch to every ready peer
→ receiver dialog displays sender plus file names and sizes
→ Reject: transfer:decision(reject), no binary data is sent
→ Accept: transfer:decision(accept)
→ sender sends each file sequentially on that peer channel:
   transfer:file-start → ordered ArrayBuffer chunks → transfer:file-end
→ receiver verifies active transfer, file order, and exact byte count
→ after every file is complete, receiver creates downloadable Blob URLs
→ receiver sends transfer:receipt(kind=file)
→ dialog shows completed files with Save actions and Close
```

Only one outgoing transfer—either one text message or one file batch—is active at a time. The send controls remain disabled until every targeted peer is terminal—received, rejected, cancelled, timed out, or disconnected—and the 400 ms terminal feedback hold has ended. Different peers may accept independently; accepted peers transfer concurrently on their own channels.

The receiver keeps at most one accepted file batch active per peer. Because the total batch is capped at 100 MiB, the compatible fallback may buffer chunks in memory and construct Blobs. Object URLs are revoked when the result is cleared or the component unmounts. Automatic downloads are not forced because browsers may block asynchronous multi-file downloads; the completed dialog provides explicit Save links.

### 5.5 Backpressure and Integrity

Each channel is ordered and reliable. Before binary transfer it uses `binaryType = 'arraybuffer'` and `bufferedAmountLowThreshold = 256 KiB`.

The sender reads each File in 16 KiB slices. It stops enqueueing while `bufferedAmount` exceeds 1 MiB and resumes only after `bufferedamountlow` or channel close/error. This uses the browser’s defined queue counters rather than timer polling.

The receiver resets a 30-second inactivity watchdog for every valid chunk. It rejects chunks without an accepted active file, bytes beyond the declared length, a mismatched `file:end`, duplicate file starts, or files arriving out of batch order. Ordered reliable SCTP/DTLS handles transport ordering and integrity; the application additionally verifies declared byte counts.

Cancellation closes local readers/writers, clears waiters and timers, discards partial chunks, revokes object URLs, sends a terminal frame when possible, and emits one idempotent terminal event.

## 6. PeerSession and UI State

PeerSession gains explicit methods and events rather than exposing RTCDataChannel details to React.

```ts
type FileSelection = {
  fileId: string
  file: File
}

type PeerSession = {
  offerText(text: string): TransferOfferResult
  offerFiles(files: readonly FileSelection[]): TransferOfferResult
  acknowledgeText(peerId: string, transferId: string): boolean
  discardText(peerId: string, transferId: string): boolean
  acceptFiles(peerId: string, transferId: string): boolean
  rejectFiles(peerId: string, transferId: string): boolean
  cancelTransfer(transferId: string): boolean
}
```

New events include file request, file progress, file received, text received, per-peer decision/receipt, and transfer terminal state. Progress events are throttled to at most once per animation frame in React-facing state.

App stores one outgoing activity keyed by `transferId` and per-peer terminal/progress state. The aggregate file percentage is the slowest percentage among accepted non-terminal peers, so 100% always means every accepting peer finished. Rejected peers are reported separately and do not hold progress below 100%.

## 7. Avatar Transfer Motion

Do not replace the current deterministic `Avatar` component. Add a composition component, `TransferPeerFlow`, that reuses it.

```ts
type TransferPeerFlowProps = {
  sender: PublicVisitor
  receivers: PublicVisitor[]
  phase: 'idle' | 'requesting' | 'transferring' | 'complete' | 'error'
  accessibleLabel: string
}
```

Visual structure:

```text
real sender avatar → three 4px wave dots → overlapping real receiver avatars
```

- Show at most four receiver avatars and a `+N` overflow badge.
- Text transfer enters `transferring` when `transfer:text` is sent and stops after all peer receipts/terminal outcomes.
- File transfer enters `requesting` after `file-request`, remains animated through accepted binary transfer, and stops after all peers are terminal.
- Idle uses the existing compact identity/status header; it does not run an infinite decorative animation.
- Dots animate with the existing restrained `dot-wave` rhythm using transform/opacity only.
- `prefers-reduced-motion: reduce` renders three static dots at 60% opacity and removes all looping animation.
- The visual group has one accessible status label; decorative avatars/dots inside it are hidden from assistive technology to avoid repetition.
- Entering `complete` or `error` stops looping motion immediately, keeps the static terminal state visible for 400 ms, then clears the outgoing activity and returns to `idle`. Send remains disabled during that hold. The timer captures `transferId` plus an activity generation and clears state only when both still match; it is cancelled on a new room, disconnect, or unmount.

## 8. Receiver Dialogs

Use two focused components rather than overloading the old text-consent dialog.

### 8.1 ReceivedTextDialog

- title: `收到文本`;
- opens after the exact text body arrives;
- shows sender identity and a scrollable `whitespace-pre-wrap` body;
- does not show byte length, file size, Accept, or Reject;
- `复制` writes the exact body and changes its own label to `已复制` without closing;
- clipboard absence or permission rejection changes the button label to `复制失败`, shows an error toast, preserves the body, and never closes the dialog;
- `关闭` dismisses and advances the FIFO queue;
- Escape behaves like Close; backdrop clicks do not dismiss;
- default focus is Close so opening a message never triggers clipboard access.

### 8.2 IncomingFileRequestDialog

- title: `收到文件`;
- before acceptance, shows sender, 1–10 file names, individual sizes, and total size;
- default focus is Reject;
- Escape rejects exactly once; backdrop clicks do not dismiss;
- after Accept, actions are disabled and the same dialog shows real progress;
- after completion, it shows a `保存` action per file plus `关闭`;
- Reject guarantees that no binary file chunks are sent to that receiver.

## 9. Sender File Panel

The existing File tab becomes functional:

- hidden multiple file input plus click and drag/drop selection;
- reject duplicates by stable local ID, not by filename alone;
- enforce 10-file and 100-MiB limits before adding/sending;
- list file name, size, queued/transferring/completed/error state, and real progress;
- allow removing files before send and cancelling the active batch;
- use the same flat 5% file-row surface and Signal Purple 15% progress fill described by `DESIGN.md`;
- never use mock timers, random progress, or random failure.

The textarea removes focus ring classes and retains only the purple border transition. File drop focus uses the same border-only treatment.

## 10. Room Code Copy

Place an icon-only copy button immediately to the right of the six-digit room code.

- Copy the exact code through `navigator.clipboard.writeText`.
- Use a 44 × 44 px hit target without visually enlarging the icon.
- Accessible name: `复制房间码`.
- Success toast: `房间码已复制`.
- Failure toast: `无法复制房间码，请手动复制`.
- Use border/color focus feedback only; no shadow.

## 11. TURN Relay Design

### 11.1 Modes

```ts
type TurnMode = 'off' | 'static' | 'api'
```

- `off`: current STUN-only development default.
- `static`: TURN URLs, username, and credential come from `VITE_*`; allowed only for local/private testing because build-time values are public.
- `api`: production-recommended mode; the API signs short-lived coturn REST credentials for an authenticated room member.

`iceTransportPolicy` defaults to `all`, which allows direct candidates first and relay candidates when needed. `relay` is supported only for explicit relay verification.

### 11.2 Atomic Room Bootstrap and Credentials

Room creation/joining and API-mode credential issuance use one atomic bootstrap response instead of joining first and fetching credentials in a second request:

```ts
type RoomBootstrapRequest = {
  iceMode: 'off' | 'api'
}

type RoomSessionBootstrap = {
  room: PublicRoom
  rtcConfiguration?: RTCConfigurationDto
  credentialExpiresAt?: number
}
```

`POST /v1/rooms` and `POST /v1/rooms/:code/join` accept `iceMode`. Static browser configuration sends `off`; production API mode sends `api`.

For `api`, the handler validates the visitor, room/role policy, TURN server configuration, and all rate limits, then prepares the signed credential before committing room creation or membership. A signing/configuration failure therefore leaves no sender room, receiver membership, or ghost participant. The successful response includes STUN/TURN RTCIceServer DTOs, uses `Cache-Control: no-store`, and never exposes `TURN_SHARED_SECRET`.

coturn REST credentials use:

```text
username = <expiry unix seconds>:<visitor id>
credential = Base64(HMAC-SHA1(TURN_SHARED_SECRET, username))
```

`credentialExpiresAt` is Unix epoch milliseconds. It equals `room.expiresAt + 300_000`; the coturn username uses the same instant rounded down to Unix seconds. The five-minute grace means every PeerConnection created during the 30-minute room lifetime receives credentials that remain valid past the forced room close, without adding credential refresh or ICE restart to this milestone.

In `api` mode, missing/invalid TURN configuration is visible and blocks the atomic room operation instead of silently downgrading to STUN-only.

RTC configuration is resolved in this order:

```text
atomically create/join room and receive RTCConfiguration over HTTP
→ open WebSocket
→ create PeerSession
```

This prevents offers from arriving before the peer session has its TURN credentials. Reconnect and bounded peer retries reuse the resolved configuration only while `Date.now() < room.expiresAt`.

App schedules a room-expiry timer and also rechecks expiry on `visibilitychange`, WebSocket reconnect, and before every PeerConnection retry. Expiry closes realtime/peer/file resources and returns to the lobby before credentials expire. The API rejects expired rooms and coturn independently rejects allocations/refreshes after the credential timestamp.

### 11.3 Realtime Membership Attach and Resume

HTTP bootstrap is the only operation allowed to create room membership. Replace the WebSocket `room:join` command with `room:attach`:

```ts
type RoomAttachMessage = {
  type: 'room:attach'
  roomCode: string
  role: ParticipantRole
}
```

`room:attach` only verifies and attaches the authenticated socket to an existing bootstrap-created membership with the same role. It never calls `joinRoom`, creates a participant, or bypasses HTTP/IP/visitor/global admission limits. A visitor without bootstrap membership receives `ROOM_MEMBERSHIP_REQUIRED` and cannot send signaling.

Bootstrap creates the membership in `connecting` state with a 15-second attach deadline. A successful attach changes it to `online`. Unexpected socket disconnect or the bounded client reconnect path returns it to `connecting` and starts a fresh 15-second resume window instead of deleting it immediately. Re-attaching within that window preserves membership and rebuilds PeerSession state. Socket replacement remains generation-safe.

Explicit `room:leave`, attach/resume deadline expiry, room expiry, or visitor expiry removes membership and broadcasts `participant:left` exactly once. An explicit sender leave closes the room and removes all participants. Periodic cleanup also removes bootstrap memberships whose first WebSocket attach never arrives.

### 11.4 Configuration

Web:

```env
VITE_TURN_MODE=off
VITE_STUN_URLS=stun:stun.l.google.com:19302
VITE_TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
VITE_TURN_USERNAME=development-user
VITE_TURN_CREDENTIAL=development-password
VITE_ICE_TRANSPORT_POLICY=all
```

API/coturn:

```env
TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
TURN_SHARED_SECRET=<server-only random secret>
TURN_CREDENTIAL_GRACE_SECONDS=300
CORS_ALLOWED_ORIGINS=http://localhost:5713
TRUST_PROXY=false
```

Static mode validates that URLs, username, and credential are all present. No `VITE_TURN_SHARED_SECRET` variable exists.

### 11.5 coturn Deployment Template

Add a self-host template based on `coturn/coturn:4.14.0-r0` with:

- `use-auth-secret` and `static-auth-secret`;
- explicit realm and external/public IP configuration;
- UDP/TCP 3478 and TLS/TCP 5349 documentation;
- a bounded relay port range;
- `user-quota`, `total-quota`, `max-bps`, and server capacity limits;
- denied loopback, link-local, private, multicast, and other non-public peer ranges;
- no anonymous access;
- documented certificate/key mount paths, with real secrets excluded from the repository.

The template is deployable only after the operator supplies a public address/domain, firewall rules, and TLS certificate. Automated tests validate config generation and credential signing; full relay verification remains an environment test because CI has no public TURN endpoint.

## 12. API Hardening Included in Scope

TURN adds an abuse-sensitive public resource, so this milestone also includes:

- replace wildcard CORS with configured allowed origins and local-development defaults as browser defense in depth, not as the server abuse boundary;
- resolve the client IP from the socket address by default and honor forwarding headers only when `TRUST_PROXY=true` behind a documented trusted proxy;
- rate-limit visitor creation to 30/hour/IP;
- rate-limit room creation to 30/hour/IP and 10/hour/visitor;
- rate-limit room joins to 60/minute/IP and 20/minute/visitor;
- rate-limit API-mode credential bootstrap to 300/minute/instance, 20/minute/IP, 5/minute/visitor, and 30/minute/room before signing;
- cap the instance at 10,000 live visitors, 2,000 live rooms, 20 receivers per room, 10,000 sockets, and 50,000 rate-limit keys; admission first sweeps expired state, then returns `CAPACITY_EXCEEDED` without evicting active users;
- expire visitors after two hours without authenticated HTTP or WebSocket activity;
- run room/attach-window cleanup every 30 seconds and visitor/rate-limit-key cleanup every 60 seconds;
- remove rate-limit windows after their longest configured window plus 60 seconds, and reject unseen keys while the key cap is full;
- return `Cache-Control: no-store` for credential responses;
- keep stable typed API error codes;
- never log or serialize TURN shared secrets or issued credentials;
- document that the in-memory API remains single-instance and is not high availability.

All limits and cleanup services use injectable clocks/schedulers, expose explicit `start()`/`stop()` lifecycle methods for tests, and use stable `RATE_LIMITED` or `CAPACITY_EXCEEDED` errors. Server timers are released on shutdown. coturn quotas remain the final bandwidth/allocation boundary if an attacker rotates visitor IDs, rooms, or IPs. General account systems, persistent databases, distributed rate limiting, billing, observability stacks, and automatic TURN credential refresh/ICE restart are outside this milestone.

## 13. Error and Recovery Rules

- Invalid local selection is rejected before creating a transfer.
- A rejected file batch sends no binary chunks to that peer.
- Decision timeout marks only that peer rejected/timed out; other peers continue.
- Channel close cancels the peer’s active transfer and clears all backpressure promises.
- A malformed JSON control frame or unexpected binary chunk emits one protocol error without crashing React.
- Text modal closure does not affect sender delivery state.
- A file result stays available until the user closes it; object URLs are then revoked.
- A new room, terminal room error, visitor refresh, or component unmount clears dialogs, queues, Files, Blobs, URLs, timers, readers, and pending transfers.
- TURN configuration errors keep the user in a recoverable lobby with a precise toast.

## 14. Testing and Acceptance

### Automated

- contracts: exact v2 frame parsing, 10-file/100-MiB boundaries, malformed metadata, aggregate overflow;
- PeerSession: direct text delivery, text receipt, file reject-before-body, ordered chunks, byte mismatch, backpressure, progress, cancel, timeout, peer close, and cleanup;
- UI/state: text Copy/Close semantics, file Accept/Reject semantics, room-code copy, Avatar phase aggregation, generation-safe terminal hold, and object URL revocation;
- config/API: `off|static|api`, invalid partial static config, atomic bootstrap rollback, HMAC output with a fixed clock, epoch-millisecond expiry/grace, no-store, multi-key rate limits, state capacities/cleanup, and no secret leakage;
- realtime membership: WebSocket attach without HTTP bootstrap is rejected, reconnect inside 15 seconds resumes, deadline/explicit leave removes once, and no attach path calls `joinRoom`;
- regression: existing signaling authorization, reconnect bounds, stale visitor recovery, typecheck, lint, and production build.

### Browser acceptance

1. Two isolated sessions connect directly; sender and real receiver avatars animate only during transfer.
2. Text arrives immediately in a dialog containing the exact Chinese/newline/emoji body; Copy is exact; Close dismisses it.
3. Textarea focus changes only the border and creates no ring/shadow.
4. Room-code copy copies all six digits and reports success.
5. A two-file request shows metadata and Accept/Reject. Reject sends zero binary chunks.
6. Accept shows real progress, produces byte-identical downloads, and sender receives a receipt.
7. A 10-file batch at exactly 100 MiB is accepted; 11 files or one byte over is blocked locally and rejected by protocol validation.
8. Cancelling and disconnecting clear partial results without unhandled errors.
9. 320 px, 360 px, and desktop layouts have no horizontal overflow or clipped dialog actions.
10. Reduced-motion mode shows static transfer dots.
11. A configured public TURN environment is tested with `iceTransportPolicy: relay`; UDP relay and TLS/TCP fallback are verified separately.

## 15. Documentation Sources

- [coturn TURN REST authentication and server options](https://github.com/coturn/coturn/blob/master/README.turnserver)
- [RFC 8656: TURN](https://www.rfc-editor.org/rfc/rfc8656)
- [W3C WebRTC: RTCConfiguration and RTCDataChannel](https://www.w3.org/TR/webrtc/)
