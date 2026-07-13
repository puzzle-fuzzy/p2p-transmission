# Room Invite Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a six-digit room code an identifier rather than an admission secret: secure invitation links join after receiver confirmation, while manual room-code entry creates a sender-approved request.

**Architecture:** Keep HTTP as the only membership-admission boundary and WebSocket as attach/signaling only. Add a hashed room invitation capability to `RoomService`, a separate in-memory `RoomAccessService` for manual approval state, and one bootstrap transaction that commits approved membership atomically. The Web client consumes invitation fragments into memory, stores receiver recovery per tab, and models invitation, approval waiting, and sender decisions with focused reducers and components.

**Tech Stack:** Bun 1.3.14, Turborepo, TypeScript 6, Elysia, React 19, Vite 8, Tailwind CSS 4, Bun test, Vitest, Testing Library, Node crypto, WebSocket, WebRTC.

**Approved design:** `docs/superpowers/specs/2026-07-13-room-invite-authorization-design.md`

## Global Constraints

- The room code is never sufficient for direct admission. Manual six-digit entry always creates a sender decision request.
- Invitation capabilities have the exact format `inv_` plus 43 unpadded base64url characters, contain 256 bits of entropy, and are scoped to one room and the receiver role.
- The server returns invitation plaintext only in a successful owner bootstrap and stores only its SHA-256 digest.
- Invitation plaintext must never enter `PublicRoom`, realtime messages, TURN usernames, logs, errors, browser storage, DOM text, or a standalone copy control.
- The HTTP join route is receiver-only. An invalid explicit invitation never falls back to recovery.
- Pending or approved-but-not-finalized requests are not members and receive no participant snapshot, TURN credentials, signaling, or room attachment.
- Manual requests use a 90-second pending TTL, a 30-second approved-finalize TTL, a 30-second terminal tombstone, at most five pending requests per room, and one live pending request per room/visitor pair.
- Request transitions are idempotent. An opaque finalize plan must be validated before the room commit callback runs; room failure leaves the request approved, while room success marks it finalized before non-throwing publication.
- The public `GET /v1/rooms/:code` endpoint and Web `getRoom()` client are removed.
- All room create/join/access responses, including schema and service errors and ICE-off success, use `Cache-Control: no-store`; the Web document uses `Referrer-Policy: no-referrer`.
- Receiver recovery and visitor identity are scoped to the same browser tab. Storage contains only room code, receiver role, and expiry—never invite token or request ID.
- Valid and malformed invitation fragments are cleared immediately and both suppress old-room recovery. A valid invite is held only in React memory until the receiver confirms or edits the code.
- Focused tests are written before production changes. Every task ends with its focused test, typecheck where relevant, `git diff --check`, and a small commit.
- No new runtime dependency, database, sender recovery, simultaneous sender-tab support, WebSocket admission ticket, or transfer-protocol change is included in this milestone.

---

### Task 1: Freeze Shared Admission Contracts and Runtime Guards

**Files:**

- Create: `packages/contracts/src/room-access.ts`
- Create: `packages/contracts/src/room-access.test.ts`
- Modify: `packages/contracts/src/model.ts`
- Modify: `packages/contracts/src/ice.ts`
- Modify: `packages/contracts/src/ice.test.ts`
- Modify: `packages/contracts/src/realtime.ts`
- Modify: `packages/contracts/src/realtime.type-test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**

```ts
export type RoomInviteCapability = {
  token: string
  expiresAt: number
}

export type RoomOwnerBootstrap = RoomSessionBootstrap & {
  invite: RoomInviteCapability
}

export type RoomJoinRequestState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'finalized'

export type RoomJoinRequestReceipt = {
  requestId: string
  state: RoomJoinRequestState
  expiresAt: number
}

export type RoomJoinRequestSummary = {
  requestId: string
  roomCode: string
  visitor: PublicVisitor
  createdAt: number
  expiresAt: number
}

export type ReceiverAdmission =
  | { kind: 'invite'; inviteToken: string }
  | { kind: 'approval'; requestId: string }
  | { kind: 'recovery' }

export type ReceiverJoinBody =
  | { iceMode: RoomIceMode; admission: { kind: 'invite'; inviteToken: string } }
  | { iceMode: RoomIceMode; admission: { kind: 'recovery' } }

export const isReceiverJoinBody: (value: unknown) => value is ReceiverJoinBody
export const isRoomAccessServerMessage: (value: unknown) => value is RoomAccessServerMessage
```

`ReceiverAdmission['approval']` is an internal orchestration contract and is not accepted by the public join-body guard.

- [ ] **Step 1: Write failing exact-shape tests**

Add table tests for `isRoomInviteToken`, `isReceiverJoinBody`, `isRoomOwnerBootstrap`, `isRoomJoinRequestReceipt`, `isRoomJoinRequestSummary`, and `isRoomAccessServerMessage`. Cover both exact join-body branches, rejection of `approval`/mixed/extra fields, the exact token regex, six-digit ASCII codes, positive safe epoch values, request IDs of 1–96 characters, exact object keys, and rejection of `inviteToken`/`requestId` extra fields in ordinary `RoomSessionBootstrap`. Owner bootstrap validation must require `invite.expiresAt === room.expiresAt`; the realtime guard must reject extra or secret-bearing fields and a resolved event whose state is `pending`.

```ts
expect(isRoomInviteToken(`inv_${'A'.repeat(43)}`)).toBe(true)
expect(isRoomInviteToken(`inv_${'A'.repeat(42)}`)).toBe(false)
expect(isRoomInviteToken(`inv_${'A'.repeat(44)}`)).toBe(false)
expect(isRoomInviteToken(`inv_${'A'.repeat(42)}=`)).toBe(false)
```

- [ ] **Step 2: Prove the current contract suite fails**

Run:

```bash
bun run --cwd packages/contracts test src/room-access.test.ts src/ice.test.ts
```

Expected: failures because admission types/guards and owner bootstrap do not exist and ordinary bootstrap validation does not yet reject the owner-only field explicitly.

- [ ] **Step 3: Implement platform-neutral guards and exports**

Keep record/exact-key helpers local and dependency-free. Add `INVALID_STATE` plus these public API error codes to `ApiErrorCode`:

```ts
| 'ROOM_ACCESS_DENIED'
| 'ROOM_REQUEST_UNAVAILABLE'
| 'ROOM_JOIN_REQUEST_NOT_FOUND'
| 'ROOM_JOIN_REQUEST_REJECTED'
| 'ROOM_JOIN_REQUEST_NOT_APPROVED'
| 'ROOM_JOIN_REQUEST_CANCELLED'
| 'ROOM_JOIN_REQUEST_EXPIRED'
| 'INVALID_STATE'
```

Define `RoomAccessServerMessage` exactly as approved and include it in `ServerRealtimeMessage`:

```ts
export type RoomAccessServerMessage =
  | { type: 'room:join-requests'; roomCode: string; requests: RoomJoinRequestSummary[] }
  | { type: 'room:join-requested'; request: RoomJoinRequestSummary }
  | {
      type: 'room:join-request-resolved'
      roomCode: string
      requestId: string
      state: Exclude<RoomJoinRequestState, 'pending'>
    }
```

- [ ] **Step 4: Add compile-time secrecy assertions**

Extend `realtime.type-test.ts` so invitation fields are not assignable to `PublicRoom`, `RoomJoinRequestSummary`, or `RoomAccessServerMessage`, and `approval` is not assignable to `ReceiverJoinBody`.

- [ ] **Step 5: Run and commit**

```bash
bun run --cwd packages/contracts test
bun run --cwd packages/contracts typecheck
bun run --cwd packages/contracts lint
git diff --check
git add packages/contracts/src
git commit -m "feat(contracts): define room admission protocol"
```

Expected: all contract tests/type assertions pass and the public room shape remains unchanged.

---

### Task 2: Add the Synchronous Invitation Crypto Boundary

**Files:**

- Create: `services/api/src/shared/room-invite-crypto.ts`
- Create: `services/api/src/shared/room-invite-crypto.test.ts`

**Interfaces:**

```ts
export type RoomInviteCrypto = {
  createToken(): string
  digest(token: string): Uint8Array
  equals(left: Uint8Array, right: Uint8Array): boolean
}

export const createNodeRoomInviteCrypto: () => RoomInviteCrypto
```

- [ ] **Step 1: Write failing adapter tests**

Test exact format, uniqueness over 128 generated tokens, 32-byte SHA-256 output, equal digest acceptance, unequal digest rejection, and safe `false` for different digest lengths. Do not add a wall-clock timing assertion.

- [ ] **Step 2: Run the missing-module test**

```bash
bun run --cwd services/api test src/shared/room-invite-crypto.test.ts
```

Expected: failure because the adapter is absent.

- [ ] **Step 3: Implement with Node crypto only**

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const PREFIX = 'inv_'

export const createNodeRoomInviteCrypto = (): RoomInviteCrypto => ({
  createToken: () => `${PREFIX}${randomBytes(32).toString('base64url')}`,
  digest: token => createHash('sha256').update(token, 'utf8').digest(),
  equals: (left, right) => left.byteLength === right.byteLength
    && timingSafeEqual(left, right),
})
```

Keep the service synchronous; do not use Web Crypto or store plaintext in the adapter.

- [ ] **Step 4: Run and commit**

```bash
bun run --cwd services/api test src/shared/room-invite-crypto.test.ts
bun run --cwd services/api typecheck
git diff --check
git add services/api/src/shared/room-invite-crypto.ts services/api/src/shared/room-invite-crypto.test.ts
git commit -m "feat(api): add room invitation crypto adapter"
```

---

### Task 3: Make Room Membership Admission Explicit and Secret-Safe

**Files:**

- Modify: `services/api/src/modules/room/model.ts`
- Modify: `services/api/src/modules/room/service.ts`
- Modify: `services/api/src/modules/room/service.test.ts`

**Interfaces:**

```ts
export type RoomCreateMutationPlanResult =
  | { ok: true; plan: RoomMutationPlan; invite: RoomInviteCapability }
  | { ok: false; error: RoomError }

export type RoomService = {
  prepareCreate(senderToken: string): RoomCreateMutationPlanResult
  prepareInviteJoin(code: string, visitorToken: string, inviteToken: string): RoomMutationPlanResult
  prepareReceiverRecovery(code: string, visitorToken: string): RoomMutationPlanResult
  prepareApprovedReceiverJoin(code: string, visitorToken: string): RoomMutationPlanResult
  commit(plan: RoomMutationPlan): RoomResult
  getInternalRoomSnapshot(code: string): RoomResult
  attach(code: string, visitorId: string, role: ParticipantRole): RoomTransitionResult
  markConnecting(visitorId: string, roomCodes: readonly string[]): RoomTransition[]
  leave(code: string, visitorId: string): RoomTransitionResult
  removeVisitor(visitorId: string): RoomTransition[]
  cleanupExpiredState(): RoomTransition[]
}
```

- [ ] **Step 1: Write failing admission and secrecy tests**

Add tests proving:

- create generates one token, stores only a digest, returns token expiry equal to room expiry, and never exposes token/digest through the plan room or `PublicRoom`;
- a valid invitation prepares a receiver mutation, while malformed/wrong/cross-room invitations all return `ROOM_ACCESS_DENIED`;
- an explicit bad invitation never falls back for an existing receiver;
- recovery succeeds only for a currently matching receiver and rejects new visitors/senders with `ROOM_ACCESS_DENIED`;
- approved internal join can add a receiver but has no public route-facing discriminator;
- the same valid invitation admits 20 distinct receivers and the 21st is rejected by the existing receiver-capacity rule;
- capacity, expiry, revision, visitor identity, opaque-plan, forged-plan, mutated-plan, and replayed-plan checks still execute at commit;
- invitation digest survives clone/preview and disappears when the room closes.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
bun run --cwd services/api test src/modules/room/service.test.ts
```

- [ ] **Step 3: Refactor the internal model**

Add `inviteDigest: Uint8Array` only to the internal `Room`, inject a required `RoomInviteCrypto`, and keep `toPublicRoom()` unchanged. Replace the generic `prepareJoin()` branch with the three receiver-specific methods. Rename `getRoom()` to `getInternalRoomSnapshot()` and remove the unsafe `createRoom()`, `joinRoom()`, `leaveRoom()`, `cleanupExpiredRooms()`, and optional-role wrappers after callers migrate.

Use one uniform error for invite/recovery authorization:

```ts
const roomAccessDenied = {
  code: 'ROOM_ACCESS_DENIED' as const,
  message: '房间链接无效或已过期',
}
```

The private prepared mutation may record an admission kind, but the public mutation plan must contain no raw token, digest, or request ID.

- [ ] **Step 4: Preserve commit atomicity**

Delete the `WeakMap` entry before validating/replaying a plan, re-read the visitor and room, recheck expiry/capacity/revision, then add the receiver and increment the revision exactly once. Invitation validation belongs to preparation and its room revision binding prevents a stale invite plan from bypassing later capacity changes.

- [ ] **Step 5: Run and commit**

```bash
bun run --cwd services/api test src/modules/room/service.test.ts
bun run --cwd services/api typecheck
git diff --check
git add services/api/src/modules/room
git commit -m "feat(api): authorize receiver room membership"
```

---

### Task 4: Implement the Manual Join-Request State Machine

**Files:**

- Create: `services/api/src/modules/room-access/model.ts`
- Create: `services/api/src/modules/room-access/service.ts`
- Create: `services/api/src/modules/room-access/service.test.ts`

**Interfaces:**

```ts
export type RoomAccessTransition =
  | { type: 'room:join-requested'; senderId: string; request: RoomJoinRequestSummary }
  | {
      type: 'room:join-request-resolved'
      senderId: string
      roomCode: string
      requestId: string
      state: Exclude<RoomJoinRequestState, 'pending'>
    }

export type RoomAccessError = {
  code:
    | 'VISITOR_NOT_FOUND'
    | 'ROOM_REQUEST_UNAVAILABLE'
    | 'ROOM_JOIN_REQUEST_NOT_FOUND'
    | 'ROOM_JOIN_REQUEST_REJECTED'
    | 'ROOM_JOIN_REQUEST_NOT_APPROVED'
    | 'ROOM_JOIN_REQUEST_CANCELLED'
    | 'ROOM_JOIN_REQUEST_EXPIRED'
    | 'INVALID_STATE'
  message: string
}

export type RoomJoinRequestResult =
  | { ok: true; receipt: RoomJoinRequestReceipt }
  | { ok: false; error: RoomAccessError }

export type RoomJoinRequestListResult =
  | { ok: true; requests: RoomJoinRequestSummary[] }
  | { ok: false; error: RoomAccessError }

export type FinalizePlanResult =
  | { ok: true; mode: 'commit'; plan: RoomAccessFinalizePlan }
  | { ok: true; mode: 'recovery'; receipt: RoomJoinRequestReceipt }
  | { ok: false; error: RoomAccessError }

export type RoomAccessFinalizePlan = {
  readonly requestId: string
  readonly roomCode: string
  readonly visitorId: string
  readonly revision: number
  readonly expiresAt: number
}

export type RoomFinalizeCommitResult =
  | { ok: true; receipt: RoomJoinRequestReceipt; room: PublicRoom }
  | { ok: false; error: RoomAccessError | RoomError }

export type RoomAccessService = {
  createOrGetPending(roomCode: string, visitorToken: string): RoomJoinRequestResult
  readReceipt(roomCode: string, requestId: string, visitorToken: string): RoomJoinRequestResult
  listPendingForSender(roomCode: string, senderToken: string): RoomJoinRequestListResult
  decide(roomCode: string, requestId: string, senderToken: string, decision: 'approve' | 'reject'): RoomJoinRequestResult
  cancel(roomCode: string, requestId: string, visitorToken: string): RoomJoinRequestResult
  prepareFinalize(roomCode: string, requestId: string, visitorToken: string): FinalizePlanResult
  commitFinalize(plan: RoomAccessFinalizePlan, commitMembership: () => RoomResult): RoomFinalizeCommitResult
  cleanupExpiredState(): RoomAccessTransition[]
  removeVisitor(visitorId: string): RoomAccessTransition[]
  subscribe(listener: (transition: RoomAccessTransition) => void): () => void
}
```

- [ ] **Step 1: Write state-machine tests first**

Cover exact boundaries at `deadline - 1`, `deadline`, and tombstone deletion for:

- idempotent create by room/visitor and five-pending room capacity;
- a room/visitor idempotency index retained through approved and all terminal tombstones, so a replay returns the same request ID and authoritative receipt even when a sender decision raced the lost 202 response;
- an idempotent create retry publishes no second `room:join-requested` transition and occupies no second pending slot; the index is deleted only with tombstone cleanup;
- unavailable missing/expired/closed/no-online-sender rooms using only `ROOM_REQUEST_UNAVAILABLE`;
- stable list order by `createdAt`, then `requestId`;
- receiver-bound status/cancel and sender-bound decision, with outsiders receiving only `ROOM_JOIN_REQUEST_NOT_FOUND`;
- `pending -> approved -> finalized`, `pending -> rejected`, cancellation from pending/approved, and automatic expiry;
- approval resetting `expiresAt` to 30 seconds and every terminal transition resetting it to a 30-second tombstone;
- repeated/conflicting decisions and cancellations returning the authoritative state without a second transition;
- finalized prepare selecting recovery, so a lost first response is recoverable;
- missing room or removed visitor cleanup and subscriber-throw isolation.

- [ ] **Step 2: Write finalize transaction/race tests**

Use deferred synchronous callbacks and forged plain objects to prove:

- only the exact opaque `WeakMap` plan can invoke the callback;
- a plan binds room, request, visitor, revision, and approval deadline;
- the callback executes at most once;
- callback failure leaves the request approved;
- callback success marks finalized before a subscriber observes it;
- a throwing subscriber cannot turn success into failure;
- cancel/expiry/second finalize cannot win after a successful commit;
- no time or request revision is reread after the membership callback succeeds.

- [ ] **Step 3: Run the missing-service test**

```bash
bun run --cwd services/api test src/modules/room-access/service.test.ts
```

- [ ] **Step 4: Implement storage, deadlines, and safe publication**

Use injected `now` and `createRequestId`, internal maps indexed by request ID and room/visitor, and these defaults:

```ts
const REQUEST_TTL_MS = 90_000
const APPROVED_TTL_MS = 30_000
const TOMBSTONE_TTL_MS = 30_000
const MAX_PENDING_PER_ROOM = 5
```

Read rooms through `getInternalRoomSnapshot`, validate sender online status, and convert visitors with the injected visitor service. Never place bearer tokens in request records or transitions; store visitor/sender IDs only.

- [ ] **Step 5: Implement the finalize critical section**

`commitFinalize` must validate and consume the opaque plan before calling `commitMembership`. If the callback reports failure, retain approved state. If it reports success, assign finalized and its tombstone deadline, then publish through a `try/catch`-guarded notifier. Return the callback value without a second room/time check.

- [ ] **Step 6: Run and commit**

```bash
bun run --cwd services/api test src/modules/room-access/service.test.ts
bun run --cwd services/api typecheck
git diff --check
git add services/api/src/modules/room-access
git commit -m "feat(api): manage sender-approved room requests"
```

---

### Task 5: Orchestrate Admission, Rate Limits, TURN, and Finalize

**Files:**

- Modify: `services/api/src/modules/room/bootstrap.ts`
- Modify: `services/api/src/modules/room/bootstrap.test.ts`

**Interfaces:**

```ts
export type RoomBootstrapError = RoomError | RoomAccessError | RateLimitError | TurnError

export type RoomBootstrapResult =
  | { ok: true; bootstrap: RoomSessionBootstrap }
  | { ok: false; error: RoomBootstrapError }

export type RoomOwnerBootstrapResult =
  | { ok: true; bootstrap: RoomOwnerBootstrap }
  | { ok: false; error: RoomBootstrapError }

export type RoomAccessOperationResult =
  | { ok: true; receipt: RoomJoinRequestReceipt }
  | { ok: false; error: RoomAccessError | RateLimitError }

export type RoomBootstrapService = {
  createRoom(input: { visitorToken: string; clientIp: string; iceMode: RoomIceMode }): RoomOwnerBootstrapResult
  joinRoom(input: {
    code: string
    visitorToken: string
    clientIp: string
    iceMode: RoomIceMode
    admission: ReceiverJoinBody['admission']
  }): RoomBootstrapResult
  createJoinRequest(input: { code: string; visitorToken: string; clientIp: string }): RoomAccessOperationResult
  readJoinRequest(input: { code: string; requestId: string; visitorToken: string; clientIp: string }): RoomAccessOperationResult
  decideJoinRequest(input: {
    code: string
    requestId: string
    visitorToken: string
    clientIp: string
    decision: 'approve' | 'reject'
  }): RoomAccessOperationResult
  finalizeJoinRequest(input: {
    code: string
    requestId: string
    visitorToken: string
    clientIp: string
    iceMode: RoomIceMode
  }): RoomBootstrapResult
  cancelJoinRequest(input: { code: string; requestId: string; visitorToken: string; clientIp: string }): RoomAccessOperationResult
}
```

- [ ] **Step 1: Replace bootstrap tests with exact authorization-order tests**

Use call-order spies to test:

- create sweeps, authenticates, limits, prepares, issues optional TURN, commits, and returns `RoomOwnerBootstrap` with no-store-ready data;
- invite/recovery consume generic IP before visitor lookup, visitor limit before admission preparation, and TURN keys only after authorized preparation;
- invalid invite and recovery never issue TURN or commit membership;
- request creation consumes `room:join-request:instance` (300/min) and IP (10/min) before bearer validation, visitor (3/min) after touch, and room (10/min) only after a valid requestable room;
- a deduplicated manual retry still consumes its instance/IP/visitor/room entrance limits but does not create a new pending slot;
- status uses IP 240/min and visitor 60/min;
- decisions use IP 60/min and sender 30/min;
- cancel uses IP 60/min and visitor 20/min;
- finalize uses join IP 60/min, visitor 20/min, then optional TURN instance/IP/visitor/room limits;
- attacker-controlled room/request strings do not allocate room-specific rate keys before authorization;
- failed TURN issuance, sender leave/room close between approval and finalize, and failed room commit leave an approved request unfinalized.
- a finalized request remains recoverable through ordinary receiver recovery after its tombstone has been cleaned up.

- [ ] **Step 2: Run focused tests and confirm failures**

```bash
bun run --cwd services/api test src/modules/room/bootstrap.test.ts
```

- [ ] **Step 3: Implement explicit per-operation orchestration**

Keep shared helpers for rate checks and bootstrap assembly, but do not hide operation order in one generic callback that can accidentally prepare before limiting. `joinRoom` dispatches only the exact invite/recovery union branches. `finalizeJoinRequest` performs:

```text
sweep -> IP -> touch -> visitor limit -> access prepare
-> internal approved-room prepare -> TURN limits -> TURN issue
-> roomAccess.commitFinalize(plan, () => rooms.commit(roomPlan))
-> bootstrap assembly
```

If `prepareFinalize` identifies an already-finalized receipt, use `prepareReceiverRecovery` and return a fresh bootstrap without trying to finalize twice.

- [ ] **Step 4: Run and commit**

```bash
bun run --cwd services/api test src/modules/room/bootstrap.test.ts src/modules/room-access/service.test.ts src/modules/room/service.test.ts
bun run --cwd services/api typecheck
git diff --check
git add services/api/src/modules/room/bootstrap.ts services/api/src/modules/room/bootstrap.test.ts
git commit -m "feat(api): orchestrate authorized room admission"
```

---

### Task 6: Compose Access Expiry into Maintenance and Application Context

**Files:**

- Modify: `services/api/src/modules/maintenance/service.ts`
- Modify: `services/api/src/modules/maintenance/service.test.ts`
- Modify: `services/api/src/context.ts`
- Modify: `services/api/src/app.test.ts`

**Interfaces:**

```ts
export type AppContext = {
  config: ApiConfig
  visitors: VisitorService
  rooms: RoomService
  roomAccess: RoomAccessService
  rateLimits: RateLimitService
  turn: TurnService
  maintenance: MaintenanceService
  roomBootstrap: RoomBootstrapService
  clientIp: ClientIpResolver
}
```

- [ ] **Step 1: Add failing maintenance-order tests**

Assert that admission cleanup runs in this order:

```text
rooms.cleanupExpiredState
roomAccess.cleanupExpiredState
for each expired visitor: rooms.removeVisitor, roomAccess.removeVisitor, visitors.remove
rateLimits.sweep
publish the collected room/visitor events
```

Also test timer sweeps, stable visitor ordering, request cleanup after a room closes, and a throwing access subscriber not breaking maintenance. `RoomAccessService` publishes its own non-secret request transitions exactly once; maintenance must not republish them through `MaintenanceEvent`.

- [ ] **Step 2: Run the focused test**

```bash
bun run --cwd services/api test src/modules/maintenance/service.test.ts
```

- [ ] **Step 3: Invoke access cleanup without duplicating notifications**

Inject the narrow `cleanupExpiredState`/`removeVisitor` access-service interface. Call it after room cleanup and before visitor deletion, but discard its returned transition list because the access service has already delivered it through `safePublish`. Keep `MaintenanceEvent` unchanged and do not let maintenance know request internals.

- [ ] **Step 4: Wire the default dependency graph**

Create dependencies in one direction:

```text
crypto + visitors -> rooms
rooms + visitors -> roomAccess
rooms + roomAccess + visitors + rateLimits -> maintenance
maintenance + rooms + roomAccess + visitors + rateLimits + turn -> roomBootstrap
```

Instantiate `createNodeRoomInviteCrypto()` once, pass it to `createRoomService`, add `roomAccess` to `AppContext`, and update manual test contexts to include the new narrow dependency. There must be no `RoomService -> RoomAccessService` import.

- [ ] **Step 5: Run and commit**

```bash
bun run --cwd services/api test src/modules/maintenance/service.test.ts src/app.test.ts
bun run --cwd services/api typecheck
git diff --check
git add services/api/src/modules/maintenance services/api/src/context.ts services/api/src/app.test.ts
git commit -m "feat(api): maintain room access request lifecycle"
```

---

### Task 7: Replace Public Room Lookup with Authorized HTTP Routes

**Files:**

- Modify: `services/api/src/modules/room/routes.ts`
- Create: `services/api/src/modules/room-access/routes.ts`
- Modify: `services/api/src/app.ts`
- Modify: `services/api/src/app.test.ts`
- Modify: `services/api/README.md`

**HTTP surface:**

```text
POST /v1/rooms
POST /v1/rooms/:code/join
POST /v1/rooms/:code/join-requests
GET  /v1/rooms/:code/join-requests/:requestId
POST /v1/rooms/:code/join-requests/:requestId/decision
POST /v1/rooms/:code/join-requests/:requestId/finalize
POST /v1/rooms/:code/join-requests/:requestId/cancel
```

- [ ] **Step 1: Write failing route contract/security tests**

Test exact requests, responses, and status codes through `createApp()`:

- create returns an owner bootstrap with an invitation and always `Cache-Control: no-store`;
- join accepts exactly `{ iceMode, admission: { kind: 'invite', inviteToken } }` or `{ iceMode, admission: { kind: 'recovery' } }` and never accepts `role`, `approval`, mixed fields, missing fields, or extra fields;
- every room path parameter matches ASCII `^[0-9]{6}$`, and every request ID has length 1–96; reject alphabetic/short/long/Unicode-digit room codes plus empty/overlong request IDs at schema validation;
- malformed invite strings that are structurally strings reach the service and map to uniform `ROOM_ACCESS_DENIED` 404; malformed union shapes remain 422 schema errors;
- a new manual creation returns a 202 pending receipt; an idempotent replay while the room/visitor index is retained also returns 202 with the same request ID and authoritative current receipt, including an approved or terminal state that won a response-loss race;
- status/decision/cancel return 200 authoritative receipts, including terminal tombstones;
- finalize maps pending to 409, rejected to 403, cancelled/expired to 410, capacity/TURN unavailable to 503, and rate limiting to 429 with `Retry-After`;
- outsiders receive `ROOM_JOIN_REQUEST_NOT_FOUND` 404 without leaking request/room state;
- missing/expired/closed/offline/full manual rooms all return `ROOM_REQUEST_UNAVAILABLE` 404;
- `GET /v1/rooms/:code` is 404 and no route exposes a public room snapshot;
- successful, service-error, authentication-error, rate-limit, and 422 validation responses all have `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

- [ ] **Step 2: Run the route tests and confirm current failures**

```bash
bun run --cwd services/api test src/app.test.ts
```

- [ ] **Step 3: Add a shared route policy hook**

Use a plugin or `.onRequest` on the `/v1/rooms` group so headers are set before Elysia body validation:

```ts
set.headers['cache-control'] = 'no-store'
set.headers['referrer-policy'] = 'no-referrer'
```

Keep bearer parsing and client-IP resolution shared. Never log headers, URL query values, request bodies, SDP/ICE, invite tokens, or transferred metadata.

- [ ] **Step 4: Implement exact schemas and error mapping**

Define `code` as a six-character string with pattern `^[0-9]{6}$`, `requestId` with `minLength: 1` and `maxLength: 96`, and `inviteToken` with `minLength: 1` and `maxLength: 128` at the HTTP schema. Use exact-object Elysia schemas (`additionalProperties: false`) and a discriminated union for admission. Delete the public GET handler and its response helper. The join handler no longer reads or defaults a participant role.

Map service errors through one exhaustive function and set `Retry-After` only for `RATE_LIMITED`. Do not translate invitation failures back to `ROOM_NOT_FOUND` or `ROOM_EXPIRED`.

- [ ] **Step 5: Document only the supported flow**

Update the service README examples to use invitation join or manual request/decision/finalize. Remove examples that imply a code alone or a caller-selected sender role can join.

- [ ] **Step 6: Run and commit**

```bash
bun run --cwd services/api test src/app.test.ts src/modules/room/bootstrap.test.ts
bun run --cwd services/api typecheck
bun run --cwd services/api lint
git diff --check
git add services/api/src/app.ts services/api/src/app.test.ts services/api/src/modules/room/routes.ts services/api/src/modules/room-access/routes.ts services/api/README.md
git commit -m "feat(api): expose authorized room access routes"
```

---

### Task 8: Deliver Sender-Only Access Notifications over Realtime

**Files:**

- Modify: `services/api/src/modules/realtime/model.ts`
- Modify: `services/api/src/modules/realtime/hub.ts`
- Modify: `services/api/src/modules/realtime/hub.test.ts`

**Realtime rules:**

- sender attach sends one complete, stably sorted `room:join-requests` snapshot, including an empty array;
- new request sends `room:join-requested` only to the current attached sender for that room;
- decision, rejection, cancel, expiry, and finalize send `room:join-request-resolved` only to that sender;
- receivers, unattached sockets, sockets attached to another room, and replaced sender sockets receive none of these messages;
- invitation tokens and receiver bearer tokens never appear in any frame.

- [ ] **Step 1: Write failing hub tests**

Extend hub fixtures with the access-service `listPendingForSender` and `subscribe` boundary. Cover initial empty/non-empty snapshots, stable order, incremental events, reconnect convergence, socket replacement, receiver isolation, subscriber events after disconnect, and a socket `send()` throw.

Also update authorization tests so signaling uses `getInternalRoomSnapshot()` and remains restricted to already admitted online participants.

- [ ] **Step 2: Run the hub test**

```bash
bun run --cwd services/api test src/modules/realtime/hub.test.ts
```

- [ ] **Step 3: Subscribe and target current sender attachment**

At hub construction, subscribe once to access transitions. Resolve the current connection by `senderId`, verify that connection is attached to the transition's room, and use `safeSend`. Do not retain a socket reference inside `RoomAccessService`.

After a successful sender `room:attach`, call `listPendingForSender(roomCode, connection.visitorToken)` and send the complete snapshot. A failed snapshot lookup must not detach a valid room membership; send a generic error only if the failure is actionable to the authenticated sender.

- [ ] **Step 4: Run and commit**

```bash
bun run --cwd services/api test src/modules/realtime/hub.test.ts src/app.test.ts
bun run --cwd services/api typecheck
bun run --cwd services/api lint
git diff --check
git add services/api/src/modules/realtime
git commit -m "feat(api): notify senders of room access requests"
```

---

### Task 9: Consume Invitation Fragments and Align Tab-Scoped Recovery

**Files:**

- Modify: `apps/web/index.html`
- Modify: `apps/web/src/features/room/room-invite.ts`
- Modify: `apps/web/src/features/room/room-invite.test.ts`
- Create: `apps/web/src/features/room/room-navigation.ts`
- Create: `apps/web/src/features/room/room-navigation.test.ts`
- Create: `apps/web/src/lib/tab-session.ts`
- Create: `apps/web/src/lib/tab-session.test.ts`
- Modify: `apps/web/src/lib/visitor-session.ts`
- Modify: `apps/web/src/lib/visitor-session.test.ts`
- Modify: `apps/web/src/lib/room-session.ts`
- Modify: `apps/web/src/lib/room-session.test.ts`

**Interfaces:**

```ts
export type JoinIntent =
  | { kind: 'invite'; roomCode: string; inviteToken: string }
  | { kind: 'recovery'; roomCode: string }
  | { kind: 'manualRequest'; roomCode: string }

export type RoomInviteFragmentResult =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'invite'; intent: Extract<JoinIntent, { kind: 'invite' }> }

export const parseRoomInviteFragment: (hash: string) => RoomInviteFragmentResult
export const parseLegacyRoomCode: (search: string) => string | undefined
export const buildRoomInviteUrl: (currentHref: string, roomCode: string, inviteToken: string) => string
export type RoomNavigationSnapshot = {
  fragment: RoomInviteFragmentResult
  legacyRoomCode?: string
}
export const consumeRoomNavigation: (target: Pick<Window, 'location' | 'history'>) => RoomNavigationSnapshot
export const getTabStorageKey: (baseKey: string, targetWindow?: Pick<Window, 'name'>) => string
```

- [ ] **Step 1: Write failing fragment tests**

Test absent, valid, unknown key, duplicate key, duplicate room, empty/encoded-invalid/short/long token, Unicode digits, and a fragment containing only one field. `buildRoomInviteUrl` must preserve origin, pathname, and current query while replacing the fragment. Legacy `?room=` returns only a manual code and never an invitation. `consumeRoomNavigation` parses once, clears every non-absent fragment with `history.replaceState` while preserving pathname/query/history state, and returns an immutable snapshot suitable for passing through React StrictMode remounts.

- [ ] **Step 2: Write failing storage migration tests**

Require visitor and room keys to share the same `p2p-transmission:` tab suffix, survive same-tab refresh, isolate different `window.name` values, and use `sessionStorage`. Use the versioned key `p2p.roomSession:v2:<tab-name>`. Every load/clear deletes legacy `localStorage['p2p.roomSession']`; it never migrates that value.

The room guard must require exact keys and reject an object containing `inviteToken`, `requestId`, `token`, or any other extra property.

- [ ] **Step 3: Run focused tests**

```bash
bun run --cwd apps/web test src/features/room/room-invite.test.ts src/features/room/room-navigation.test.ts src/lib/tab-session.test.ts src/lib/visitor-session.test.ts src/lib/room-session.test.ts
```

- [ ] **Step 4: Implement pure parsing and shared tab keying**

The fragment parser accepts exactly one `room` and one `invite`; it does not mutate history. The entry-facing `consumeRoomNavigation` owns the one-time history mutation and returns the parsed snapshot. Refactor existing visitor storage to call `getTabStorageKey`, preserving its public test-injection API. Keep room session shape exactly:

```ts
type RoomSession = {
  roomCode: string
  role: 'receiver'
  expiresAt: number
}
```

Add `<meta name="referrer" content="no-referrer" />` to the document head.

- [ ] **Step 5: Run and commit**

```bash
bun run --cwd apps/web test src/features/room/room-invite.test.ts src/features/room/room-navigation.test.ts src/lib/tab-session.test.ts src/lib/visitor-session.test.ts src/lib/room-session.test.ts
bun run --cwd apps/web typecheck
git diff --check
git add apps/web/index.html apps/web/src/features/room/room-invite.ts apps/web/src/features/room/room-invite.test.ts apps/web/src/features/room/room-navigation.ts apps/web/src/features/room/room-navigation.test.ts apps/web/src/lib/tab-session.ts apps/web/src/lib/tab-session.test.ts apps/web/src/lib/visitor-session.ts apps/web/src/lib/visitor-session.test.ts apps/web/src/lib/room-session.ts apps/web/src/lib/room-session.test.ts
git commit -m "fix(web): secure invitation and tab recovery state"
```

---

### Task 10: Add the Authorized Web API Client and Error Policy

**Files:**

- Modify: `apps/web/src/lib/api-client.ts`
- Modify: `apps/web/src/lib/api-client.test.ts`
- Create: `apps/web/src/features/room/join-errors.ts`
- Create: `apps/web/src/features/room/join-errors.test.ts`
- Modify: `apps/web/src/shared/contracts.ts`

**Interfaces:**

```ts
export type JoinRoomInput = {
  roomCode: string
  visitorToken: string
  iceMode: RoomIceMode
  admission: ReceiverJoinBody['admission']
}

export const joinRoom: (input: JoinRoomInput, options?: ApiClientOptions) => Promise<RoomSessionBootstrap>
export const createRoomJoinRequest: (input: { roomCode: string; visitorToken: string }, options?: ApiClientOptions) => Promise<RoomJoinRequestReceipt>
export const getRoomJoinRequest: (input: { roomCode: string; requestId: string; visitorToken: string }, options?: ApiClientOptions) => Promise<RoomJoinRequestReceipt>
export const decideRoomJoinRequest: (input: { roomCode: string; requestId: string; visitorToken: string; decision: 'approve' | 'reject' }, options?: ApiClientOptions) => Promise<RoomJoinRequestReceipt>
export const finalizeRoomJoinRequest: (input: { roomCode: string; requestId: string; visitorToken: string; iceMode: RoomIceMode }, options?: ApiClientOptions) => Promise<RoomSessionBootstrap>
export const cancelRoomJoinRequest: (input: { roomCode: string; requestId: string; visitorToken: string }, options?: ApiClientOptions) => Promise<RoomJoinRequestReceipt>
```

- [ ] **Step 1: Write failing HTTP client tests**

Assert exact method, URL, bearer header, and JSON body for every function. In particular:

- `createRoom()` validates and returns `RoomOwnerBootstrap`;
- `joinRoom()` sends no `role` and preserves only the selected admission branch;
- request creation/cancel send no JSON body;
- decision sends only `decision`; finalize sends only `iceMode`;
- all success payloads pass runtime guards and malformed/extra-key payloads throw `INVALID_API_RESPONSE`;
- `getRoom()` is removed and no Web call fetches the public room endpoint.

- [ ] **Step 2: Write the error-policy table first**

```ts
export type JoinErrorContext =
  | 'invite'
  | 'recovery'
  | 'manualRequest'
  | 'requestStatus'
  | 'finalize'
  | 'cancel'
  | 'decision'

export type JoinFailure = {
  code: string
  message: string
  retryable: boolean
  clearRecovery: boolean
  attemptStrictRecovery: boolean
}

export const mapJoinError: (error: unknown, context: JoinErrorContext) => JoinFailure
```

Cover these decisions:

- `ROOM_ACCESS_DENIED`: deterministic, not retryable, clear invite/recovery;
- `ROOM_REQUEST_UNAVAILABLE`: deterministic, not retryable, keep the manually entered code;
- rejected/cancelled/expired and `CAPACITY_EXCEEDED`: deterministic;
- `RATE_LIMITED`: retryable and preserve current intent/receipt;
- network, 5xx, and `UNKNOWN_API_ERROR`: retryable and preserve recovery/request state;
- recovery `VISITOR_NOT_FOUND`: deterministic and must not trigger fresh identity minting;
- invite `VISITOR_NOT_FOUND`: eligible for exactly one App-level fresh-identity retry while the invitation remains in memory.
- finalize `ROOM_JOIN_REQUEST_NOT_FOUND`: set `attemptStrictRecovery: true` only because the App is already in its bound approved/finalize stage; all other contexts keep that flag false. The fallback reuses the same visitor and can never mint a new identity.

- [ ] **Step 3: Run focused tests**

```bash
bun run --cwd apps/web test src/lib/api-client.test.ts src/features/room/join-errors.test.ts
```

- [ ] **Step 4: Implement object-argument clients and validators**

Use `encodeURIComponent` for room/request path segments, the existing `request()` error parser, and contract guards for every security-sensitive response. Remove `ParticipantRole` and `PublicRoom` from this module. Re-export the new contract types through `apps/web/src/shared/contracts.ts` without defining parallel shapes.

- [ ] **Step 5: Run and commit**

```bash
bun run --cwd apps/web test src/lib/api-client.test.ts src/features/room/join-errors.test.ts
bun run --cwd apps/web typecheck
git diff --check
git add apps/web/src/lib/api-client.ts apps/web/src/lib/api-client.test.ts apps/web/src/features/room/join-errors.ts apps/web/src/features/room/join-errors.test.ts apps/web/src/shared/contracts.ts
git commit -m "feat(web): add authorized room access client"
```

---

### Task 11: Model Receiver Waiting, Polling, and Sender Request Queues

**Files:**

- Create: `apps/web/src/features/room/join-state.ts`
- Create: `apps/web/src/features/room/join-state.test.ts`
- Create: `apps/web/src/features/room/join-request-poller.ts`
- Create: `apps/web/src/features/room/join-request-poller.test.ts`
- Create: `apps/web/src/features/room/room-access-state.ts`
- Create: `apps/web/src/features/room/room-access-state.test.ts`

**Interfaces:**

```ts
export type JoinStatus =
  | { kind: 'idle' }
  | { kind: 'joining'; source: 'invite' | 'recovery' }
  | { kind: 'requestingApproval'; roomCode: string }
  | { kind: 'awaitingApproval'; roomCode: string; requestId: string; expiresAt: number }
  | { kind: 'error'; roomCode?: string; code: string; message: string; retryable: boolean }

export type JoinFlowState = {
  status: JoinStatus
  receipt?: RoomJoinRequestReceipt
}

export const initialJoinFlowState: JoinFlowState
export const joinFlowReducer: (state: JoinFlowState, action: JoinFlowAction) => JoinFlowState

export type JoinRequestPoller = { start(): void; stop(): void }
export const createJoinRequestPoller: (options: {
  read(): Promise<RoomJoinRequestReceipt>
  onReceipt(receipt: RoomJoinRequestReceipt): void
  onError(error: unknown): void
  intervalMs?: number
  schedule?: typeof setTimeout
  cancelSchedule?: typeof clearTimeout
}) => JoinRequestPoller

export type RoomAccessState = {
  requests: readonly RoomJoinRequestSummary[]
  decision?: { requestId: string; decision: 'approve' | 'reject' }
}
```

- [ ] **Step 1: Write receiver reducer tests**

Cover `join:start`, `manual:requesting`, `manual:awaiting`, `manual:receipt`, `join:error`, and `join:reset`. Approved receipt and finalize network failure must retain the authoritative request ID for retry. Terminal/reset/success must clear it. Keep invite tokens and visitor bearer tokens outside this reducer.

- [ ] **Step 2: Write fake-timer poller tests**

Prove the default first read is immediate, subsequent pending reads wait two seconds, recursive `setTimeout` prevents overlap, terminal receipts stop, error stops, `stop()` is idempotent, and a late promise resolution after stop invokes no callback.

- [ ] **Step 3: Write sender queue reducer tests**

Implement/test `snapshot`, `requested`, `resolved`, `decision:start`, `decision:finish`, and `reset`. Snapshot replacement and upsert order are stable by `createdAt`, then `requestId`; duplicate events do not duplicate dialogs; resolving one ID leaves the others; an HTTP failure clears only busy state.

- [ ] **Step 4: Run missing-module tests**

```bash
bun run --cwd apps/web test src/features/room/join-state.test.ts src/features/room/join-request-poller.test.ts src/features/room/room-access-state.test.ts
```

- [ ] **Step 5: Implement pure state and lifecycle helpers**

Reducers must be deterministic and side-effect free. The poller uses recursive scheduling only after a pending read resolves. Guard callbacks with a monotonically increasing generation so a stopped/restarted poller cannot apply stale results.

- [ ] **Step 6: Run and commit**

```bash
bun run --cwd apps/web test src/features/room/join-state.test.ts src/features/room/join-request-poller.test.ts src/features/room/room-access-state.test.ts
bun run --cwd apps/web typecheck
git diff --check
git add apps/web/src/features/room/join-state.ts apps/web/src/features/room/join-state.test.ts apps/web/src/features/room/join-request-poller.ts apps/web/src/features/room/join-request-poller.test.ts apps/web/src/features/room/room-access-state.ts apps/web/src/features/room/room-access-state.test.ts
git commit -m "feat(web): model receiver and sender admission state"
```

---

### Task 12: Build the Approval UI in the Existing Visual System

**Files:**

- Modify: `apps/web/src/components/RoomJoin.tsx`
- Modify: `apps/web/src/components/RoomJoin.test.tsx`
- Create: `apps/web/src/components/ManualJoinWaiting.tsx`
- Create: `apps/web/src/components/ManualJoinWaiting.test.tsx`
- Create: `apps/web/src/components/SenderJoinRequestDialog.tsx`
- Create: `apps/web/src/components/SenderJoinRequestDialog.test.tsx`
- Modify: `apps/web/src/components/ShareDialog.tsx`
- Modify: `apps/web/src/components/ShareDialog.test.tsx`

**Component contracts:**

```ts
type RoomJoinProps = {
  busy?: boolean
  initialCode?: string
  mode: 'invite' | 'manual'
  error?: string
  onCreateRoom(): void
  onSubmit(code: string): void
  onCodeEdited(): void
}

type ManualJoinWaitingProps = {
  visitor: PublicVisitor
  roomCode: string
  expiresAt: number
  busy?: boolean
  error?: string
  onCancel(): void
  onChangeRoom(): void
  onRetry?(): void
}

type SenderJoinRequestDialogProps = {
  request: RoomJoinRequestSummary
  remainingCount: number
  pendingDecision?: 'approve' | 'reject'
  onApprove(requestId: string): void
  onReject(requestId: string): void
}
```

- [ ] **Step 1: Write failing RoomJoin behavior tests**

Invitation mode shows “已读取邀请链接，确认后加入房间” and “加入房间”; manual mode shows “请求加入”. Typing, deleting, or pasting any code change calls `onCodeEdited()` so App can destroy the invitation. Busy copy distinguishes “连接中…” from “申请中…”. Errors render beside the input with `role="alert"`.

- [ ] **Step 2: Write waiting-view tests**

Render the existing `Avatar`, visitor name, room code, authoritative countdown, “等待发送者确认”, “取消申请”, and “更换房间”. A retryable error preserves the view and adds “重试”. Disable actions while cancel/change is pending. “更换房间” is only a requested action; App leaves the view only after cancellation succeeds.

- [ ] **Step 3: Write sender-dialog tests**

Show visitor avatar/name and room code. “允许加入” is the larger primary button; “拒绝” is the smaller secondary/ghost button. Both are at least 44px high, both disable during either decision, and `remainingCount > 0` displays “还有 n 个申请”. The queue is not discarded by backdrop/Escape; every visible request requires an explicit decision.

- [ ] **Step 4: Write secure sharing tests**

Keep `roomUrl` as the sole URL input. QR, clipboard, and native share must receive the exact same fragment URL. Render:

```text
扫描二维码或打开房间链接加入；房间码仅用于核对。
此链接包含加入权限，请只发送给可信接收者。
```

Do not render a separate invite token. Preserve room-code copy as a secondary verification action.

- [ ] **Step 5: Implement with existing Dark Workshop tokens**

Reuse `Avatar`, dialog primitives, current radii/colors/type scale, and motion-safe transitions. Do not introduce a new component library or generic gradient. Maintain responsive stacking and 44×44 touch targets. Keep the approval primary visually larger than reject, matching the established receiver accept/reject hierarchy.

- [ ] **Step 6: Run and commit**

```bash
bun run --cwd apps/web test src/components/RoomJoin.test.tsx src/components/ManualJoinWaiting.test.tsx src/components/SenderJoinRequestDialog.test.tsx src/components/ShareDialog.test.tsx
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
git diff --check
git add apps/web/src/components/RoomJoin.tsx apps/web/src/components/RoomJoin.test.tsx apps/web/src/components/ManualJoinWaiting.tsx apps/web/src/components/ManualJoinWaiting.test.tsx apps/web/src/components/SenderJoinRequestDialog.tsx apps/web/src/components/SenderJoinRequestDialog.test.tsx apps/web/src/components/ShareDialog.tsx apps/web/src/components/ShareDialog.test.tsx
git commit -m "feat(web): add room admission decision views"
```

---

### Task 13: Integrate Direct Invitation, Secure Sharing, and Strict Recovery

**Files:**

- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Add failing startup and invitation tests**

Cover all of these observable cases:

- a valid fragment is parsed once, cleared with `history.replaceState` while path/query/history state survive, pre-fills invite mode, and never auto-joins;
- rendering the same entry snapshot through React `StrictMode` remounts preserves the valid invitation instead of reparsing the now-cleared URL as absent;
- a malformed fragment is also cleared, displays “邀请链接无效或已过期”, and suppresses old-room recovery;
- valid/malformed fragments take priority over a stored room; legacy `?room=` only pre-fills manual mode;
- editing the prefilled invite code destroys the in-memory token and the next submit creates a manual request rather than direct join;
- direct join sends the exact invite admission body and may mint/retry a fresh visitor only once for `VISITOR_NOT_FOUND`;
- invitation/recovery network errors retain their authorized retry context, while deterministic denial clears invalid recovery;
- same-tab recovery uses `{ kind: 'recovery' }`; a visitor minted during this boot clears stale room recovery instead of claiming it; recovery `VISITOR_NOT_FOUND` never mints another identity;
- sender create retains owner invite only in memory, receiver never sees share, and sender share preserves deployment base path/query;
- leaving, expiry, membership loss, role reset, and unmount clear owner invite/share state; browser storage and rendered text never contain the invite token.

- [ ] **Step 2: Run App tests and confirm current behavior fails**

```bash
bun run --cwd apps/web test src/App.test.tsx
```

- [ ] **Step 3: Capture navigation intent once outside React StrictMode**

Call `consumeRoomNavigation(window)` at module scope in `main.tsx`, before `createRoot().render()`, and pass that immutable snapshot into `<App initialNavigation={initialNavigation} />`. `App` must never re-read `window.location.hash`. This keeps the invitation alive across StrictMode's development remount while still removing it from the address bar immediately.

`consumeRoomNavigation` uses this replacement for any non-absent fragment:

```ts
window.history.replaceState(
  window.history.state,
  '',
  `${window.location.pathname}${window.location.search}`,
)
```

Store a valid token from the passed snapshot only in an App ref or local React memory dedicated to the active intent—not the general room reducer, toast, URL, or storage. Invalid and valid fragment presence sets a recovery-suppression flag. Tests may pass an explicit absent snapshot; the production default must come from `main.tsx`, not an App initializer.

- [ ] **Step 4: Separate direct invite from recovery identity policy**

Track whether boot loaded an existing visitor session. Recovery requires both a loaded visitor and a valid same-tab room session and calls `joinRoom({ admission: { kind: 'recovery' } })` directly, bypassing `runWithFreshSession`. Direct invite creates one fresh receiver visitor for the intent; on `VISITOR_NOT_FOUND`, create at most one replacement and retry the same invite once.

On successful receiver membership, validate the bootstrap, connect realtime, then store only `{ roomCode, role: 'receiver', expiresAt }`.

- [ ] **Step 5: Retain owner invitation after room-resource reset**

Because `connectRealtime()` starts by disposing previous room resources, set the `RoomInviteCapability` after that reset has completed, or narrow cleanup so a newly issued capability is not erased. The share button renders only when `state.role === 'sender'` and the current owner capability matches the current room/expiry. Build the URL through `buildRoomInviteUrl` only when the dialog opens.

- [ ] **Step 6: Run and commit**

```bash
bun run --cwd apps/web test src/App.test.tsx src/features/room/room-invite.test.ts src/lib/room-session.test.ts src/components/ShareDialog.test.tsx
bun run --cwd apps/web typecheck
git diff --check
git add apps/web/src/main.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): integrate secure invitation admission"
```

---

### Task 14: Integrate Manual Approval, Finalize Recovery, and Sender Queue

**Files:**

- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Add failing receiver manual-flow tests**

Test this complete sequence with fake timers and deferred promises:

```text
manual submit -> mint one fresh visitor -> POST request
-> pending waiting view -> non-overlapping 2s status reads
-> approved -> finalize -> connect realtime -> save minimal room recovery
```

Also cover:

- a lost 202 response and retry reuse the same visitor, allowing server idempotency to return the same request; if sender approval won the race, the 202 replay carries the same already-approved receipt and proceeds directly to finalize without creating a second request;
- rejected/expired/cancelled stop polling and return to the form with the room code retained;
- finalized status after a lost finalize response uses recovery admission;
- a finalize retry that gets `ROOM_JOIN_REQUEST_NOT_FOUND` after finalized tombstone cleanup attempts strict recovery exactly once with the same visitor; recovery denial ends deterministically and recovery network failure remains retryable;
- finalize network failure retains receipt and shows retry;
- cancel and change-room use the bound visitor; change-room resets only after cancel success;
- a cancel failure leaves the waiting request visible;
- new intent, room success, leave, unmount, and generation invalidation stop the poller;
- neither request ID nor bearer enters room storage.

- [ ] **Step 2: Add failing sender realtime/decision tests**

Feed `room:join-requests`, duplicate `room:join-requested`, and targeted `room:join-request-resolved` through the current realtime subscriber. Verify stable queue order, automatic next-dialog display, exact approve/reject request ID, disabled buttons during a decision, failure retaining the request, reconnect snapshot replacement, receiver ignoring sender-only messages, and no secret text in fixtures/DOM.

- [ ] **Step 3: Run App tests and confirm failures**

```bash
bun run --cwd apps/web test src/App.test.tsx src/features/room/join-request-poller.test.ts src/features/room/room-access-state.test.ts
```

- [ ] **Step 4: Integrate receiver request orchestration**

Keep one `manualJoinSessionRef` fixed for the current intent. A retry of request creation reuses it; a new room intent replaces it only after cancellation/reset. Apply the authoritative 202 receipt before branching: start one poller only for pending, finalize approved immediately, and treat retained terminal receipts exactly like polled terminal receipts. Apply every later server receipt to the reducer before branching on state. Finalized calls strict recovery. Preserve the receipt when retryable errors occur.

When a client already in the approved/finalize stage receives `ROOM_JOIN_REQUEST_NOT_FOUND`, consume `attemptStrictRecovery` and call invite-free `{ kind: 'recovery' }` once with that same visitor. This is response-loss recovery, not a general 404 fallback, and must never call `createVisitor()`.

Cancellation and change-room share one function with an explicit post-cancel action. Increment the existing operation generation and stop the poller before replacing an intent, entering a room, or disposing the App.

- [ ] **Step 5: Integrate sender access events before generic realtime errors**

In `client.subscribe`, handle the three access message variants before any branch that assumes `message.code`. Only a sender dispatches queue actions. The visible dialog always uses sorted `requests[0]`. On decision success, apply the authoritative receipt/removal; a later resolved realtime replay remains idempotent. On network failure, finish busy state without removing the request.

Reset the access queue whenever room resources are disposed or role changes. Do not broaden the existing one-current-socket behavior.

- [ ] **Step 6: Run and commit**

```bash
bun run --cwd apps/web test src/App.test.tsx src/features/room/join-state.test.ts src/features/room/join-request-poller.test.ts src/features/room/room-access-state.test.ts src/components/ManualJoinWaiting.test.tsx src/components/SenderJoinRequestDialog.test.tsx
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
git diff --check
git add apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): complete sender-approved room joining"
```

---

### Task 15: Prove the Security Boundary and Release Quality

**Files:**

- Modify: `README.md`
- Modify: `apps/web/README.md`
- Modify: `services/api/README.md` if final command/output examples changed after integration
- Modify: `.github/workflows/ci.yml` only if the existing workflow omits a workspace already covered by `bun run verify`

- [ ] **Step 1: Add final cross-layer integration cases**

Before changing docs, make sure the suites contain explicit tests for:

- wrong/cross-room/malformed invites are externally indistinguishable and never allocate membership/TURN;
- manual unavailable states are externally indistinguishable;
- pending and approved requests cannot WebSocket attach or signal;
- only one finalize/cancel/expiry race wins and no partial membership remains;
- lost 202 and lost finalize responses recover idempotently;
- a lost 202 replay racing an approval returns the same approved receipt, and a lost finalize response remains recoverable after finalized tombstone cleanup;
- sender reconnect receives a canonical request snapshot;
- owner bootstrap enforces invite/room expiry equality, the exact join-body and realtime-access runtime guards reject mixed/extra/secret fields, and route params reject non-ASCII room codes plus empty/overlong request IDs;
- invite tokens are absent from PublicRoom, realtime serialization, storage mocks, rendered DOM, URL after startup, and error messages;
- all room/access 2xx/4xx/5xx/422 responses are no-store;
- direct invitation and manual approval both work with ICE off and API TURN modes.

- [ ] **Step 2: Update product documentation**

Describe only the two supported receiver paths:

1. open a sender invitation link and click “加入房间”;
2. enter a six-digit code, click “请求加入”, wait for sender approval, then finalize automatically.

Explain that the room code is for identification/checking, the invitation link contains join authority, receiver recovery is same-tab only, manual requests expire, and links should be shared only with trusted recipients. Remove any claim that code-only direct join or sender recovery is supported.

Document the deployment as a hard protocol cut: restart the in-memory API to invalidate legacy rooms, deploy API/Web contracts together, and do not ship a dual-mode fallback for the old code-only join body.

- [ ] **Step 3: Run focused workspace suites**

```bash
bun run --cwd packages/contracts test
bun run --cwd services/api test
bun run --cwd apps/web test
bun run --cwd packages/contracts typecheck
bun run --cwd services/api typecheck
bun run --cwd apps/web typecheck
```

Expected: all contract, API, and Web tests pass with zero type errors.

- [ ] **Step 4: Run release verification without cache**

```bash
bun install --frozen-lockfile
bun run verify
bunx turbo run lint test typecheck build --force
```

Expected: every workspace lint/test/typecheck/build task succeeds; the Vite production build contains no TypeScript or bundling error.

- [ ] **Step 5: Audit secrets and removed compatibility paths**

```bash
rg -n "getRoom\(|GET /v1/rooms/:code|role.*receiver|inviteToken|p2p\.roomSession" apps packages services README.md
git diff --check
git status --short
```

Review every `inviteToken` match manually: it may exist only in contract/schema, crypto/service validation, Web in-memory parsing/submission, and tests. There must be no logging, public snapshot, realtime payload, persistent storage, toast, or rendered standalone token. Confirm old room lookup and role-selectable join code is gone.

- [ ] **Step 6: Commit the release documentation**

```bash
git add README.md apps/web/README.md services/api/README.md .github/workflows/ci.yml
git diff --cached --check
git commit -m "docs: document secure room admission"
git status --short --branch
```

Expected: clean working tree on the implementation branch, all verification green, and commits remain separated by contract, backend core, backend API/realtime, Web foundation, UI, App integration, and documentation.
