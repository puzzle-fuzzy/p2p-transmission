# TURN Relay and Atomic Room Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add production-safe TURN relay credentials, atomic room bootstrap, resumable WebSocket membership attachment, bounded in-memory state, and room-lifetime enforcement without allowing content through the API.

**Architecture:** HTTP create/join is the only membership mutation path and atomically returns the complete ICE configuration. WebSocket room:attach only activates an existing connecting membership and supports a 15-second resume window. Small injected services own TURN signing, multi-key rate limiting, visitor/room capacity, cleanup scheduling, and runtime lifecycle; the Web resolves ICE before opening realtime.

**Tech Stack:** Bun, TypeScript, Elysia, @elysia/cors, node:crypto HMAC-SHA1, React/Vite, WebRTC ICE, coturn 4.14.0-r0, Docker Compose.

## Global Constraints

- Never expose TURN_SHARED_SECRET in a response, frontend bundle, log, command output, or committed generated config.
- HTTP bootstrap is the only operation that creates room membership.
- WebSocket room:attach never calls joinRoom and only makes an existing same-role member online.
- Only online attached members can send or receive signaling.
- Unexpected disconnect keeps membership connecting for 15 seconds; terminal sender removal closes the room.
- Credentials expire at room.expiresAt + 300,000 ms; expiresAt DTO values are epoch milliseconds and coturn usernames use epoch seconds.
- App closes the room at room.expiresAt and checks expiry on visibility, reconnect, and peer retry.
- Static TURN credentials are development/private only; API mode fails closed.
- CORS is defense in depth; server abuse control uses IP/visitor/room/global rate limits and capacity limits.
- In-memory state has TTL, periodic cleanup, explicit capacities, and injectable time/schedulers.
- TURN mode defaults to off. `iceTransportPolicy` is Web-owned, defaults to all, and is never accepted from or emitted by the API DTO.
- No transfer payload enters HTTP/WebSocket.

---

## File Map

### Contracts

- Create: packages/contracts/src/ice.ts
- Create: packages/contracts/src/ice.test.ts
- Modify: packages/contracts/src/model.ts
- Modify: packages/contracts/src/realtime.ts
- Modify: packages/contracts/src/index.ts

### API configuration and shared policy

- Create: services/api/src/config.ts
- Create: services/api/src/config.test.ts
- Create: services/api/src/shared/client-ip.ts
- Create: services/api/src/shared/client-ip.test.ts
- Create: services/api/src/modules/rate-limit/model.ts
- Create: services/api/src/modules/rate-limit/service.ts
- Create: services/api/src/modules/rate-limit/service.test.ts

### API TURN/bootstrap/lifecycle

- Create: services/api/src/modules/turn/model.ts
- Create: services/api/src/modules/turn/service.ts
- Create: services/api/src/modules/turn/service.test.ts
- Create: services/api/src/modules/turn/coturn-config.ts
- Create: services/api/src/modules/turn/coturn-config.test.ts
- Create: services/api/scripts/render-coturn-config.ts
- Create: services/api/src/modules/room/bootstrap.ts
- Create: services/api/src/modules/room/bootstrap.test.ts
- Create: services/api/src/modules/maintenance/model.ts
- Create: services/api/src/modules/maintenance/service.ts
- Create: services/api/src/modules/maintenance/service.test.ts
- Create: services/api/src/runtime.ts

### Existing API modules

- Modify visitor model/service/routes/tests.
- Modify room model/service/routes/tests.
- Modify realtime model/hub/routes/tests.
- Modify services/api/src/context.ts, app.ts, app.test.ts, index.ts, package.json.
- Modify bun.lock.

### Web

- Create: apps/web/src/features/room/session-lifecycle.ts
- Create: apps/web/src/features/room/session-lifecycle.test.ts
- Modify: apps/web/src/lib/config.ts and config.test.ts.
- Modify: apps/web/src/lib/api-client.ts and api-client.test.ts.
- Modify: apps/web/src/lib/realtime-client.ts and realtime-client.test.ts.
- Modify: apps/web/src/App.tsx.

### Deployment/docs

- Create: services/api/.env.example
- Create: apps/web/.env.example
- Create: deploy/coturn/compose.yml
- Create: deploy/coturn/turnserver.conf.example
- Create: deploy/coturn/README.md
- Modify: root .gitignore
- Modify: services/api/README.md and apps/web/README.md

---

### Task 1: Shared ICE Bootstrap and room:attach Contracts

**Files:**
- Create: packages/contracts/src/ice.ts
- Create: packages/contracts/src/ice.test.ts
- Modify: packages/contracts/src/model.ts
- Modify: packages/contracts/src/realtime.ts
- Modify: packages/contracts/src/index.ts

**Interfaces:**
- Produces RoomIceMode, RtcIceServerDto, RtcConfigurationDto, RoomBootstrapRequest, RoomSessionBootstrap.
- Adds room:attach alongside a temporary deprecated room:join compatibility variant; Task 10 removes room:join after Web migration.
- Adds stable error-code vocabulary used by API and Web.

- [ ] **Step 1: Write failing DTO/runtime tests**

Test pure DTO guards for allowed stun/turn/turns URLs, non-empty URL arrays, complete username/credential pairs, epoch-millisecond expiry, and a PublicRoom bootstrap. Assert the server DTO rejects an `iceTransportPolicy` key; transport policy is local Web configuration.

Also assert both room:attach and the explicitly deprecated room:join compatibility fixture satisfy ClientRealtimeMessage at this transitional task. Task 10 owns the negative type fixture after all current consumers migrate.

- [ ] **Step 2: Run and confirm red**

Run:

~~~text
bun test packages/contracts/src/ice.test.ts
bun run --cwd packages/contracts typecheck
~~~

Expected: FAIL because ice.ts and room:attach do not exist.

- [ ] **Step 3: Implement exact DTOs**

~~~ts
export type RoomIceMode = 'off' | 'api'

export type RtcIceServerDto = {
  urls: string[]
  username?: string
  credential?: string
  credentialType?: 'password'
}

export type RtcConfigurationDto = {
  iceServers: RtcIceServerDto[]
}

export type RoomBootstrapRequest = {
  iceMode: RoomIceMode
}

export type RoomSessionBootstrap = {
  room: PublicRoom
  rtcConfiguration?: RtcConfigurationDto
  credentialExpiresAt?: number
}
~~~

Use exact-key unknown guards. Require rtcConfiguration and credentialExpiresAt together for API mode response construction.

- [ ] **Step 4: Replace the realtime membership message**

~~~ts
export type ClientRealtimeMessage =
  | { type: 'room:attach'; roomCode: string; role: ParticipantRole }
  /** @deprecated Temporary migration shim; removed in Task 10. */
  | { type: 'room:join'; roomCode: string; role: ParticipantRole }
  | { type: 'room:leave'; roomCode: string }
  | SignalClientMessage
~~~

The compatibility variant does not authorize legacy membership mutation: Task 8 interprets it only as an attach alias for an already bootstrap-created member. This sequencing keeps every intermediate workspace typecheckable while HTTP, API WebSocket, and Web callers migrate.

Add ApiErrorCode literals ROOM_MEMBERSHIP_REQUIRED, TURN_NOT_CONFIGURED, RATE_LIMITED, CAPACITY_EXCEEDED, ROOM_EXPIRED, and ORIGIN_NOT_ALLOWED while preserving existing codes.

- [ ] **Step 5: Verify and commit**

Run:

~~~text
bun test packages/contracts/src/ice.test.ts
bun run --cwd packages/contracts typecheck
bun run --cwd packages/contracts lint
~~~

Expected: PASS.

~~~bash
git add packages/contracts/src
git commit -m "feat: define room ICE bootstrap contracts"
~~~

---

### Task 2: Typed Server Configuration and Trusted Client IP

**Files:**
- Create: services/api/src/config.ts
- Create: services/api/src/config.test.ts
- Create: services/api/src/shared/client-ip.ts
- Create: services/api/src/shared/client-ip.test.ts

**Interfaces:**
- Produces ApiConfig and loadApiConfig.
- Produces ClientIpResolver and createClientIpResolver.

- [ ] **Step 1: Write failing configuration tests**

Cover off mode, REST mode, STUN_URLS, turn/turns URL validation, secret minimum 32 bytes, grace exactly 300 seconds default, comma-trim/deduplicate, CORS origins, TRUST_PROXY default false, and TRUSTED_PROXY_IPS required when true.

- [ ] **Step 2: Write failing IP resolver tests**

~~~ts
const resolver = createClientIpResolver({
  trustProxy: true,
  trustedProxyIps: new Set(['10.0.0.10']),
})
~~~

Assert direct socket IP wins normally and every X-Forwarded-For value from an untrusted direct peer is ignored. For a trusted direct peer, append the socket address to the parsed X-Forwarded-For chain, walk right-to-left while addresses are in `trustedProxyIps`, and select the first untrusted valid hop as the client. Explicitly test `attacker-spoof, real-client` behind one trusted proxy and a multi-proxy chain so the spoofed leftmost value cannot win. Malformed/missing chains fall back to the direct socket IP, and no address returns stable unknown.

- [ ] **Step 3: Run and confirm red**

Run:

~~~text
bun test services/api/src/config.test.ts services/api/src/shared/client-ip.test.ts
~~~

Expected: FAIL because files do not exist.

- [ ] **Step 4: Implement config parsing**

~~~ts
export type ApiConfig = {
  port: number
  stunUrls: string[]
  turn?: {
    urls: string[]
    sharedSecret: string
    credentialGraceMs: number
  }
  corsAllowedOrigins: string[]
  trustProxy: boolean
  trustedProxyIps: Set<string>
}
~~~

Use unknown environment strings plus explicit parsing. Server REST mode fails at startup when TURN URLs/secret are partial. Off mode never requires a secret.

- [ ] **Step 5: Implement injected IP resolution**

Use node:net isIP. Never trust a forwarded chain merely because the flag is enabled: the direct peer must itself be configured as trusted, and only the right-to-left trusted suffix is stripped. The resolver consumes directAddress and headers rather than importing Elysia, so routes adapt server.requestIP(request)?.address into it and tests remain pure.

- [ ] **Step 6: Verify and commit**

Run:

~~~text
bun test services/api/src/config.test.ts services/api/src/shared/client-ip.test.ts
bun run --cwd services/api typecheck
bun run --cwd services/api lint
~~~

Expected: PASS.

~~~bash
git add services/api/src/config.ts services/api/src/config.test.ts services/api/src/shared/client-ip.ts services/api/src/shared/client-ip.test.ts
git commit -m "feat: validate API network configuration"
~~~

---

### Task 3: TURN Credential and coturn Config Services

**Files:**
- Create: services/api/src/modules/turn/model.ts
- Create: services/api/src/modules/turn/service.ts
- Create: services/api/src/modules/turn/service.test.ts
- Create: services/api/src/modules/turn/coturn-config.ts
- Create: services/api/src/modules/turn/coturn-config.test.ts

**Interfaces:**
- Consumes ApiConfig turn/STUN values.
- Produces TurnService.issue(visitorId, roomExpiresAt).
- Produces renderCoturnConfig for the deploy task.

- [ ] **Step 1: Write failing HMAC credential tests**

Use an injected clock/config. Assert username expiry equals floor((roomExpiresAt + 300_000) / 1000), credentialExpiresAt remains epoch milliseconds, response contains server STUN plus TURN servers, and secret is absent after JSON serialization.

Use this fixed vector:

~~~ts
const secret = '0123456789abcdef0123456789abcdef'
const username = '1700000000:vis_001'
const expected = '3Xg6+vw7s5E5jMWlxbdpSgQfbr0='
~~~

- [ ] **Step 2: Write failing error/config tests**

Cover off/unconfigured issue returning TURN_NOT_CONFIGURED, empty visitor ID, already-expired room, URL dedupe, credentialType password, and grace overflow.

- [ ] **Step 3: Run and confirm red**

Run: bun test services/api/src/modules/turn/service.test.ts

Expected: FAIL because service does not exist.

- [ ] **Step 4: Implement credential signing**

~~~ts
export type TurnService = {
  issue(visitorId: string, roomExpiresAt: number): TurnCredentialResult
}
~~~

Use createHmac('sha1', sharedSecret).update(username).digest('base64'). Keep service output limited to RoomSessionBootstrap ICE-server fields; it never chooses or emits `iceTransportPolicy`.

- [ ] **Step 5: Write and implement coturn config rendering tests**

The renderer must include use-auth-secret, static-auth-secret, realm, external-ip, 3478/5349 listener settings, 49160–49259 relay range, user-quota 64, total-quota 100, max-bps 12,500,000, bps-capacity 125,000,000, no-cli, no-loopback-peers, no-multicast-peers, and denied private/link-local/reserved ranges.

The render function rejects missing realm/external IP/cert paths/secret and never logs input.

- [ ] **Step 6: Verify and commit**

Run:

~~~text
bun test services/api/src/modules/turn/service.test.ts services/api/src/modules/turn/coturn-config.test.ts
bun run --cwd services/api typecheck
~~~

Expected: PASS.

~~~bash
git add services/api/src/modules/turn
git commit -m "feat: issue short-lived TURN credentials"
~~~

---

### Task 4: Atomic Multi-Key Rate Limiting

**Files:**
- Create: services/api/src/modules/rate-limit/model.ts
- Create: services/api/src/modules/rate-limit/service.ts
- Create: services/api/src/modules/rate-limit/service.test.ts

**Interfaces:**
- Produces consumeMany, sweep, size.
- Consumes injected now and maxKeys 50,000.

- [ ] **Step 1: Write failing atomicity/window tests**

~~~ts
const result = limiter.consumeMany([
  { key: 'global:turn', limit: 300, windowMs: 60_000 },
  { key: 'ip:203.0.113.1:turn', limit: 20, windowMs: 60_000 },
])
~~~

Cover all-or-nothing increments, boundary reset, retryAfterMs, per-IP/visitor/room/global keys, 50,000-key cap, existing keys still consumable at cap, unseen key rejected at cap, and sweep after window + 60 seconds.

- [ ] **Step 2: Run and confirm red**

Run: bun test services/api/src/modules/rate-limit/service.test.ts

Expected: FAIL because service does not exist.

- [ ] **Step 3: Implement two-pass consumeMany**

First normalize/deduplicate checks and verify every resulting count/cap. Only after all pass mutate buckets. Return stable RATE_LIMITED or CAPACITY_EXCEEDED with retryAfterMs.

- [ ] **Step 4: Verify and commit**

Run:

~~~text
bun test services/api/src/modules/rate-limit/service.test.ts
bun run --cwd services/api typecheck
~~~

Expected: PASS.

~~~bash
git add services/api/src/modules/rate-limit
git commit -m "feat: bound API admission rates"
~~~

---

### Task 5: Visitor TTL and Capacity

**Files:**
- Modify: services/api/src/modules/visitor/model.ts
- Modify: services/api/src/modules/visitor/service.ts
- Modify: services/api/src/modules/visitor/service.test.ts

**Interfaces:**
- Preserves `createVisitor(): Visitor` for existing internal/tests while adding capacity-aware `tryCreateVisitor(): VisitorResult` for routes.
- Adds listExpiredVisitorIds, size, remove, and two-hour idle TTL. Only Maintenance is allowed to cascade and delete expired visitors.

- [ ] **Step 1: Write failing lifecycle tests**

Cover 10,000 exact capacity, 10,001 rejection, two-hour idle expiry detection, touch extending TTL, by-token/by-id removal together, active visitor preservation, and deterministic expired visitor IDs. Assert visitor admission never self-deletes expired records: it returns CAPACITY_EXCEEDED until Maintenance performs room cascade then visitor removal.

- [ ] **Step 2: Run and confirm red**

Run: bun test services/api/src/modules/visitor/service.test.ts

Expected: FAIL because current visitors never expire/cap.

- [ ] **Step 3: Implement bounded service**

~~~ts
export type VisitorService = {
  createVisitor(): Visitor
  tryCreateVisitor(): VisitorResult
  getById(id: string): Visitor | undefined
  getByToken(token: string): Visitor | undefined
  touch(token: string): Visitor | undefined
  remove(id: string): boolean
  listExpiredVisitorIds(): string[]
  size(): number
  toPublic(visitor: Visitor): PublicVisitor
}
~~~

Both lookup maps are removed atomically by `remove`. `tryCreateVisitor` never sweeps or evicts; `createVisitor` delegates to it and throws the stable capacity error only to preserve the existing convenient success-return type. Task 7 creates the sole admission sweep/cascade, and Task 9 calls it before the production visitor route uses `tryCreateVisitor`.

- [ ] **Step 4: Verify and commit**

Run:

~~~text
bun test services/api/src/modules/visitor/service.test.ts
bun run --cwd services/api typecheck
~~~

Expected: PASS.

~~~bash
git add services/api/src/modules/visitor
git commit -m "feat: expire bounded visitor sessions"
~~~

---

### Task 6: Prepared Room Mutations and Membership Lifecycle

**Files:**
- Modify: services/api/src/modules/room/model.ts
- Modify: services/api/src/modules/room/service.ts
- Modify: services/api/src/modules/room/service.test.ts

**Interfaces:**
- Produces prepareCreate, prepareJoin, commit.
- Produces attach, markConnecting, leave, removeVisitor, cleanupExpiredState.
- Emits RoomTransition records for hub/maintenance.
- Temporarily preserves current createRoom/joinRoom wrappers through Task 7 so intermediate callers typecheck; each wrapper delegates prepare + commit and is removed after routes/hub migrate.

- [ ] **Step 1: Write failing prepare/commit tests**

Assert prepare changes no map, commit changes once, duplicate commit returns INVALID_STATE, stale revision cannot overwrite, join role is rechecked, exact 20 receivers allowed and 21 rejected, exactly 2,000 live rooms are allowed and the 2,001st prepare returns CAPACITY_EXCEEDED without mutation, and new participants start connecting with now + 15,000 attach deadline.

- [ ] **Step 2: Write failing attach/resume tests**

Cover same-role attach to online, wrong role rejection, non-member ROOM_MEMBERSHIP_REQUIRED, disconnect to connecting, attach within 15 seconds, deadline expiry, initial attach expiry, explicit leave exactly once, and socket-independent room state.

- [ ] **Step 3: Write failing sender/cleanup tests**

Any sender explicit leave, attach timeout, resume timeout, visitor expiry, or room expiry closes the room and returns transitions for all members. Receiver removal preserves the sender room. cleanup returns deterministic transitions once.

- [ ] **Step 4: Run and confirm red**

Run: bun test services/api/src/modules/room/service.test.ts

Expected: FAIL against current immediate online join/remove-on-disconnect service.

- [ ] **Step 5: Implement internal participant deadlines and revision plans**

~~~ts
type RoomMutationPlan = {
  id: string
  revision: number
  kind: 'create' | 'join'
  visitorId: string
  role: ParticipantRole
  room: PublicRoom
}
~~~

Plans are one-use and never exposed through HTTP. Public status remains connecting/online/transferring/left.

- [ ] **Step 6: Implement transition APIs**

~~~ts
attach(code: string, visitorId: string, role: ParticipantRole): RoomTransitionResult
markConnecting(visitorId: string, roomCodes: readonly string[]): RoomTransition[]
leave(code: string, visitorId: string): RoomTransitionResult
removeVisitor(visitorId: string): RoomTransition[]
cleanupExpiredState(): RoomTransition[]
~~~

- [ ] **Step 7: Verify and commit**

Run:

~~~text
bun test services/api/src/modules/room/service.test.ts
bun run --cwd services/api typecheck
~~~

Expected: PASS.

~~~bash
git add services/api/src/modules/room
git commit -m "feat: prepare resumable room membership"
~~~

---

### Task 7: Atomic Room Bootstrap Orchestration

**Files:**
- Create: services/api/src/modules/room/bootstrap.ts
- Create: services/api/src/modules/room/bootstrap.test.ts
- Create: services/api/src/modules/maintenance/model.ts
- Create: services/api/src/modules/maintenance/service.ts
- Create: services/api/src/modules/maintenance/service.test.ts
- Modify: services/api/src/modules/room/routes.ts
- Modify: services/api/src/context.ts
- Modify: services/api/src/app.test.ts

**Interfaces:**
- Consumes visitors, rooms, TURN, limits, maintenance sweep, client IP.
- Produces createRoom and joinRoom RoomSessionBootstrap results.
- Produces synchronous Maintenance sweep ownership now; Task 9 adds its periodic scheduler/runtime lifecycle.

- [ ] **Step 1: Write failing operation-order tests**

Use spies to assert:

~~~text
sweepForAdmission
→ visitor auth/touch
→ room prepare
→ consume all limits
→ TURN issue when api
→ room commit
~~~

Signing/config/rate-limit/commit failure must leave no created room or joined member. off mode commits without TURN DTO. api mode always includes both rtcConfiguration and credentialExpiresAt.

Maintenance tests assert its admission sweep performs this exclusive order: collect expired room/attach transitions, collect expired visitor IDs, call `rooms.removeVisitor(id)` for every ID, broadcast/return deterministic transitions, then call `visitors.remove(id)`, and finally sweep rate keys. Neither VisitorService nor RoomBootstrapService independently removes visitors.

- [ ] **Step 2: Write failing route tests**

POST /v1/rooms and POST /v1/rooms/:code/join accept iceMode. During this vertical migration only, an absent field maps to `off` so the still-current Web client remains functional; invalid present values still fail. Test missing→off, explicit off/api, 401/404/409/429/503, no-store on API credential responses, no secret fields, role default receiver, and returned connecting participant. Task 10 sends the field from Web and then makes it required.

- [ ] **Step 3: Run and confirm red**

Run:

~~~text
bun test services/api/src/modules/room/bootstrap.test.ts services/api/src/modules/maintenance/service.test.ts services/api/src/app.test.ts
~~~

Expected: FAIL because routes call RoomService mutations directly.

- [ ] **Step 4: Implement synchronous Maintenance and wire context**

Create the service with `sweepForAdmission`, `sweepRooms`, and `sweepVisitorsAndRateKeys`; timer methods may be no-ops until Task 9. `createDefaultContext` constructs config, visitors, rooms, limiter, TURN, maintenance, bootstrap, and client-IP resolver in dependency order. This task must leave the API typecheckable with no placeholder or optional bootstrap dependency.

- [ ] **Step 5: Implement RoomBootstrapService**

~~~ts
export type RoomBootstrapService = {
  createRoom(input: {
    visitorToken: string
    clientIp: string
    iceMode: RoomIceMode
  }): RoomBootstrapResult
  joinRoom(input: {
    code: string
    visitorToken: string
    clientIp: string
    role: ParticipantRole
    iceMode: RoomIceMode
  }): RoomBootstrapResult
}
~~~

Use these exact atomic limiter checks:

- create: 30/hour/IP and 10/hour/visitor;
- join: 60/minute/IP and 20/minute/visitor;
- when `iceMode === 'api'`, additionally 300/minute/instance, 20/minute/IP, 5/minute/visitor, and 30/minute/prepared-room-code.

Any failed consume/issue discards the plan without commit. The 10,000 visitor, 2,000 room, 20 receiver, and 50,000 rate-key capacities remain service-level checks.

- [ ] **Step 6: Route only through bootstrap**

Routes never call rooms.createRoom/joinRoom. Adapt server.requestIP(request) through the injected resolver.

- [ ] **Step 7: Verify and commit**

Run:

~~~text
bun test services/api/src/modules/room/bootstrap.test.ts services/api/src/modules/maintenance/service.test.ts services/api/src/app.test.ts
bun run --cwd services/api typecheck
~~~

Expected: PASS.

~~~bash
git add services/api/src/modules/room/bootstrap.ts services/api/src/modules/room/bootstrap.test.ts services/api/src/modules/maintenance services/api/src/modules/room/routes.ts services/api/src/context.ts services/api/src/app.test.ts
git commit -m "feat: bootstrap rooms with ICE atomically"
~~~

---

### Task 8: WebSocket Attach, Online Signaling, and Resume

**Files:**
- Modify: services/api/src/modules/realtime/model.ts
- Modify: services/api/src/modules/realtime/hub.ts
- Modify: services/api/src/modules/realtime/hub.test.ts
- Modify: services/api/src/modules/realtime/routes.ts

**Interfaces:**
- Consumes room:attach and RoomService transition methods.
- No WebSocket code creates members.

- [ ] **Step 1: Write failing attach authorization tests**

Cover no bootstrap membership, wrong role, expired attach deadline, valid attach, online status broadcast, and a source/target that is connecting being denied signaling. `sendToVisitor` must also refuse delivery when the target socket's own `connection.rooms` set does not contain the room, even if RoomService says that membership is online.

- [ ] **Step 2: Write failing reconnect/replacement tests**

Assert unexpected close marks connecting without participant:left, attach inside 15 seconds restores online, cleanup after deadline emits one left, and explicit leave is immediate. On socket replacement, capture the previous socket's attached rooms, call `markConnecting` for them and start fresh resume deadlines before closing/replacing it; the new socket begins with an empty `connection.rooms` set and cannot receive room signaling until it attaches. Assert the old replaced socket close cannot downgrade the new generation, and authenticated WebSocket activity touches visitor.lastSeenAt so an active connection is not swept as idle. At exactly 10,000 sockets, replacement by the same authenticated visitor is allowed as a net-zero swap and the old connection is closed only after the replacement is admitted.

- [ ] **Step 3: Run and confirm red**

Run: bun test services/api/src/modules/realtime/hub.test.ts

Expected: FAIL because current room:join mutates membership and disconnect removes it.

- [ ] **Step 4: Implement attach-only hub**

room:attach calls rooms.attach and adds the code to that socket only after success. During migration, deprecated room:join follows the exact same attach-only branch and can never call RoomService join/prepare/commit. `authorizeSignal` requires source and target status online, and delivery additionally requires both current socket room sets to contain the code. Connect plus every accepted attach/signal/leave message touches the visitor token. Disconnect current generation calls markConnecting; room:leave calls leave.

- [ ] **Step 5: Enforce socket capacity and origin policy**

Before socket capacity admission, call `maintenance.sweepForAdmission()` and synchronously consume its expired-visitor events so stale sockets are closed and removed. Reject the 10,001st distinct live socket with CAPACITY_EXCEEDED after that sweep; a same-visitor replacement does not increment the count. Test one stale socket freed before admission, a genuine 10,001st distinct visitor rejection, and a full-capacity replacement. WebSocket upgrade/open validates Origin against configured origins; originless connections are rejected in production configuration.

- [ ] **Step 6: Verify and commit**

Run:

~~~text
bun test services/api/src/modules/realtime/hub.test.ts
bun run --cwd services/api typecheck
bun run --cwd services/api lint
~~~

Expected: PASS.

~~~bash
git add services/api/src/modules/realtime
git commit -m "feat: attach resumable realtime members"
~~~

---

### Task 9: Maintenance, Context, CORS, and Runtime

**Files:**
- Modify: services/api/src/modules/maintenance/model.ts
- Modify: services/api/src/modules/maintenance/service.ts
- Modify: services/api/src/modules/maintenance/service.test.ts
- Create: services/api/src/runtime.ts
- Modify: services/api/src/context.ts
- Modify: services/api/src/app.ts
- Modify: services/api/src/app.test.ts
- Modify: services/api/src/index.ts
- Modify: services/api/src/modules/visitor/routes.ts
- Modify: services/api/package.json
- Modify: bun.lock

**Interfaces:**
- Maintenance emits cleanup transitions consumed by RealtimeHub.
- App construction stays timer-free for tests; runtime owns start/stop/listen.

- [ ] **Step 1: Write failing maintenance tests**

Extend the synchronous Task 7 coverage with 30-second room/attach sweep, 60-second visitor/rate-key sweep, start/stop idempotency, and no timer after stop. Reassert expired-visitor ordering: RoomService cascade and transitions complete before VisitorService removal, with no alternate visitor self-cleanup path.

- [ ] **Step 2: Run and confirm red**

Run: bun test services/api/src/modules/maintenance/service.test.ts

Expected: FAIL because service does not exist.

- [ ] **Step 3: Implement maintenance service**

~~~ts
export type MaintenanceService = {
  sweepForAdmission(): MaintenanceEvent[]
  sweepRooms(): MaintenanceEvent[]
  sweepVisitorsAndRateKeys(): MaintenanceEvent[]
  subscribe(listener: (events: MaintenanceEvent[]) => void): () => void
  start(): void
  stop(): void
}
~~~

Use injected setInterval/clearInterval. RealtimeHub subscription closes expired visitor sockets and broadcasts room transitions exactly once.

- [ ] **Step 4: Install and configure official CORS**

Working directory: services/api

Run: bun add @elysia/cors

Use:

~~~ts
cors({
  origin: config.corsAllowedOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['content-type', 'authorization'],
  credentials: false,
})
~~~

Remove wildcard manual headers.

- [ ] **Step 5: Apply visitor/admission limits in routes**

Visitor creation first calls `maintenance.sweepForAdmission()`, then consumes exactly 30/hour/IP, then calls `visitors.tryCreateVisitor()`. Room bootstrap owns the exact create/join/credential limits from Task 7. Errors use status 429 for RATE_LIMITED and 503 for CAPACITY_EXCEEDED/TURN_NOT_CONFIGURED. No route or service invokes a VisitorService cleanup/delete shortcut.

- [ ] **Step 6: Create explicit runtime lifecycle**

~~~ts
export const startRuntime = (config = loadApiConfig()) => {
  const context = createDefaultContext(config)
  const app = createApp(context, config).listen(config.port)
  context.maintenance.start()
  return {
    app,
    stop() {
      context.maintenance.stop()
      app.stop()
    },
  }
}
~~~

index.ts only starts runtime and registers shutdown cleanup. Tests import createApp without starting timers/listeners.

- [ ] **Step 7: Run all API tests and commit**

Run:

~~~text
bun test services/api/src
bun run --cwd services/api typecheck
bun run --cwd services/api lint
bun run --cwd services/api build
~~~

Expected: PASS.

~~~bash
git add services/api bun.lock
git commit -m "feat: harden signaling service lifecycle"
~~~

---

### Task 10: Web ICE Modes, Atomic Bootstrap, and Room Expiry

**Files:**
- Create: apps/web/src/features/room/session-lifecycle.ts
- Create: apps/web/src/features/room/session-lifecycle.test.ts
- Modify: apps/web/src/lib/config.ts
- Modify: apps/web/src/lib/config.test.ts
- Modify: apps/web/src/lib/api-client.ts
- Modify: apps/web/src/lib/api-client.test.ts
- Modify: apps/web/src/lib/realtime-client.ts
- Modify: apps/web/src/lib/realtime-client.test.ts
- Modify: apps/web/src/App.tsx
- Modify: packages/contracts/src/realtime.ts and contract tests to remove the migration shim after Web changes.
- Modify: services/api/src/modules/realtime/hub.ts, hub.test.ts, and routes.ts to remove the legacy alias after Web changes.

**Interfaces:**
- Web config resolves off/static/api.
- createRoom/joinRoom return RoomSessionBootstrap.
- connectRealtime receives an already resolved RTCConfiguration.
- Web overlays its local all/relay policy onto off/static/api ICE servers; the server DTO contains only iceServers.

- [ ] **Step 1: Write failing config-mode tests**

Cover:

- off uses STUN only;
- static requires TURN URLs/username/credential all together;
- partial static throws a visible configuration error;
- api requires bootstrap rtcConfiguration and expiry;
- all default and relay explicit for all three modes, including a forced-relay API bootstrap test;
- duplicate/invalid URL normalization;
- no frontend variable named TURN_SHARED_SECRET.

- [ ] **Step 2: Write failing API client tests**

Assert create/join request iceMode, parse RoomSessionBootstrap, preserve ApiClientError codes/status, reject malformed missing paired RTC fields, and never store credentials in visitor localStorage.

- [ ] **Step 3: Write failing lifecycle tests**

~~~ts
const lifecycle = createRoomSessionLifecycle({
  expiresAt: 1_000,
  now: () => now,
  setTimer,
  clearTimer,
  onExpire,
})
~~~

Cover timer expiry, visibility check, reconnect check, peer-retry check, stop, idempotent expire, and stale generation.

- [ ] **Step 4: Run and confirm red**

Run:

~~~text
bun run --cwd apps/web test -- src/lib/config.test.ts src/lib/api-client.test.ts src/features/room/session-lifecycle.test.ts src/lib/realtime-client.test.ts
~~~

Expected: FAIL against synchronous STUN-only config and room-only responses.

- [ ] **Step 5: Implement config/bootstrap conversion**

~~~ts
export type ClientIceMode =
  | { mode: 'off'; configuration: RTCConfiguration }
  | { mode: 'static'; configuration: RTCConfiguration }
  | { mode: 'api' }
~~~

For api, convert the ICE-server-only DTO only after create/join returns, then overlay `VITE_ICE_TRANSPORT_POLICY` locally. Off and static use the same local overlay. Fail closed before WebSocket.

- [ ] **Step 6: Update App operation order**

~~~text
create/join bootstrap
→ resolve RTCConfiguration
→ save current room/bootstrap generation
→ connect WebSocket
→ on open send room:attach
→ create PeerSession with resolved configuration
~~~

Reconnect sends room:attach synchronously before flushing queued signals. Peer retry checks lifecycle active first. Room expiry resets file/text resources and returns a precise lobby toast. A `ROOM_MEMBERSHIP_REQUIRED` or `ROOM_EXPIRED` attach error increments the room generation, closes realtime and PeerSession, stops the lifecycle, clears text/file dialogs, queues, selections, progress frames, Blob URLs, and terminal timers, then returns to the lobby with a precise recoverable toast.

- [ ] **Step 7: Remove the room:join compatibility shim**

Only after App/realtime-client tests use room:attach and API clients always send `iceMode`, make the HTTP field required, delete room:join from ClientRealtimeMessage, API schemas, Hub branches, and fixtures, and remove the Task 7 missing→off compatibility test. Add the negative TypeScript contract fixture promised by Task 1. Run contracts, API route/Hub, and Web API/realtime tests together so no intermediate stale caller remains.

- [ ] **Step 8: Verify and commit**

Run:

~~~text
bun test packages/contracts/src/ice.test.ts services/api/src/modules/realtime/hub.test.ts
bun run --cwd apps/web test
bun run --cwd packages/contracts typecheck
bun run --cwd services/api typecheck
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
bun run --cwd apps/web build
~~~

Expected: PASS.

~~~bash
git add apps/web/src packages/contracts/src services/api/src/modules/realtime
git commit -m "feat: bootstrap WebRTC sessions with TURN"
~~~

---

### Task 11: coturn Deployment, Documentation, and Relay Verification

**Files:**
- Create: services/api/.env.example
- Create: apps/web/.env.example
- Create: services/api/scripts/render-coturn-config.ts
- Create: deploy/coturn/compose.yml
- Create: deploy/coturn/turnserver.conf.example
- Create: deploy/coturn/README.md
- Modify: .gitignore
- Modify: services/api/package.json
- Modify: services/api/README.md
- Modify: apps/web/README.md
- Modify: this plan checkboxes after completion.

- [ ] **Step 1: Add safe environment examples**

API example includes STUN_URLS, TURN_URLS, TURN_SHARED_SECRET, TURN_CREDENTIAL_GRACE_SECONDS=300, CORS_ALLOWED_ORIGINS, TRUST_PROXY, and TRUSTED_PROXY_IPS. Web example includes VITE_TURN_MODE, VITE_STUN_URLS, optional static values, and VITE_ICE_TRANSPORT_POLICY.

Use descriptive non-secret example values. Never include a working shared secret.

- [ ] **Step 2: Add the secret-safe config generation chain**

Add `bun run turn:config` in `services/api/package.json`. The script validates required realm, public/external IP, TLS paths, ports, and `TURN_SHARED_SECRET`, calls the already-tested `renderCoturnConfig`, creates `deploy/coturn/.local/`, and atomically writes `deploy/coturn/.local/turnserver.conf` with mode 0600. It must never print the secret or rendered config to stdout/stderr; tests use a temporary output dependency rather than writing a real workspace secret.

- [ ] **Step 3: Add coturn deployment files**

Pin coturn/coturn:4.14.0-r0. Linux production uses host networking and long-syntax bind mounts for only `.local/turnserver.conf` plus local cert/key, all read-only with `bind.create_host_path: false` so Compose fails when generation/material is absent. The checked-in example demonstrates every renderer option but keeps `static-auth-secret` commented out/empty, so it is intentionally unusable and is never mounted by Compose.

Ignore deploy/coturn/.local/ and all real cert/key/config output.

- [ ] **Step 4: Document operator steps**

Document public IP/domain, firewall 3478 UDP/TCP, 5349 TLS/TCP, 49160–49259 UDP relay range, matching shared secret, TLS paths, config generation, API/Web modes, quota/cost implications, and the single-instance limitation.

- [ ] **Step 5: Run complete repository verification**

Run: bun run verify

Expected: every lint/test/typecheck/build task for contracts, API, and Web passes.

- [ ] **Step 6: Verify relay environment**

With a configured public coturn instance:

1. Build Web with VITE_TURN_MODE=api and VITE_ICE_TRANSPORT_POLICY=relay.
2. Create/join two isolated sessions.
3. Confirm room:attach and peer ready.
4. Transfer exact text and a file; success under relay policy proves a relay candidate path.
5. Verify UDP TURN.
6. Block UDP and verify turns TCP/TLS fallback.
7. Confirm expired room closes before credential expiry.
8. Confirm API/frontend build/logs do not contain TURN_SHARED_SECRET.

If no public TURN host is available in the environment, mark only this external check pending in the handoff; do not claim it passed. All local signing/config/forced-policy tests must still pass.

- [ ] **Step 7: Check hygiene**

Run:

~~~text
git diff --check
git status --short
~~~

Expected: no .env, secret, generated coturn config, certificate, key, log, dist, or screenshot is staged.

- [ ] **Step 8: Mark plan complete and commit**

~~~bash
git add .gitignore services/api/.env.example apps/web/.env.example services/api/scripts/render-coturn-config.ts services/api/package.json deploy/coturn services/api/README.md apps/web/README.md docs/superpowers/plans/2026-07-11-turn-relay-implementation.md
git commit -m "docs: complete TURN relay milestone"
~~~
