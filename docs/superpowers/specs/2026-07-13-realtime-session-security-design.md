# Realtime Session Security Design

**Date:** 2026-07-13
**Status:** Approved design, pending written-spec review
**Scope:** Replace the long-lived visitor bearer in WebSocket URLs with short-lived single-use connection tickets, bound realtime ingress work and outbound buffering, and preserve safe receiver recovery when transient realtime setup fails.

## 1. Goal

Make the current single-process signaling service safe enough for a coordinated public release without changing the product's room-admission or peer-to-peer transfer protocols.

The completed room-authorization milestone guarantees that HTTP is the only membership-admission boundary and that WebSocket `room:attach` cannot create membership. This milestone preserves that boundary while removing three remaining realtime risks:

1. a two-hour visitor bearer currently appears in `/v1/realtime?token=...`;
2. an authenticated socket can submit valid or malformed frames without a per-principal rate budget;
3. the server relies on the runtime's implicit outbound buffering defaults.

The result also fixes the client lifecycle that currently discards receiver recovery state after a transient realtime failure.

## 2. Confirmed Scope

This milestone includes:

- a 30-second, 256-bit, single-use opaque WebSocket ticket;
- `POST /v1/realtime/tickets`, authenticated by the existing visitor bearer;
- a hard protocol cut from `?token=` to `?ticket=`;
- atomic ticket consumption before socket replacement or room state changes;
- bounded ticket storage, issuance rate limits, expiry cleanup, and visitor cleanup;
- a general ingress token bucket applied before realtime body-schema validation;
- an additional offer/answer token bucket;
- rate state that survives socket replacement for the same visitor;
- an explicit 512 KiB Bun outbound backpressure limit with automatic slow-socket closure;
- a ticket-aware asynchronous Web realtime client;
- authenticated readiness based on `visitor:ready`, not only browser `onopen`;
- removal of the disconnected client message queue;
- receiver recovery that preserves the current visitor and recoverable room session;
- focused contract, service, route, Hub, real-WebSocket, Web client, App, and full-workspace verification;
- deployment and logging documentation for the hard cut.

## 3. Non-Goals

This milestone does not add:

- resumable file transfer;
- streaming received files directly to disk;
- file digests or application-layer authenticated encryption;
- invitation rotation or revocation;
- room locking or sender removal of an admitted receiver;
- sender-room recovery;
- multiple simultaneous sockets for one visitor;
- a database, Redis, or multi-instance room/signaling state;
- account authentication;
- a compatibility endpoint, feature flag, or dual `token`/`ticket` WebSocket protocol;
- a custom JavaScript outbound message queue;
- a new recovery dialog or a visual redesign.

The existing 512 KiB raw WebSocket payload limit and SDP/ICE field bounds remain in force.

## 4. Considered Approaches

### 4.1 Opaque stateful ticket — selected

The API issues a random capability and stores only its SHA-256 digest, visitor binding, and expiry. Consumption is a synchronous lookup-and-delete operation.

This approach is selected because the application already uses bounded single-process state, it makes single-use semantics explicit, and it can reject replay before any socket or room mutation.

### 4.2 Signed self-contained ticket plus replay cache — rejected

A signed token would avoid a lookup only if replay were allowed. Enforcing single use still requires a replay cache, while also adding signing keys, rotation, claim validation, and more failure modes. It offers no useful simplification in the current architecture.

### 4.3 Cookie or WebSocket subprotocol authentication — deferred

An HttpOnly cookie would require credentialed CORS and a different deployment contract. Encoding credentials in `Sec-WebSocket-Protocol` would also require proxy and protocol-negotiation changes. Neither is necessary to remove the long-lived bearer from URLs in this milestone.

## 5. Security and Lifecycle Invariants

The implementation must preserve all of the following:

1. The long-lived visitor token is sent only in HTTPS `Authorization` headers and never in a WebSocket URL.
2. Ticket plaintext may exist only in the ticket issuance response, the Web client's ephemeral connection attempt, and the subsequent WebSocket query.
3. Ticket plaintext never enters storage, room state, rate-limit keys, public DTOs other than the issuance response, realtime messages, errors, logs, toasts, or rendered DOM.
4. The ticket store contains only a digest, visitor ID, issue/expiry metadata required for cleanup, and bounded indexing metadata.
5. `now >= expiresAt` means expired.
6. A ticket presented from an allowed Origin is deleted atomically before visitor capacity, replacement, touch, or room effects. Later failure never makes it reusable.
7. A missing or disallowed Origin is rejected before ticket consumption, so it cannot burn a legitimate ticket.
8. Forged, expired, already-used, and otherwise unknown tickets produce the same `REALTIME_TICKET_INVALID` result without reflecting input.
9. A replay cannot close or replace the current legitimate socket and cannot call `markConnecting`, attach, leave, touch, query a room, or forward a signal.
10. WebSocket attach remains a separate message and still requires an existing HTTP-created membership with the matching role.
11. One visitor still owns at most one live socket. A valid fresh ticket may replace that socket using the existing generation-safe replacement behavior.
12. Ingress rate state belongs to the authenticated visitor, not the socket ID, and survives reconnect/replacement.
13. Rejected frames have no visitor, room, membership, access-request, or signaling side effects.
14. A browser socket is not application-ready until the authenticated `visitor:ready` acknowledgement arrives.
15. The API and Web must deploy as one hard protocol cut.

## 6. Shared Contract

Add the platform-neutral ticket response to `@p2p/contracts`:

```ts
export type RealtimeTicketCapability = {
  ticket: string
  expiresAt: number
}
```

The runtime guard accepts exactly:

- `ticket`: `^wst_[A-Za-z0-9_-]{43}$`;
- `expiresAt`: a positive safe epoch-millisecond integer;
- no additional properties.

The guard does not require `expiresAt` to be later than the browser's local clock because clock skew is not an authentication boundary. The server owns expiry enforcement.

The ticket response type is exported from the package root. Ticket fields are not added to `VisitorSession`, `RoomSessionBootstrap`, `PublicRoom`, `ClientRealtimeMessage`, or `ServerRealtimeMessage`.

## 7. Ticket Cryptography and Storage

Add a Node/Bun ticket crypto adapter with this behavior:

- generate 32 random bytes with `node:crypto.randomBytes`;
- encode them as unpadded base64url;
- prepend `wst_`;
- derive a SHA-256 digest over the UTF-8 ticket;
- use a stable digest encoding as the store key;
- never log or include the ticket in an exception.

`RealtimeTicketService` is an isolated in-memory service with injected clock and crypto. Its public surface is:

- `issue(visitorId)`;
- `consume(ticket)`;
- `sweep()`;
- `removeVisitor(visitorId)`;
- `size()`.

Service defaults:

- TTL: 30,000 ms;
- maximum unconsumed tickets per visitor: 4;
- global maximum unconsumed tickets: 20,000.

`issue` first removes expired entries. It does not revoke another live ticket for the same visitor: an obsolete HTTP request may complete after a newer request, and revoking the newer capability would create a legitimate connection race. The four-ticket bound safely covers stale request overlap while preventing one visitor from occupying the global store.

If either live capacity is full after cleanup, issuance returns `CAPACITY_EXCEEDED`; it does not evict an unexpired ticket. A generated digest collision never overwrites the existing entry. The service retries a small fixed number of times and returns an internal generation failure if uniqueness cannot be obtained.

`consume` validates the exact token format before hashing. Lookup, expiry check, deletion, and success return are synchronous with no `await`. On success it returns only the bound `visitorId`. On an expired match it deletes the record and returns the same invalid result as an unknown ticket.

`removeVisitor` deletes every outstanding ticket for the visitor. `sweep` removes all entries at the exact expiry boundary and keeps both global and per-visitor indexes consistent.

## 8. Ticket Issuance Route

Add:

```text
POST /v1/realtime/tickets
Authorization: Bearer <visitor token>
Origin: <allowed Web origin>
```

The request has no body. The successful response is the exact `RealtimeTicketCapability` and inherits the existing `/v1/*` `Cache-Control: no-store` and `Referrer-Policy: no-referrer` headers.

The route order is:

1. run admission maintenance;
2. require an Origin in the configured allowlist;
3. resolve the trusted client IP;
4. apply the unauthenticated IP issuance limit;
5. parse the bearer and resolve a live visitor;
6. apply the authenticated visitor issuance limit;
7. touch the visitor;
8. issue and return a ticket.

Initial fixed-window issuance policies are:

- IP: 120 attempts per minute;
- authenticated visitor: 30 attempts per minute.

The keys contain only normalized IP or visitor ID. They never contain a visitor token or ticket. A rate failure returns HTTP 429 and an integer-seconds `Retry-After`. Ticket-store capacity returns HTTP 503. Missing/expired visitor authentication uses the existing stable `VISITOR_NOT_FOUND` response. Missing or disallowed Origin returns HTTP 403 with `ORIGIN_NOT_ALLOWED`.

The IP gate runs before bearer lookup so invalid-bearer floods are bounded. The visitor gate prevents a valid stolen or buggy visitor credential from generating an unbounded number of capabilities.

## 9. WebSocket Authentication and Connection Order

The route query changes from the exact `{ token }` object to the exact `{ ticket }` object using the shared token format. A `token` query, mixed query, missing ticket, or additional query field fails validation and never reaches the Hub.

The Hub connection order is:

1. run admission maintenance and consume emitted maintenance events;
2. require the current Origin to be configured and allowed;
3. synchronously consume the ticket;
4. resolve the bound visitor and prove the visitor is still live;
5. compute socket capacity and same-visitor replacement;
6. touch the visitor;
7. mark the previous connection's attached rooms as connecting when replacement is valid;
8. install the new connection and only then close the previous socket;
9. send `visitor:ready`.

Origin rejection happens before ticket consumption. Every allowed-Origin presentation consumes the ticket before capacity or replacement decisions. This deliberately means a capacity-rejected ticket cannot be retried.

The connection may derive the visitor token from the trusted internal visitor object for existing internal touch and sender-access snapshot calls. That token never came from the WebSocket request and is never serialized.

The Hub's `RealtimeConnectionResult` adds only the fixed ticket error code needed by the adapter. It does not expose expiry, replay, digest, or lookup distinctions.

## 10. Realtime Ingress Limiting

### 10.1 State ownership

Use a small realtime-specific token-bucket policy rather than the shared fixed-window HTTP limiter.

Each authenticated visitor has one bounded state record:

- general frame tokens;
- offer/answer tokens;
- last refill timestamp;
- whether the current depleted episode has already emitted an error.

The state map is bounded by the existing 10,000-visitor capacity. It survives socket disconnect and replacement so reconnecting cannot reset the budget. Maintenance removes it when the visitor expires. No timer is created per visitor.

The clock and policy values are injectable through Hub options for exact tests.

### 10.2 Policies

The initial policies are:

| Bucket | Burst | Refill |
| --- | ---: | ---: |
| Every incoming frame | 512 frames | 64 frames/second |
| Valid `signal:offer` or `signal:answer` | 64 frames | 8 frames/second |

The general burst accommodates simultaneous negotiation with the room's maximum 20 receivers. The second bucket separately bounds large SDP work while permitting initial negotiation and the current three bounded reconnect attempts.

Refill uses elapsed policy time derived from the injected millisecond clock, clamps to capacity, and handles exact boundaries deterministically. Backward clock movement never creates tokens.

### 10.3 Adapter order and malformed frames

Every raw WebSocket message must consume the general bucket after Elysia's primitive JSON parse but before the route body schema check. This ensures malformed JSON, wrong shapes, internal no-op attempts, attach, leave, ICE, offer, and answer frames all share the same general budget.

Elysia's WebSocket parser runs before schema validation but does not safely route a parser throw through the route error hook. The adapter therefore uses a route-local, non-contract drop sentinel:

1. the parser asks the Hub to admit the frame;
2. when admitted, it returns `undefined` so Elysia continues with the parsed value;
3. when rejected, it optionally sends the one fixed rate error directly and returns the private drop sentinel;
4. the route-local body schema accepts that sentinel only so validation does not manufacture another response;
5. the message handler recognizes and discards the sentinel before calling the Hub.

An external client can reproduce the sentinel's JSON shape but not its in-memory marker. Such a frame is still charged and ignored; it never becomes a shared contract message or a Hub command.

After ordinary schema validation, the Hub charges the description bucket before processing an offer or answer. A rejected description has already consumed its general-frame token.

### 10.4 Rejection behavior

The first rejected frame in one depleted episode sends:

```json
{
  "type": "error",
  "code": "REALTIME_RATE_LIMITED",
  "message": "实时消息过于频繁，请稍后重试"
}
```

Later rejected frames in the same episode are silently dropped. Notification eligibility resets only after refill has restored both buckets to at least half capacity. This avoids response amplification under a sustained flood.

The server does not close a connection merely for reaching the ingress rate limit. Closing would encourage socket churn and would not improve recovery. A rejected frame must not touch the visitor, inspect or mutate room state, publish access state, forward signaling, or change membership.

## 11. Outbound Backpressure

Configure Bun's native per-socket queue explicitly:

```ts
websocket: {
  maxPayloadLength: 512 * 1_024,
  backpressureLimit: 512 * 1_024,
  closeOnBackpressureLimit: true,
}
```

The 512 KiB queue can hold one worst-case bounded SDP message plus ordinary control traffic while keeping the per-socket allocation far below the runtime's implicit high default.

No JavaScript queue, byte counter, drain state machine, or message retry is added. Signaling frames must remain ordered and stale signaling should not be replayed later. When Bun closes a slow consumer, the existing route close handler invokes Hub disconnect, marks attached membership connecting, and lets the Web perform its bounded reconnect.

Tests assert the exact runtime configuration. A real slow-consumer network test is intentionally excluded because operating-system and client buffering make it nondeterministic; Bun's pinned runtime semantics and the configuration assertion are the stable boundary.

## 12. Web Ticket API

Add `createRealtimeTicket(visitorToken, options)` to the existing typed API client. It:

- sends `POST /v1/realtime/tickets`;
- places the visitor token only in `Authorization`;
- sends no request body;
- strictly validates the shared ticket response;
- parses `Retry-After` into bounded epoch-independent milliseconds on `ApiClientError`;
- never includes the bearer or ticket in a thrown message.

The WebSocket URL builder accepts a ticket, not a visitor token, and emits exactly:

```text
/v1/realtime?ticket=wst_...
```

No compatibility overload accepting a token remains.

## 13. Realtime Client State Machine

`createRealtimeClient` receives an asynchronous provider:

```ts
issueTicket(signal: AbortSignal): Promise<RealtimeTicketCapability>
```

The client owns one attempt generation and at most one ticket request. Each initial attempt, constructor retry, pre-ready socket failure, and reconnect obtains a fresh ticket.

### 13.1 Attempt lifecycle

1. `connect` changes `idle` to `connecting` and starts one ticket request.
2. A resolved ticket is used only if the attempt generation is still current and the client is not explicitly closed.
3. The client constructs one WebSocket with the ticket URL.
4. Browser `onopen` starts a five-second authenticated-ready deadline but does not set application status to `open`.
5. The first valid `visitor:ready` clears the deadline, changes status to `open`, and starts the existing five-second stability timer.
6. App sends `room:attach` synchronously from the `open` status callback and only then creates the PeerSession.
7. An unexpected close disposes that attempt and schedules a fresh ticket attempt.
8. Three reconnects use 500, 1,000, and 2,000 ms delays.
9. Five stable seconds after authenticated readiness reset the reconnect budget.

An explicit `close` aborts the ticket request, increments the generation, clears ready/stability/reconnect timers, closes the socket, and prevents late promises or events from publishing status, messages, or failures.

### 13.2 No disconnected message queue

Delete `pendingMessages`. `send` returns `false` unless the current socket is authenticated-ready and open.

This is safe because App sends attach only after ready, creates no PeerSession until after attach is sent, and disposes PeerSession as soon as realtime begins reconnecting. There is no valid signal that needs to survive a disconnect; a new PeerSession renegotiates after reconnection.

### 13.3 Failure channel

Keep the existing status vocabulary and add a separate typed terminal failure subscription:

```ts
type RealtimeFailure = {
  stage: 'ticket' | 'handshake' | 'socket'
  code: string
  message: string
  retryable: boolean
  retryAfterMs?: number
}
```

Failure data contains fixed messages and stable codes only. It never includes a URL, ticket, visitor token, frame, SDP, or ICE content.

Pre-ready `REALTIME_TICKET_INVALID` and capacity failures are internal retryable handshake failures. `ORIGIN_NOT_ALLOWED` is terminal configuration failure. A ticket HTTP `VISITOR_NOT_FOUND` is terminal identity failure. Network, HTTP 429, and 5xx failures use the bounded retry policy.

For 429, the next delay is at least `Retry-After`. If that delay cannot fit the current automatic reconnect/member-resume window, the client emits a retryable terminal failure with `retryAfterMs` instead of waiting on a membership that will expire.

## 14. App Cleanup and Recovery

The current `disposeRoomResources` mixes active-resource cleanup with permanent room abandonment. Split the behavior without performing an unrelated App refactor.

### 14.1 Active connection disposal

This path clears:

- room lifecycle and visibility listener;
- realtime client;
- PeerSession and subscriptions;
- live room reference;
- transfer dialogs, selections, progress, timers, abort controllers, Blob URLs, and speed presentation.

For a receiver transient failure it preserves:

- visitor session;
- persisted receiver room session;
- receiver recovery intent;
- the information required by the existing recovery prompt.

### 14.2 Permanent abandonment

This path additionally clears:

- persisted room recovery;
- receiver recovery intent;
- manual join intent and poller;
- owner invitation state;
- sender access-request UI state.

It is used for explicit leave/change-room, sender termination, expired/nonexistent room, invalid membership, invalid visitor identity, and unmount rules that already require terminal cleanup.

### 14.3 User-visible outcomes

- During the three internal reconnect attempts, keep the room screen and show the existing reconnecting feedback without duplicate toasts.
- When a receiver exhausts a transient retry, return to the lobby with the existing recovery prompt and preserve the same visitor.
- The recovery button first performs strict HTTP recovery, refreshes TURN/ICE bootstrap, creates a new realtime client, obtains a new ticket, attaches, and then creates a new PeerSession.
- A receiver 429 terminal failure exposes the remaining delay; recovery cannot start before the server-provided deadline.
- `VISITOR_NOT_FOUND` clears visitor and room recovery, creates a fresh visitor, and does not offer invalid same-identity recovery.
- `ROOM_NOT_FOUND`, `ROOM_EXPIRED`, and `ROOM_MEMBERSHIP_REQUIRED` permanently clear room recovery.
- A sender still has no room recovery. Retry exhaustion ends the current sender room locally and lets server membership cleanup close it.
- Explicit leave, changing rooms, or unmount invalidates every outstanding attempt so an obsolete ticket cannot resurrect a room.

No new modal is introduced. Existing lobby recovery presentation and toasts are reused with precise copy.

## 15. Maintenance and Capacity

Maintenance gains the ticket service and realtime limiter as explicit dependencies:

- ticket expiry cleanup runs with the existing visitor/rate-key sweep;
- visitor removal deletes outstanding tickets and the visitor's realtime rate state before deleting the visitor;
- admission sweep can free expired tickets before ticket issuance or socket admission;
- runtime `start`/`stop` still owns only the existing shared timers;
- no ticket or rate-state timer is created per visitor.

Ticket service methods also enforce their own exact target expiry and pre-issuance cleanup so correctness does not depend on timer timing.

The existing capacities remain:

- 10,000 visitors;
- 10,000 live sockets;
- 20 receivers per room.

New capacities are:

- 20,000 unconsumed tickets globally;
- 4 unconsumed tickets per visitor;
- at most one realtime rate record per live visitor.

## 16. Error Mapping

Stable new errors are:

| Boundary | Code | Behavior |
| --- | --- | --- |
| Ticket HTTP Origin | `ORIGIN_NOT_ALLOWED` | HTTP 403 |
| Ticket HTTP authentication | `VISITOR_NOT_FOUND` | existing authentication status/body |
| Ticket HTTP rate | `RATE_LIMITED` | HTTP 429 plus `Retry-After` |
| Ticket store capacity | `CAPACITY_EXCEEDED` | HTTP 503 |
| WebSocket ticket | `REALTIME_TICKET_INVALID` | fixed realtime error, then close |
| WebSocket Origin | `ORIGIN_NOT_ALLOWED` | fixed realtime error, then close |
| Ingress frame budget | `REALTIME_RATE_LIMITED` | first depleted-frame error, later drops |

Validation and parse failures retain the existing fixed `INVALID_REALTIME_MESSAGE`. Internal realtime failures retain `REALTIME_INTERNAL_ERROR`. None reflects request input.

## 17. Test Strategy

### 17.1 Contracts

Table tests cover:

- exact valid ticket shape and prefix;
- all token length/alphabet boundaries;
- unsafe/zero/negative expiry;
- extra and missing fields;
- ticket fields rejected from visitor, room bootstrap, public room, and realtime DTOs;
- type-only negative assignments.

### 17.2 Ticket crypto and service

Tests cover:

- fixed random bytes producing the expected base64url format;
- SHA-256 digest use and absence of plaintext in inspected state/test adapters;
- first consume success and second consume failure;
- forged, malformed, expired, and replay results sharing one error;
- exact `now === expiresAt` behavior;
- synchronous/concurrent-style double consumption with only one success;
- four-ticket visitor boundary and global capacity;
- expired cleanup before capacity;
- collision handling without overwrite;
- visitor removal and index consistency.

### 17.3 Ticket route

Tests cover:

- success with allowed Origin and live bearer;
- no body and strict response validation;
- missing/disallowed Origin;
- invalid/missing bearer;
- IP and visitor rate limits using secret-free keys;
- `Retry-After`;
- store capacity mapping;
- global no-store/no-referrer headers on successes and every error;
- no token/ticket reflection.

### 17.4 Hub and WebSocket route

Unit/integration tests cover:

- valid ticket connection and `visitor:ready`;
- old `?token=` rejection;
- mixed/additional query rejection;
- invalid Origin not consuming a subsequently usable ticket;
- invalid/expired/replayed ticket uniformity;
- ticket consumption before capacity failure;
- replay leaving the current socket, online state, and rooms unchanged;
- visitor expiry between issue and consume;
- valid same-visitor replacement with a fresh ticket;
- general and description bucket exact burst/refill boundaries;
- malformed frames consuming the general bucket;
- attach, leave, ICE, offer, and answer all consuming general budget;
- socket replacement inheriting rate state;
- one rate error per depleted episode and half-capacity reset;
- rejected messages causing no touch, lookup, transition, or forwarding;
- rate state removal on visitor expiry;
- the existing 512 KiB inbound frame close;
- exact Bun backpressure configuration.

### 17.5 Web API and realtime client

Tests cover:

- exact ticket request headers/path/body;
- ticket response validation and `Retry-After` parsing;
- URL containing only `ticket`;
- no socket before ticket resolution;
- repeated `connect` not issuing in parallel;
- close/room change before ticket resolution producing no socket;
- every reconnect using a distinct ticket;
- constructor failure discarding its ticket;
- browser `onopen` not emitting application `open`;
- `visitor:ready` completing authenticated readiness;
- five-second ready timeout;
- attach sent once before PeerSession work;
- no disconnected queue and `send` returning false;
- retryable network/429/5xx behavior;
- terminal identity and Origin behavior;
- stable-ready reconnect budget reset;
- old attempt events/failures ignored;
- no secret material in emitted failure data.

### 17.6 App

App tests cover:

- create-room, invitation join, approved manual join, and receiver recovery all using the same ticket flow after successful HTTP bootstrap;
- no ticket request before bootstrap;
- reconnect clearing PeerSession but preserving receiver recovery;
- receiver retry exhaustion returning to the existing recovery prompt;
- recovery using the same visitor and refreshing HTTP bootstrap/TURN first;
- `VISITOR_NOT_FOUND` clearing recovery and replacing the visitor;
- terminal room errors clearing recovery;
- sender retry exhaustion not showing receiver recovery;
- leave/change-room/unmount invalidating late ticket results;
- no duplicate terminal cleanup or toast when failure and closed notifications race;
- no visitor token or ticket in URL assertions, storage mocks, DOM, or toast text.

### 17.7 Verification

Run focused tests first, then:

```bash
bun run verify
bunx turbo run lint test typecheck build --force
git diff --check
```

The forced Turbo run prevents a stale cache from hiding integration or production-build failures.

## 18. Deployment and Documentation

API and Web must ship together. There is no compatibility period:

- the new API rejects `?token=`;
- the new Web never constructs `?token=`;
- rollback must roll both surfaces back together;
- an API restart invalidates tickets along with the existing in-memory visitors, rooms, access requests, and sockets;
- old pages must reload and create/recover according to the already documented hard-cut rules.

Production requirements remain:

- HTTPS/WSS only;
- proxy, WAF, CDN, APM, tracing, and exception reporting must omit or redact complete query strings;
- application logs must omit request URLs, Authorization, ticket responses, frames, SDP, and ICE;
- gateway connection quotas and process/coturn capacity monitoring remain required.

Update API and Web READMEs to document the ticket flow, hard cut, rate behavior, slow-socket behavior, and recovery semantics. The service worker does not change because API and WebSocket requests are already outside its static allowlist.

## 19. Acceptance Criteria

The milestone is complete only when:

1. No long-lived visitor token enters a WebSocket URL.
2. A ticket is 256-bit, expires after 30 seconds, is stored only by digest, and succeeds at most once.
3. Unknown, expired, and replayed tickets are externally indistinguishable.
4. Invalid Origin cannot consume a ticket.
5. Replaying a ticket cannot replace a valid socket or mutate room state.
6. Old `?token=` and mixed query protocols are rejected.
7. Malformed and valid frames share a bounded general ingress budget.
8. Offer/answer work has its additional bounded budget.
9. Reconnect cannot reset an authenticated visitor's rate budget.
10. Rejected frames have zero business-state effects and do not amplify error responses.
11. Every socket has an explicit 512 KiB native outbound queue limit and slow sockets close automatically.
12. The Web treats `visitor:ready` as authentication readiness and never queues disconnected signaling.
13. Every reconnect obtains a fresh ticket, and stale async work cannot resurrect an obsolete room.
14. Receiver transient failure preserves same-visitor recovery; identity and terminal room failures do not.
15. Ticket and visitor secrets are absent from storage, DOM, ordinary DTOs, errors, logs, and test snapshots.
16. Focused tests, workspace verification, forced lint/test/typecheck/build, and diff checks all pass.

## 20. Explicitly Deferred

The next product/security milestones remain:

- invitation rotation and revocation;
- room locking and sender participant removal;
- application-layer authenticated encryption;
- resumable transfer, streaming-to-disk, and file digests;
- multi-instance shared room, ticket, rate, and signaling state.

Any future multi-instance deployment must move ticket issuance/consumption to shared storage with TTL and atomic get-and-delete semantics. This design intentionally targets the current bounded single-process runtime.
