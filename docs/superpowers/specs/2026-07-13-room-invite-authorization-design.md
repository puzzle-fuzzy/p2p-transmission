# Room Invite Authorization Design

**Date:** 2026-07-13
**Status:** Approved design, pending written-spec review
**Scope:** Replace six-digit-code admission with high-entropy invitation capabilities and sender-approved manual join requests without weakening the existing HTTP-membership and WebSocket-attach boundary.

## 1. Goal

Prevent an uninvited visitor from becoming a receiver, obtaining TURN credentials, attaching to room signaling, or receiving transfers by guessing a six-digit room code.

The product keeps both established entry paths, but gives them different authorization semantics:

- a valid invitation link is a room-scoped capability and lets the receiver join after an explicit local confirmation click;
- a manually entered room code creates a sender approval request and never creates membership by itself.

No compatibility path may allow a new visitor to join with only a room code.

## 2. Confirmed Product Decisions

1. Room codes are public identifiers, not secrets or authorization credentials.
2. Invitation links and QR codes contain a high-entropy room capability.
3. Opening an invitation never joins automatically; the receiver still clicks “加入房间”.
4. A valid invitation bypasses sender approval.
5. A manual room code changes the primary action to “请求加入”.
6. The sender receives an approval dialog and can allow or reject each visitor.
7. Multiple manual requests are queued by request ID and cannot overwrite one another.
8. An existing receiver can recover the same membership in the same browser tab without the original invitation or another approval.
9. Only the sender can access the invitation sharing surface.
10. The old unauthenticated join contract and public room lookup route are removed in the same deployment.

## 3. Authorization Model

### 3.1 Invitation capability

Room creation generates 32 cryptographically random bytes and encodes them as an unpadded base64url value with the exact format:

```text
inv_<43 base64url characters>
```

The resulting capability contains 256 bits of entropy. Its scope is fixed to one room and the receiver role. It is reusable by different visitors until the room expires or the sender closes the room.

The server returns the plaintext capability only in the successful room-creation response. The in-memory room stores only its SHA-256 digest. Verification hashes the candidate and compares the fixed-length digests with a constant-time comparison.

The API keeps its current synchronous service model. A small injected server crypto adapter uses synchronous `node:crypto` operations: `randomBytes(32)`, `createHash('sha256')`, and `timingSafeEqual`. Tests inject deterministic capability generation, digesting, and comparison adapters; Web Crypto `subtle.digest` is not introduced into the synchronous room/bootstrap call chain.

The capability must never appear in:

- `PublicRoom`;
- participant data;
- WebSocket messages;
- TURN usernames;
- browser storage;
- toast or error text;
- application logs.

### 3.2 Admission kinds

Receiver admission is an explicit discriminated union:

```ts
type ReceiverAdmission =
  | { kind: 'invite'; inviteToken: string }
  | { kind: 'approval'; requestId: string }
  | { kind: 'recovery' }

type ReceiverJoinBody =
  | {
      iceMode: RoomIceMode
      admission: { kind: 'invite'; inviteToken: string }
    }
  | {
      iceMode: RoomIceMode
      admission: { kind: 'recovery' }
    }
```

Rules:

- `invite` accepts a new receiver only when the capability matches the target room.
- `approval` accepts only the visitor, room, and request bound to an approved, unexpired request.
- `recovery` accepts only a visitor already present as a receiver in that room.
- an explicit invalid `invite` admission is rejected and never falls back to `recovery`, even when the visitor already has another room membership.
- a new visitor using `recovery` or an invalid admission receives the same external access-denied response.
- the public join route cannot request the sender role.

### 3.3 WebSocket boundary

The current boundary remains mandatory:

1. HTTP admission creates receiver membership and returns the room/TURN bootstrap.
2. WebSocket `room:attach` only attaches an existing matching member.
3. Signaling continues to require two online, attached room members.

Pending or approved-but-not-finalized requests are not room members and cannot attach, receive room participant state, obtain TURN credentials, or exchange signaling.

## 4. Shared Contracts

Add these exact public contract shapes without adding secret fields to existing public room types:

```ts
type RoomInviteCapability = {
  token: string
  expiresAt: number
}

type RoomOwnerBootstrap = RoomSessionBootstrap & {
  invite: RoomInviteCapability
}

type RoomJoinRequestState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'finalized'

type RoomJoinRequestReceipt = {
  requestId: string
  state: RoomJoinRequestState
  expiresAt: number
}

type RoomJoinRequestSummary = {
  requestId: string
  roomCode: string
  visitor: PublicVisitor
  createdAt: number
  expiresAt: number
}
```

`RoomJoinRequestReceipt.expiresAt` is the deadline for the current stored state. For `pending` it is the approval-request deadline. For `approved` it is the finalize deadline. For a terminal state it is the tombstone-removal deadline, allowing the bound client to observe the result before cleanup.

Add the following server realtime messages:

```ts
type RoomAccessServerMessage =
  | {
      type: 'room:join-requests'
      roomCode: string
      requests: RoomJoinRequestSummary[]
    }
  | {
      type: 'room:join-requested'
      request: RoomJoinRequestSummary
    }
  | {
      type: 'room:join-request-resolved'
      roomCode: string
      requestId: string
      state: Exclude<RoomJoinRequestState, 'pending'>
    }
```

The sender receives only summaries and state changes. Invitation plaintext never crosses the realtime channel.

## 5. Backend Components

### 5.1 Room service

`RoomService` continues to own room state, participants, capacity, expiry, and prepared membership mutations. The internal room model gains an invitation digest. Cloning and mutation-plan validation preserve that digest without exposing it through `toPublicRoom`.

The service exposes separate prepared operations for invitation join, existing-member recovery, and an internally authorized approval join. Invitation and recovery validation occur inside `RoomService`. The approval operation is not exposed by an HTTP route and is called by bootstrap orchestration only after `RoomAccessService` has produced a bound finalize plan.

Commit rechecks the current room, visitor identity, capacity, expiry, admission-specific room revision, and prepared-plan authenticity before adding membership. Raw invitation tokens and join-request IDs are not copied into the public room or public mutation plan.

The internal room lookup remains available to trusted services and the realtime hub, but is renamed to make its non-public purpose explicit. The HTTP `GET /v1/rooms/:code` route and unused Web client `getRoom` function are deleted.

### 5.2 Room access service

Add a focused `RoomAccessService` that owns manual requests and nothing else. It may read room snapshots through a narrow `RoomService` interface, but `RoomService` does not depend on it. This one-way dependency avoids a room/access service cycle. Its defaults are:

```text
request TTL:             90 seconds
approved finalize TTL:  30 seconds
terminal tombstone TTL: 30 seconds
maximum pending/room:    5
one pending request:     per room + visitor
```

It uses injected time and request-ID generation. It validates room/sender state through a narrow `RoomService` interface and visitor identity through `VisitorService`.

The service exposes operations for:

- creating or returning the existing pending request;
- reading a request bound to its receiver;
- listing pending requests for the current sender;
- approving or rejecting as the current sender;
- cancelling as the bound receiver;
- preparing and committing finalize as the approved receiver;
- expiring deadlines and removing requests for missing/closed rooms;
- publishing non-secret access transitions to subscribers.

The request state machine is:

```text
pending
  ├─ approved
  │    ├─ finalized
  │    ├─ cancelled
  │    └─ expired
  ├─ rejected
  ├─ cancelled
  └─ expired
```

Decision, cancel, and finalize operations are idempotent. A repeated identical or conflicting terminal operation returns the authoritative current state without changing it. Only one concurrent transition can win. A receiver may cancel while `pending` or `approved`; an approved request expires when its 30-second finalize deadline is reached.

A repeated finalize for the same bound visitor after `finalized` reuses existing-member recovery and returns a fresh valid bootstrap. This lets a client recover when the first successful HTTP response was lost.

### 5.3 Bootstrap orchestration

Direct invitation and recovery join use the existing bootstrap orchestration with the following order:

1. sweep room and access expiry;
2. consume the generic IP join limit;
3. validate and touch the visitor bearer;
4. consume the visitor join limit;
5. prepare and validate receiver admission;
6. consume TURN limits only for an authorized API-ICE request;
7. issue TURN credentials when required;
8. commit membership.

Manual request creation uses this order:

1. sweep expiry;
2. consume instance and IP request limits;
3. validate and touch the visitor;
4. consume the visitor request limit;
5. validate that an online sender can receive the request;
6. consume the room request limit;
7. create or return the idempotent pending request.

Finalization prepares an opaque access plan stored in a private `WeakMap` and bound to the room, request, receiver, request revision, and deadline. Forged, repeated, cancelled, expired, or stale plans are rejected before any room commit.

Bootstrap prepares the internal approved-room join, applies TURN limits, issues credentials, and calls one synchronous `RoomAccessService.commitFinalize(plan, commitMembership)` transaction. That method validates the opaque plan before invoking the supplied synchronous room-commit callback. If room commit fails, the request remains approved. If it succeeds, the method assigns `finalized` before any external callback and returns success without rereading time, room state, or request revision. Subscriber notification occurs afterward through `safePublish`; a throwing subscriber cannot roll back or surface as a failed finalize response.

A failed invitation, pending request, rejected request, expired request, TURN issuance, room preparation, or room commit never marks the request finalized and never leaves partial membership.

### 5.4 Maintenance and realtime hub

The maintenance admission sweep includes access-request expiry. Access transitions are published through the existing context composition and forwarded only to the target room’s attached sender socket.

When a sender successfully attaches or reattaches, the hub sends one `room:join-requests` snapshot containing all still-pending requests in stable `createdAt`, then `requestId` order. New requests produce `room:join-requested`. Approval, rejection, cancellation, expiry, and finalize produce `room:join-request-resolved` so the current sender socket and later reconnects converge on server state. The existing one-current-socket-per-visitor rule remains unchanged; this milestone does not promise simultaneous sender tabs.

## 6. HTTP API

### 6.1 Create a room

```http
POST /v1/rooms
Authorization: Bearer <visitor token>
Content-Type: application/json

{ "iceMode": "off" | "api" }
```

Success returns `RoomOwnerBootstrap`, including `invite`, and always sets `Cache-Control: no-store`.

### 6.2 Join with invitation or recover membership

```http
POST /v1/rooms/:code/join
Authorization: Bearer <visitor token>
Content-Type: application/json

{
  "iceMode": "off" | "api",
  "admission": {
    "kind": "invite",
    "inviteToken": "inv_..."
  }
}
```

Recovery uses the other exact union branch:

```json
{
  "iceMode": "off",
  "admission": { "kind": "recovery" }
}
```

The route is receiver-only. The Elysia schema requires one exact discriminated branch, rejects extra or mixed fields, and bounds `inviteToken` as a string before it reaches the service. Exact `inv_` format and digest validation happen inside the authorization service so malformed and incorrect token strings receive the same `ROOM_ACCESS_DENIED` response. A structurally missing or mixed admission branch is a request-schema error and cannot be interpreted as another branch. An existing matching receiver must explicitly use `recovery`; an invalid invitation is never ignored or reinterpreted as recovery.

### 6.3 Create a manual join request

```http
POST /v1/rooms/:code/join-requests
Authorization: Bearer <visitor token>
```

Success returns HTTP 202 with `RoomJoinRequestReceipt` in the `pending` state. Repeating the call for the same room and visitor returns the same live request.

### 6.4 Read request state

```http
GET /v1/rooms/:code/join-requests/:requestId
Authorization: Bearer <visitor token>
```

Only the bound receiver can read the receipt. While its tombstone exists, this endpoint always returns HTTP 200 with the authoritative `RoomJoinRequestReceipt`, including `rejected`, `cancelled`, `expired`, and `finalized` states. Only an unbound actor or a request already removed after tombstone expiry receives 404.

The Web client applies these exact polling rules:

- `pending`: continue polling every two seconds;
- `approved`: stop polling and immediately call finalize;
- `rejected`, `cancelled`, or `expired`: stop polling and return to the form;
- `finalized`: stop polling and continue through existing-member recovery.

### 6.5 Decide as sender

```http
POST /v1/rooms/:code/join-requests/:requestId/decision
Authorization: Bearer <sender visitor token>
Content-Type: application/json

{ "decision": "approve" | "reject" }
```

Only the room’s current sender may decide. Approval changes the receipt expiry to 30 seconds from the decision time. Idempotent decision replays return HTTP 200 with the authoritative receipt.

### 6.6 Finalize as receiver

```http
POST /v1/rooms/:code/join-requests/:requestId/finalize
Authorization: Bearer <receiver visitor token>
Content-Type: application/json

{ "iceMode": "off" | "api" }
```

Success returns the normal `RoomSessionBootstrap`, creates membership, and marks the request finalized. Finalize returns 409 while pending, 403 after rejection, and 410 after cancellation or expiry.

### 6.7 Cancel as receiver

```http
POST /v1/rooms/:code/join-requests/:requestId/cancel
Authorization: Bearer <receiver visitor token>
```

The bound receiver may cancel a pending or approved-but-not-finalized request. Idempotent cancel replays return HTTP 200 with the authoritative receipt.

All room creation, join, request, decision, status, finalize, and cancel responses set `Cache-Control: no-store`, including `off` ICE mode and every error response.

## 7. Rate Limits

The existing rate-limit service remains the source of enforcement.

Direct invitation/recovery join keeps:

```text
IP:       60/minute
visitor:  20/minute
```

Manual request creation uses:

```text
IP:       10/minute
visitor:   3/minute
room:     10/minute
```

Status polling uses:

```text
IP:       240/minute
visitor:   60/minute
```

Sender decisions use:

```text
IP:       60/minute
sender:   30/minute
```

Finalize uses the same admission limits as direct join and continues to apply the existing TURN instance, IP, visitor, and room credential limits:

```text
IP:       60/minute
visitor:  20/minute
```

Cancel uses:

```text
IP:       60/minute
visitor:  20/minute
```

Generic IP and visitor limits are consumed before room existence or invitation validity can be observed. Room-specific keys are created only after the room has been validated, avoiding attacker-controlled rate-key growth.

Status, decision, finalize, and cancel all use the same authorization order: consume the generic IP limit, validate and touch the bearer, consume the actor-specific limit, verify request binding and role, then apply any room/request-specific limit. An outsider guessing a request ID receives the same `ROOM_JOIN_REQUEST_NOT_FOUND` response regardless of the room or request state.

## 8. External Errors

New visitors receive the same error for a missing room, expired room, missing invitation, malformed invitation, wrong invitation, or cross-room invitation:

```text
ROOM_ACCESS_DENIED
HTTP 404
邀请链接无效或已过期
```

Manual request creation uses one indistinguishable response when the room is missing, expired, closed, has no online sender, or already holds the maximum pending queue:

```text
ROOM_REQUEST_UNAVAILABLE
HTTP 404
房间不存在或暂时无法接收申请
```

An actor not bound to a request, or a non-sender attempting a decision, receives:

```text
ROOM_JOIN_REQUEST_NOT_FOUND
HTTP 404
加入申请不存在或已失效
```

The status endpoint represents rejection, cancellation, expiry, and finalize as HTTP 200 receipt states while the tombstone exists. The following errors apply only when an action is invalid for the authoritative state:

```text
ROOM_JOIN_REQUEST_REJECTED        HTTP 403 on finalize
ROOM_JOIN_REQUEST_NOT_APPROVED    HTTP 409 on finalize
ROOM_JOIN_REQUEST_CANCELLED       HTTP 410 on finalize
ROOM_JOIN_REQUEST_EXPIRED         HTTP 410 on finalize
CAPACITY_EXCEEDED                 HTTP 503
RATE_LIMITED                      HTTP 429 with Retry-After
```

Network and server failures retain the in-memory invitation or request state and expose a retry action. Deterministic room, invitation, rejection, expiry, or membership errors clear invalid recovery state.

## 9. Web Invite Parsing and Sharing

New share URLs use the current deployment path and encode both values atomically in the fragment:

```text
https://host/current/base/#room=123456&invite=inv_xxx
```

The pure parser accepts exactly one `room` and one `invite`, exactly six ASCII digits, and the exact invitation-token format. Missing, duplicate, empty, encoded-invalid, short, long, or unknown-key fragments are invalid as a whole.

At application startup:

1. parse the complete fragment once;
2. store a valid invitation intent only in React memory;
3. clear the fragment with `history.replaceState` while preserving path, query, and existing history state;
4. suppress automatic recovery when a valid or invalid invitation fragment was supplied;
5. require explicit user confirmation before joining.

A legacy `?room=123456` query may prefill a manual room-code request, but it never carries invitation authority and never uses the direct-join path.

Editing any digit of an invitation-prefilled room code discards the in-memory invitation and changes the action to a manual request. A token can never be submitted with a different room code.

The sender’s share dialog builds its URL through the same pure helper used by QR, clipboard, and native sharing. The dialog does not expose a separate token control. It says:

> 扫描二维码或打开房间链接加入；房间码仅用于核对。

It also says:

> 此链接包含加入权限，请只发送给可信接收者。

The receiver does not see the invitation share button.

## 10. Web Join State and UI

Frontend orchestration uses an explicit intent rather than a boolean session flag:

```ts
type JoinIntent =
  | { kind: 'invite'; roomCode: string; inviteToken: string }
  | { kind: 'recovery'; roomCode: string }
  | { kind: 'manualRequest'; roomCode: string }
```

The visible state is represented by a focused reducer:

```ts
type JoinStatus =
  | { kind: 'idle' }
  | { kind: 'joining'; source: 'invite' | 'recovery' }
  | { kind: 'requestingApproval'; roomCode: string }
  | {
      kind: 'awaitingApproval'
      roomCode: string
      requestId: string
      expiresAt: number
    }
  | {
      kind: 'error'
      roomCode?: string
      code: string
      message: string
      retryable: boolean
    }
```

Invitation-first join and manual request creation mint a fresh receiver visitor identity once per join intent before admission. Invitation join may mint and retry once when the server reports `VISITOR_NOT_FOUND`, because it still holds authorization. Recovery strictly reuses the saved visitor identity and must not mint a new visitor to bypass a missing membership.

Manual request retries reuse the same visitor bearer until the intent is cancelled, rejected, expired, finalized, or replaced by another room. If the server created a request but the HTTP 202 response was lost, retrying with that bearer returns the same request ID. A retry must not mint another visitor or consume another pending slot.

### 10.1 Invite path

- Prefill the six digits.
- Show “已读取邀请链接，确认后加入房间”.
- Keep the primary label “加入房间”.
- On click, perform invitation admission and connect normally.

### 10.2 Manual path

- Use the label “请求加入”.
- After HTTP 202, replace the join form with a waiting view.
- Show the receiver avatar, room code, remaining time, “取消申请”, and “更换房间”.
- Poll every two seconds.
- Continue polling only while pending; stop and automatically finalize immediately after approval.
- On rejection or expiry, return to the form and retain the room code.

### 10.3 Sender approval dialog

- Display the visitor avatar and display name.
- State that the visitor requests access to the current room.
- Use a larger primary “允许加入” button and a smaller ghost “拒绝” button.
- Show the number of remaining requests when the queue contains more than one.
- Disable both actions while the selected decision is pending.
- Reconcile failures against the next server snapshot instead of dropping the request locally.

## 11. Recovery and Storage

Visitor identity and receiver room recovery must have the same tab-scoped lifetime.

- Move the receiver room session to a versioned `sessionStorage` key.
- Delete the legacy room-session value from `localStorage` during migration.
- Never store the invitation capability or join-request authorization in either storage.
- Successful invitation or finalized approval stores only room code, receiver role, and room expiry.
- A same-tab refresh reuses the same visitor membership and performs recovery admission without invitation or approval.
- A browser restart does not claim recovery with a missing visitor identity.
- A valid or malformed new invitation fragment prevents old-room auto-recovery on that navigation.
- Explicit leave, room expiry, sender close, membership loss, or deterministic authorization failure clears receiver recovery.
- Network and 5xx failures retain recovery for a later refresh.

Sender recovery remains unsupported. The plaintext invitation is held in the sender’s in-memory room state until leave, expiry, or page teardown.

## 12. Security Headers and Logging

The Web document sets:

```text
Referrer-Policy: no-referrer
```

The application must not log:

- Authorization or visitor tokens;
- WebSocket token query values;
- invitation capabilities;
- request or response bodies containing secrets;
- SDP or ICE candidates;
- transferred text;
- file names or file metadata.

This milestone does not introduce a new structured logger. If logging is added later, token/header/query redaction must be implemented and tested before request-body or URL logging is enabled.

## 13. Migration

The API stores rooms in one process with a 30-minute TTL. Deployment therefore performs a hard protocol cut:

1. restart the API and invalidate old in-memory rooms;
2. deploy the new API and Web contracts together;
3. remove the old room-code-only join body and public room lookup;
4. never let the new Web client fall back to the old admission path.

There is no insecure dual-mode compatibility window.

## 14. Testing Strategy

Implementation is test-first and covers:

1. Contract validators for invitation format, owner bootstrap, discriminated join bodies, receipts, summaries, states, and realtime events; an invalid invite branch never falls back to recovery.
2. Token generation, entropy shape, hashing, constant-time comparison, and cross-room rejection.
3. Room-service invite, approval, recovery, capacity, expiry, concurrent join, forged plan, and commit recheck behavior.
4. Room-access duplicate request, max pending, approve, reject, cancel, expiry, finalize, idempotency, concurrent terminal transitions, stale/forged finalize plans, and exact 90-second/30-second `deadline - 1` and `deadline` boundaries.
5. Bootstrap ordering, rate consumption, TURN issuance only after authorization, no partial membership on failure, repeated finalize after a lost response, and ordinary recovery after finalized tombstone cleanup.
6. Route authentication, receiver-only join, sender-only decision, uniform outsider errors, finalize/cancel rate limits, `Retry-After`, and `no-store` on off-mode successes and every error response.
7. Status polling returning HTTP 200 receipts for every retained tombstone state and 404 only for unbound or cleaned requests.
8. Manual request creation after a lost HTTP 202 response returning the same request ID for the same visitor without consuming another pending slot.
9. Manual missing, expired, closed, sender-offline, and pending-full cases returning indistinguishable external responses.
10. Realtime sender targeting, stable snapshot ordering, reconnect snapshots, duplicate event/snapshot deduplication, incremental request delivery, throwing-subscriber isolation, and secret absence.
11. Fragment parsing/clearing, path-preserving URL construction, legacy query manual semantics, and token discard after code edits.
12. Invite confirmation, manual waiting/cancel, sender approval/rejection, multiple queued requests, and approved auto-finalize.
13. Same-tab receiver recovery, browser-restart non-recovery, invitation-over-recovery priority, and no fresh-identity recovery bypass.
14. Owner-bootstrap validation accepting `invite` while ordinary `RoomSessionBootstrap`, `PublicRoom`, realtime, and error validators reject secret fields.
15. One invitation link admitting multiple distinct receivers up to the existing capacity.
16. Full dependency lock validation, focused tests, `bun run verify`, and a forced no-cache workspace verification.

## 15. Acceptance Criteria

The milestone is complete only when:

- a room code alone cannot create membership, obtain TURN, attach WebSocket signaling, or receive transfers;
- a valid invitation admits a receiver only after the receiver clicks the local confirmation action;
- one invitation admits multiple distinct receivers up to the existing limit of 20;
- manual room-code entry always creates a sender approval request;
- pending requests do not appear as room participants;
- only the current room sender can approve or reject;
- multiple requests remain isolated by request ID and all transitions are idempotent;
- approval finalization alone creates membership and TURN credentials;
- existing receivers recover in the same tab without invitation or repeated approval;
- recovery cannot mint a new identity and bypass authorization;
- invitation data is absent from URLs after parsing, browser storage, public DTOs, realtime messages, errors, and logs;
- only senders see invitation sharing;
- public room lookup and sender-role join requests are removed;
- all focused and workspace verification commands pass with zero lint warnings and successful production builds.

## 16. Explicitly Deferred

The next security sub-project is:

- a short-lived, single-use WebSocket connection ticket replacing the long-lived visitor token in the URL query;
- signaling frame-size, rate, and outbound-queue limits;
- SDP and ICE validation limits.

Later product/security work includes:

- invitation rotation and revocation;
- room locking;
- sender removal of an already admitted receiver;
- application-layer authenticated encryption;
- resumable transfer, streaming-to-disk, and file digests;
- multi-instance shared room/signaling state.

These items do not create a compatibility exception for room-code-only admission.
