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
- a general ingress token bucket applied after Elysia's primitive message decoding and before realtime body-schema validation;
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
- replacement of Elysia's WebSocket adapter or an application-owned pre-JSON byte-rate gate;
- a new recovery dialog or a visual redesign.

The existing 512 KiB raw WebSocket payload limit and SDP/ICE field bounds remain in force. Raw-frame parsing and connection-volume protection remain the responsibility of that payload cap plus the required edge/gateway connection and throughput limits; this milestone bounds schema and business work per authenticated visitor, not all transport-layer CPU.

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
6. After the route has reserved a raw WebSocket lifecycle slot, a ticket presented from an allowed Origin is deleted atomically before authenticated capacity, replacement, touch, or room effects. Later failure never makes it reusable.
7. A missing or disallowed Origin is rejected before ticket consumption, so it cannot burn a legitimate ticket.
8. Well-formed exact-format forged, expired, already-used, and otherwise unknown tickets produce the same `REALTIME_TICKET_INVALID` result without reflecting input. Missing, malformed, old-`token`, mixed, and additional query shapes fail the exact query schema before upgrade and are not part of this indistinguishability claim.
9. A replay cannot close or replace the current legitimate socket and cannot call `markConnecting`, attach, leave, touch, query a room, or forward a signal.
10. WebSocket attach remains a separate message and still requires an existing HTTP-created membership with the matching role.
11. One visitor still owns at most one live socket. A valid fresh ticket may replace that socket using the existing generation-safe replacement behavior.
12. Ingress rate state belongs to the authenticated visitor, not the socket ID, and survives reconnect/replacement.
13. Every message that reaches the route parser is charged after Elysia's primitive decoding and before the body schema or Hub. Rejected frames have no visitor, room, membership, access-request, or signaling side effects.
14. A browser socket is not application-ready until the authenticated `visitor:ready` acknowledgement arrives.
15. The process reserves capacity before WebSocket upgrade and holds it through the raw socket's final close, so pending upgrades, rejected sockets, replacements, and slow-closing sockets share one hard lifecycle bound.
16. The API and Web must deploy as one hard protocol cut.

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

The contracts package exports the token-pattern string and an `isRealtimeTicketToken` guard so the Elysia query schema, service, and Web response guard share one source of truth.

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

If either live capacity is full after cleanup, issuance returns `CAPACITY_EXCEEDED` with only the duration until the earliest relevant ticket expires; it does not evict an unexpired ticket. The route rounds that duration up to an integer-seconds `Retry-After`, without exposing capacity counts, visitor IDs, or ticket metadata. A generated digest collision never overwrites the existing entry. The service makes exactly three generation attempts. If all three collide or crypto generation fails, it returns the fixed `REALTIME_TICKET_UNAVAILABLE` service error without exposing the exception or generated values.

When one or both capacities are saturated, the service computes the first time all blocking conditions can be clear:

```text
visitorReadyAt =
  visitor capacity full ? earliest expiry for that visitor : now

globalReadyAt =
  global capacity full ? earliest expiry in the whole store : now

retryAfterMs = max(visitorReadyAt, globalReadyAt) - now
```

Using the maximum is required when both capacities are full; returning the earliest expiry across the combined set could trigger a retry while the visitor-specific condition is still blocked.

`consume` validates the exact token format before hashing. Lookup, expiry check, deletion, and success return are synchronous with no `await`. On success it returns only the bound `visitorId`. On an expired match it deletes the record and returns the same invalid result as an unknown ticket.

`removeVisitor` deletes every outstanding ticket for the visitor. `sweep` removes all entries at the exact expiry boundary and keeps both global and per-visitor indexes consistent.

## 8. Ticket Issuance Route

Add:

```text
POST /v1/realtime/tickets
Authorization: Bearer <visitor token>
Origin: <allowed Web origin>
```

The request has no body. The successful response is the exact `RealtimeTicketCapability` and inherits the existing `/v1/*` `Cache-Control: no-store` and `Referrer-Policy: no-referrer` headers. CORS exposes only the additional response header `Retry-After` so the cross-origin Web client can honor bounded ticket throttling and capacity delays.

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

The keys contain only normalized IP or visitor ID. They never contain a visitor token or ticket. A rate failure returns HTTP 429 and an integer-seconds `Retry-After`. Ticket-store capacity returns HTTP 503 with the same header derived from the earliest relevant expiry. Missing/expired visitor authentication uses the existing stable `VISITOR_NOT_FOUND` response. Missing or disallowed Origin returns HTTP 403 with `ORIGIN_NOT_ALLOWED`.

The IP gate runs before bearer lookup so invalid-bearer floods are bounded. The visitor gate prevents a valid stolen or buggy visitor credential from generating an unbounded number of capabilities.

## 9. WebSocket Authentication and Connection Order

The route query changes from the exact `{ token }` object to the exact `{ ticket }` object using the shared token format. A `token` query, mixed query, missing or malformed ticket, or additional query field fails with the existing fixed HTTP query-validation response before upgrade, never consumes a ticket, and never reaches the Hub. Only an exact-format capability reaches ticket consumption; unknown, expired, and consumed values at that boundary share `REALTIME_TICKET_INVALID`.

Only the route's `upgrade` hook synchronously asks a shared `RealtimeSocketCapacity` service for one opaque in-memory lease; `beforeHandle` is not used because Elysia 1.4.29 invokes it twice for this route. `reserve` performs one atomic capacity check and insert without `await`. The default 512-lease bound includes pending upgrades and every raw socket through its final `close`. If no lease is available, the route throws/maps fixed HTTP 503 `CAPACITY_EXCEEDED` before calling Bun upgrade and does not consume the ticket. The lease is stored only in Elysia's internal connection context.

Lifecycle ownership follows the pinned runtime's verified order:

- successful upgrade: `upgrade(unbound) -> open(bound) -> afterResponse(bound) -> close(bound)`;
- `server.upgrade === false`: `upgrade(unbound) -> afterResponse(unbound)`, with no `open` or `close`.

`open` atomically binds the lease to `ws.raw` before Hub connect. Route `error` and `afterResponse` both call idempotent `releaseUnbound(lease)`; that is a no-op after successful bind and immediately releases thrown/failed upgrades. Final `close` calls idempotent `releaseBound(ws.raw)` after Hub disconnect. There is no blind expiry or per-lease timer: a timeout could release a lease before a late raw `open` and invalidate the hard bound. A missing/already-released lease at `open` is a pinned-adapter invariant failure and the socket closes before Hub connect. Lease identity is never serialized, logged, or accepted from a client.

Only after a raw lifecycle lease exists does the Hub connection order run:

1. run admission maintenance and consume emitted maintenance events;
2. require the current Origin to be configured and allowed;
3. synchronously consume the ticket;
4. resolve the bound visitor and prove the visitor is still live;
5. compute socket capacity and same-visitor replacement;
6. touch the visitor;
7. mark the previous connection's attached rooms as connecting when replacement is valid;
8. install the new connection and only then close the previous socket;
9. send `visitor:ready`.

Origin rejection happens before ticket consumption. Every allowed-Origin presentation with a lifecycle lease consumes the ticket before authenticated-Hub capacity or replacement decisions. This deliberately means a Hub-capacity-rejected ticket cannot be retried; a pre-upgrade raw-capacity rejection leaves it usable.

The connection may derive the visitor token from the trusted internal visitor object for existing internal touch and sender-access snapshot calls. That token never came from the WebSocket request and is never serialized.

The Hub's `RealtimeConnectionResult` adds only the fixed ticket error code needed by the adapter. It does not expose expiry, replay, digest, or lookup distinctions.

## 10. Realtime Ingress Limiting

### 10.1 State ownership

Use a dedicated `RealtimeIngressLimiter` service rather than the shared fixed-window HTTP limiter. `createDefaultContext` constructs this service before Maintenance and injects the same instance into Maintenance and the Hub; the Hub does not create private limiter state that Maintenance cannot reach.

Each authenticated visitor has one bounded state record:

- general frame tokens;
- offer/answer tokens;
- last refill timestamp;
- whether the current depleted episode has already emitted an error.

The state map is bounded by the existing 10,000-visitor capacity. It survives socket disconnect and replacement so reconnecting cannot reset the budget. Maintenance removes it when the visitor expires. No timer is created per visitor.

The clock and policy values are injectable through limiter options for exact tests. Its public boundary admits a general frame or validated description by visitor ID, removes a visitor, and exposes size for capacity tests. The Hub maps a live socket ID to its visitor before calling the limiter.

### 10.2 Policies

The initial policies are:

| Bucket | Burst | Refill |
| --- | ---: | ---: |
| Every incoming frame | 512 frames | 64 frames/second |
| Valid `signal:offer` or `signal:answer` | 64 frames | 8 frames/second |

The general burst accommodates simultaneous negotiation with the room's maximum 20 receivers. The second bucket separately bounds large SDP work while permitting initial negotiation and the bounded sender/receiver reconnect policies.

Refill uses:

```text
refilled = min(capacity, tokens + max(0, now - lastRefillAt) * refillPerSecond / 1000)
```

Before either admission decision, the limiter refills both buckets from the same elapsed interval and updates `lastRefillAt` exactly once to `max(previousLastRefillAt, now)`. If the clock moves backward, elapsed time is zero and the stored timestamp is unchanged. A frame consumes exactly one token only when at least one token is available. Capacities clamp fractional tokens and exact boundaries are deterministic.

### 10.3 Adapter order and malformed frames

Elysia 1.4.29 performs its primitive string/JSON decoding before the route-local custom parser, while body-schema validation happens after it. The exact boundary for this milestone is therefore:

```text
Bun 512 KiB payload cap
  -> Elysia primitive decode
  -> authenticated general-frame admission
  -> route body schema
  -> description admission
  -> Hub business handling
```

Malformed JSON, wrong shapes, internal no-op attempts, attach, leave, ICE, offer, and answer frames all consume the general budget before schema or business work. The token bucket does not claim to bound Elysia's earlier primitive parse. The package pins Elysia exactly to 1.4.29, and the deployment retains edge connection/throughput limits for that residual transport cost.

The Elysia Bun adapter passes the raw `ServerWebSocket` to the custom parser even though its public parser type suggests an `ElysiaWS`. The route handles that verified runtime boundary explicitly:

1. `open` first binds the valid pending lifecycle lease to `ws.raw`, then registers `ws.raw -> ws.id` in a route-local `WeakMap` before calling Hub connect;
2. the parser treats its socket argument as unknown/raw, resolves the ID through that `WeakMap`, and asks the Hub to admit the frame;
3. an admitted frame returns `undefined`, preserving Elysia's primitive-decoded value for ordinary schema validation;
4. a rejected frame returns one of two private singleton values, `DROP_SILENT` or `DROP_NOTIFY`, and never calls raw `send`;
5. the route-local body schema accepts only the private sentinel wire shape in addition to the public client-message schema, preventing a second validation response;
6. the message callback, which receives a real `ElysiaWS`, sends the fixed rate error only for identity-equal `DROP_NOTIFY`;
7. the message callback silently discards both singleton values and every externally reproducible sentinel-shaped value before calling the Hub;
8. `close` removes the raw-socket mapping, performs the normal generation-safe Hub disconnect, and finally releases the raw lifecycle lease exactly once.

An external sentinel-shaped frame is still charged before being ignored. An unknown, rejected, disconnected, or replaced socket has no authenticated visitor budget: `admitFrame(socketId)` returns `DROP_SILENT` and never creates limiter state. A real WebSocket regression test locks the raw-socket lookup, parser order, sentinel identity, and schema behavior so an Elysia upgrade cannot silently change this boundary.

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

Later rejected frames in the same episode are silently dropped. Before consuming the current frame, notification eligibility resets only when refill has restored both buckets to at least half capacity. This avoids response amplification under a sustained flood.

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

The 512 KiB queue comfortably holds normal data-channel SDP and control traffic while keeping the per-socket allocation far below the runtime's implicit high default. An adversarial frame near the inbound maximum may itself make a slow socket hit the outbound limit; closing that socket is the intended bounded behavior.

No JavaScript queue, byte counter, drain state machine, or message retry is added. Signaling frames must remain ordered and stale signaling should not be replayed later. When Bun closes a slow consumer, the existing route close handler invokes Hub disconnect, marks attached membership connecting, and lets the Web perform its bounded reconnect.

The existing hard-coded 10,000 authenticated-socket default is not compatible with a 512 KiB per-socket queue: its theoretical queued-payload ceiling is about 5 GiB before socket and application overhead. Add validated `REALTIME_MAX_SOCKETS` configuration with a default of 512 and an accepted range of 33 through 1,024. This value configures `RealtimeSocketCapacity`, not merely the Hub map. The Hub's authenticated capacity is derived as `REALTIME_MAX_SOCKETS - 32`, leaving 32 bounded raw lifecycle slots for concurrent upgrades, same-visitor replacement overlap, rejections, and closing sockets.

At the default, at most 512 pending/bound raw lifecycle leases can exist and native queued payload is therefore bounded to 256 MiB; at the hard single-process maximum it is 512 MiB. A rejected or replaced raw socket continues consuming its lease until `close`, so the formula does not exclude the exact sockets most likely to retain queued output. Deployment documentation must show:

```text
maximum native queued payload =
  raw lifecycle lease limit * 512 KiB

default authenticated Hub limit =
  REALTIME_MAX_SOCKETS - 32 = 480
```

Operators must leave additional memory for Bun, parsed messages, rooms, visitors, tickets, and TURN/bootstrap work. Scaling beyond the hard maximum requires the deferred multi-instance architecture rather than silently raising the in-process ceiling.

Tests assert the exact runtime configuration, config boundaries, lifecycle-lease cap, failed-upgrade release, and derived Hub cap. A real slow-consumer network test is intentionally excluded because operating-system and client buffering make it nondeterministic; Bun's pinned runtime semantics and the configuration/lifecycle assertions are the stable boundary.

## 12. Web Ticket API

Add `createRealtimeTicket(visitorToken, { signal })` to the existing typed API client. It:

- sends `POST /v1/realtime/tickets`;
- places the visitor token only in `Authorization`;
- sends no request body;
- passes the attempt's `AbortSignal` to `fetch`;
- strictly validates the shared ticket response;
- adds optional `retryAfterMs` to `ApiClientError`;
- accepts only positive safe-integer delta-seconds in `Retry-After`, converts to milliseconds, and clamps the result to 1 through 60,000 ms;
- never includes the bearer or ticket in a thrown message.

A missing, zero, signed, fractional, date-form, overflowing, or otherwise invalid `Retry-After` is ignored. The same parser applies to HTTP 429 and ticket-capacity HTTP 503 responses.

`ApiClientOptions` gains `signal?: AbortSignal`, and the shared `request` helper passes it to `fetch` for ticket issuance and strict `joinRoom(... admission: recovery ...)` requests. Existing injected-fetch and base-URL options remain unchanged.

The WebSocket URL builder accepts a ticket, not a visitor token, and emits exactly:

```text
/v1/realtime?ticket=wst_...
```

No compatibility overload accepting a token remains.

## 13. Realtime Client State Machine

`createRealtimeClient` receives the expected visitor ID, an asynchronous provider, and injectable monotonic timing for exact tests:

```ts
{
  expectedVisitorId: string
  issueTicket(signal: AbortSignal): Promise<RealtimeTicketCapability>
  now?: () => number
  recoveryMode: 'none' | 'receiver' | 'receiver-post-strict'
  recoverableUntil?: number
}
```

The client owns one attempt generation, at most one ticket request, and two monotonic cutoffs. App calls it immediately after a successful HTTP bootstrap:

- `none` is used by senders: `realtimeRetryUntil = recoverableUntil`, so the client may use the full 10-second epoch and three reconnects because no strict room recovery follows;
- `receiver` uses `recoverableUntil = now + 10,000 ms`, `realtimeRetryUntil = recoverableUntil - 3,000 ms`, and at most two reconnects; the final three seconds and the visitor's fourth unconsumed-ticket slot are reserved for one strict HTTP recovery plus its first final ticket;
- `receiver-post-strict` also sets `realtimeRetryUntil = recoverableUntil`, using a fresh full 10-second realtime epoch and at most three reconnects because no second strict escalation is allowed while that connection is unstable.

App may supply an existing same-document `recoverableUntil`; otherwise the client derives it from the monotonic clock. Each pre-ready socket failure and reconnect obtains a fresh ticket.

### 13.1 Attempt lifecycle

1. `connect` changes `idle` to `connecting`, establishes `recoverableUntil` and `realtimeRetryUntil`, and starts one attempt.
2. Each attempt creates an independent `AbortController` and a deadline of `min(attemptStart + 3,000 ms, realtimeRetryUntil)`. That timer covers ticket fetch, WebSocket construction, browser open, and authenticated readiness; it does not begin late in `onopen`.
3. A resolved ticket is used only if the attempt generation is still current, its signal is not aborted, and the client is not explicitly closed.
4. The client constructs one WebSocket with the ticket URL. A synchronous constructor failure is a terminal client/configuration failure, not a reason to issue more orphaned tickets.
5. Browser `onopen` only records that the current socket has opened. It does not set application status to `open`.
6. `visitor:ready` must arrive for the current generation and current socket after `onopen`; its exact shape must pass a focused runtime guard, and its visitor ID must equal `expectedVisitorId`.
7. The client sets `authenticatedReady = true` before synchronously publishing `open`, so an `open` listener can call `send(room:attach)` successfully. `visitor:ready` is a control frame and is not published to ordinary message subscribers; duplicate readiness is ignored.
8. Pre-ready fixed ticket/Origin/capacity errors are handled only by the handshake state machine. Any other pre-ready frame fails the current attempt with fixed `CLIENT_HANDSHAKE_INVALID`; it never reaches App's ordinary message listener.
9. App sends `room:attach` synchronously from the `open` callback, checks that `send` returned `true`, and creates the PeerSession only after that success. If an authenticated-ready socket's `readyState` changed or native `send` throws, `RealtimeClient.send` itself enters the guarded unexpected-close/retry path and returns `false`; App only refrains from creating negotiation state.
10. A browser `onerror` never exposes its event or independently publishes failure; it best-effort closes/fails the current attempt through the same generation guard. An unexpected close detaches all old handlers, disposes that attempt, and schedules a fresh-ticket attempt.
11. Sender/post-strict modes allow at most three reconnects with 500, 1,000, and 2,000 ms backoffs. Normal receiver mode allows only the first two, preserving the fourth ticket slot. A retry starts only if its effective delay and next attempt can begin before `realtimeRetryUntil`; each attempt is clipped to the remaining realtime time.
12. Five stable seconds after authenticated readiness reset the reconnect-count budget and the one-strict-recovery escalation flag. `receiver-post-strict` then switches to normal `receiver` policy for a genuinely later disconnect. That close starts a fresh 10-second/3-second-reserve epoch because the server also starts a fresh 15-second attach grace.

Every attempt timeout aborts the ticket request, closes/detaches its socket if one exists, and advances the generation before retry. Explicit `close`, room change, and unmount do the same while also clearing ready/stability/reconnect timers. An abort rejection exits silently. Generation checks remain mandatory even if a test provider or browser ignores `AbortSignal`, so late ticket results and socket events cannot publish status, messages, or failures.

### 13.2 No disconnected message queue

Delete `pendingMessages`. `send` returns `false` unless the current socket is authenticated-ready and open. Before readiness, `false` has no lifecycle side effect. After readiness, a non-open `readyState` or native-send exception best-effort closes the target and is treated as the current socket's unexpected failure through the same generation guard; the event/payload/exception is never exposed.

This is safe because App sends attach only after ready, creates no PeerSession until after attach is sent, and disposes PeerSession as soon as realtime begins reconnecting. There is no valid signal that needs to survive a disconnect; a new PeerSession renegotiates after reconnection.

### 13.3 Failure channel

Keep the existing status vocabulary and add a separate typed terminal failure subscription:

```ts
type RealtimeFailure = {
  stage: 'ticket' | 'handshake' | 'socket'
  code: string
  message: string
  retryable: boolean
  strictRecoveryAllowed: boolean
  retryAfterMs?: number
  recoverableUntil?: number
}
```

Failure data contains fixed messages, stable codes, one policy boolean, and bounded in-memory timing metadata only. It never includes a URL, ticket, visitor token, frame, SDP, ICE content, or server exception text. `strictRecoveryAllowed` is computed only by the client state machine: it is true for an eligible transient failure in current `receiver` mode and false for sender, unstable `receiver-post-strict`, identity/configuration/rate/capacity, and unclassified WebSocket-handshake failures. `recoverableUntil` is a same-document monotonic value used by App and is never persisted or rendered.

Pre-ready `REALTIME_TICKET_INVALID` and server capacity failures are internal retryable handshake failures. `ORIGIN_NOT_ALLOWED` is terminal configuration failure. A ticket HTTP `VISITOR_NOT_FOUND` is terminal identity failure. Ticket-fetch network errors, HTTP 429, and retryable 5xx failures use the bounded retry policy. A ticket-capacity 503 uses its `Retry-After`; a constructor failure is terminal because retrying would only strand more unconsumed tickets. If WebSocket attempts exhaust without any authenticated fixed server frame, the client emits fixed `REALTIME_HANDSHAKE_UNAVAILABLE` with `strictRecoveryAllowed: false`: browser APIs cannot distinguish a pre-upgrade raw-capacity 503 from a network/TLS/proxy handshake failure, and strict room recovery cannot repair either. The client maps every failure to owned fixed copy.

For a response with `retryAfterMs`, the next delay is `max(configuredBackoff, retryAfterMs)`. The failed attempt still consumes one reconnect slot. If the effective delay reaches or crosses `realtimeRetryUntil`, the client terminalizes immediately instead of consuming the strict-recovery reserve.

Terminalization is one atomic path:

1. mark the generation terminal and detach/abort the current attempt;
2. publish the typed failure exactly once;
3. publish `closed` exactly once immediately afterward.

App's failure listener records the reason but performs no cleanup. Its `closed` listener consumes that reason and chooses active cleanup or permanent abandonment exactly once. If a failure listener calls `close`, that reentrant call is idempotent and cannot clear subscribers before the already-running terminalizer publishes `closed`; a socket close racing the server error is ignored by the same guard. Explicit user `close()` publishes no failure. A pre-ready handshake error never also reaches the ordinary message subscriber.

## 14. App Cleanup and Recovery

The current `disposeRoomResources` mixes active-resource cleanup with permanent room abandonment. Split the behavior without performing an unrelated App refactor.

### 14.1 Active connection disposal

After automatic retries become terminal, this path clears:

- room lifecycle and visibility listener;
- realtime client;
- PeerSession and subscriptions;
- live room reference;
- transfer dialogs, selections, progress, timers, abort controllers, Blob URLs, and speed presentation.

For a receiver transient failure that still has a live recovery deadline it preserves:

- visitor session;
- persisted receiver room session;
- receiver recovery intent;
- the information required by the existing recovery prompt.

During an internal reconnect attempt, App performs the smaller existing realtime-disconnected transition: it disposes PeerSession and transfer activity but keeps the current realtime client, lifecycle, and room reference. It does not invoke full active connection disposal until the retry sequence becomes terminal.

### 14.2 Permanent abandonment

This path additionally clears:

- persisted room recovery;
- receiver recovery intent;
- manual join intent and poller;
- owner invitation state;
- sender access-request UI state.

It is used for explicit leave/change-room, sender termination, expired/nonexistent room, invalid membership, invalid visitor identity, an elapsed recovery deadline, or a second realtime terminal failure after one successful strict receiver recovery.

Strict HTTP receiver recovery remains membership-bound. Admission maintenance runs before it, so an already expired/removed participant cannot be resurrected. When a still-valid receiver is in `connecting`, a successful recovery commit refreshes that participant's server attach deadline to `now + 15,000 ms`; an already-online participant remains online until the fresh ticket performs generation-safe socket replacement. This refresh happens only at the existing authenticated strict-recovery boundary and never creates membership.

### 14.3 User-visible outcomes

- During internal reconnect attempts, keep the room screen and show the existing reconnecting feedback without duplicate toasts.
- On a receiver failure, App uses only the client's `strictRecoveryAllowed` and `recoverableUntil`; it does not reproduce reconnect/stability timing. When allowed, App preserves the visitor and immediately uses the reserved final three seconds for one strict HTTP recovery. It does not wait for a user click or reset the old deadline before the HTTP boundary succeeds.
- A terminal ticket-rate, ticket-store-capacity, authenticated-Hub-capacity, or `REALTIME_HANDSHAKE_UNAVAILABLE` failure never enters strict HTTP recovery: that request cannot remove the future ticket/socket/network gate. App clears the current room recovery, preserves the visitor, and shows fixed rejoin copy.
- Ticket rate/store failures and strict-recovery HTTP 429 responses move `retryAfterMs` into a separate App-level monotonic `realtimeJoinCooldownUntil = max(existing, now + retryAfterMs)` before room cleanup; authenticated Hub capacity uses a fixed five-second cooldown when no server duration exists. This state is independent of `receiverRecoveryIntent` and contains no credentials. Only its wall-clock expiry is mirrored to exact, tab-scoped session storage so reload cannot create membership before the ticket gate reopens; load rejects malformed, expired, or more-than-60-seconds-future values and reconstructs a bounded monotonic deadline. Both copies clear at expiry.
- While that cooldown is live, both disabled presentation and a shared action guard block room creation, invitation join, manual-approval finalize, saved-room recovery, and recovery-prompt retry before any membership-mutating HTTP request. The UI uses fixed copy such as `实时服务繁忙，请在 n 秒后重试`. A still-live manual receipt/intent may finalize after the timer; an expired receipt returns to the manual form. Reload restores only this bounded cooldown hint, while the server ticket gate remains authoritative.
- Successful strict recovery refreshes TURN/ICE bootstrap and the server attach grace, then starts one `receiver-post-strict` realtime client with a fresh 10-second ready budget and no second strict-recovery reserve. Another terminal failure before five stable seconds reports `strictRecoveryAllowed: false` and permanently clears the current room recovery; after stability the client switches to normal receiver policy and reports eligibility correctly for a genuinely later disconnect.
- Every strict-recovery HTTP request accepts an `AbortSignal` and is covered by the active recovery deadline. If expiry wins, App aborts, advances its operation generation, and ignores any late success; if a valid success wins, App clears the deadline timer before adopting the bootstrap. If the automatic request itself fails transiently while the old deadline remains live, the existing lobby recovery prompt may offer a manual retry only until that deadline. Its in-memory intent contains `recoverableUntil`, optional `retryNotBeforeAt`, and whether automatic recovery was attempted.
- If the strict-recovery HTTP request itself returns 429, App first extends the independent join cooldown from the response duration. Both the prompt's disabled state and click handler also enforce `retryNotBeforeAt`. If that time reaches or exceeds `recoverableUntil`, no recovery action is offered, but the cooldown remains live until the reported server duration expires and continues to gate every new membership action.
- When the deadline expires, App cancels its timer/request, removes the prompt and persisted room session, preserves the visitor, and shows the fixed copy `连接恢复窗口已结束，请通过邀请链接或房间码重新加入`.
- Page startup still performs strict recovery immediately for a valid tab-scoped receiver room session. It starts a local 10-second HTTP recovery deadline before sending that request. The server remains authoritative: a missing/expired membership clears that saved session; a successful HTTP recovery receives a fresh attach grace and then a new 10-second ticket/readiness budget.
- `VISITOR_NOT_FOUND` clears visitor and room recovery, creates a fresh visitor, and does not offer invalid same-identity recovery.
- `ROOM_NOT_FOUND`, `ROOM_EXPIRED`, and `ROOM_MEMBERSHIP_REQUIRED` permanently clear room recovery.
- A sender still has no room recovery. Retry exhaustion ends the current sender room locally and lets server membership cleanup close it.
- Explicit leave, changing rooms, or unmount invalidates every outstanding attempt so an obsolete ticket cannot resurrect a room. Unmount releases active resources but preserves the receiver's tab-scoped persisted room session so refresh recovery continues to work.

No new modal is introduced. Existing lobby recovery presentation and toasts are reused with precise copy.

## 15. Maintenance and Capacity

`AppContext` gains `realtimeTickets`, `realtimeIngress`, and `realtimeSocketCapacity`. `createDefaultContext` constructs all three after visitors/rate limits and before Maintenance, passes tickets/ingress into Maintenance, and passes the same instances to realtime routes/Hub. The socket-capacity service needs no Maintenance dependency or timer; its single Context instance makes the raw lifecycle limit process-wide.

Maintenance gains the ticket service and realtime limiter as explicit dependencies:

- ticket expiry cleanup runs with the existing visitor/rate-key sweep;
- visitor removal deletes outstanding tickets and the visitor's realtime rate state before deleting the visitor;
- admission sweep can free expired tickets before ticket issuance or socket admission;
- runtime `start`/`stop` still owns only the existing shared timers;
- no ticket or rate-state timer is created per visitor.

Ticket service methods also enforce their own exact target expiry and pre-issuance cleanup so correctness does not depend on timer timing.

The existing capacities remain:

- 10,000 visitors;
- 20 receivers per room.

New capacities are:

- 512 pending/bound raw WebSocket lifecycle leases by default, configurable only from 33 through 1,024;
- 480 authenticated Hub sockets at the default, always derived 32 below the raw lease cap;
- 20,000 unconsumed tickets globally;
- 4 unconsumed tickets per visitor;
- at most one realtime rate record per live visitor.

## 16. Error Mapping

Stable new errors are:

| Boundary | Code | Behavior |
| --- | --- | --- |
| Ticket HTTP Origin | `ORIGIN_NOT_ALLOWED` | HTTP 403 |
| Ticket HTTP authentication | `VISITOR_NOT_FOUND` | HTTP 401 with the existing fixed body |
| Ticket HTTP rate | `RATE_LIMITED` | HTTP 429 plus `Retry-After` |
| Ticket store capacity | `CAPACITY_EXCEEDED` | HTTP 503 plus earliest-expiry `Retry-After` |
| Ticket generation/crypto | `REALTIME_TICKET_UNAVAILABLE` | HTTP 503 |
| WebSocket query shape | `INVALID_REQUEST` | fixed HTTP 422 before upgrade; ticket not consumed |
| Raw WebSocket lifecycle capacity | `CAPACITY_EXCEEDED` | fixed HTTP 503 before upgrade; ticket not consumed |
| WebSocket ticket | `REALTIME_TICKET_INVALID` | fixed realtime error, then close |
| WebSocket Origin | `ORIGIN_NOT_ALLOWED` | fixed realtime error, then close |
| Authenticated Hub capacity | `CAPACITY_EXCEEDED` | fixed realtime error, ticket consumed, then close |
| Ingress frame budget | `REALTIME_RATE_LIMITED` | first depleted-frame error, later drops |

Realtime body validation and message-parse failures retain the existing fixed `INVALID_REALTIME_MESSAGE`. Internal realtime failures retain `REALTIME_INTERNAL_ERROR`. None reflects request input.

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
- visitor-only, global-only, and simultaneously saturated capacity using `max(visitorReadyAt, globalReadyAt)` without leaking counts;
- expired cleanup before capacity;
- collision handling without overwrite;
- three failed generation attempts mapping to `REALTIME_TICKET_UNAVAILABLE`;
- visitor removal and index consistency.

### 17.3 Ticket route

Tests cover:

- success with allowed Origin and live bearer;
- no body and strict response validation;
- missing/disallowed Origin;
- invalid/missing bearer;
- IP and visitor rate limits using secret-free keys;
- integer-seconds `Retry-After` for rate and store capacity;
- store capacity mapping without count/identity leakage;
- CORS exposing `Retry-After` and no unrelated response header;
- global no-store/no-referrer headers on successes and every error;
- no token/ticket reflection.

### 17.4 Hub and WebSocket route

Unit/integration tests cover:

- valid ticket connection and `visitor:ready`;
- old `?token=`, missing, malformed, mixed, and additional query rejection before upgrade;
- valid ticket in a mixed query remaining unconsumed;
- invalid Origin not consuming a subsequently usable ticket;
- exact-format unknown/expired/replayed ticket uniformity;
- ticket consumption before capacity failure;
- replay leaving the current socket, online state, and rooms unchanged;
- visitor expiry between issue and consume;
- valid same-visitor replacement with a fresh ticket;
- shared Context/Maintenance/Hub limiter and raw-capacity identities without a construction cycle;
- pre-upgrade lease refusal returning HTTP 503 without consuming a valid ticket;
- successful `upgrade -> open/bind -> afterResponse/no-op -> close/release` ordering with exact once-only capacity accounting;
- raw invalid Upgrade forcing `server.upgrade === false -> afterResponse/releaseUnbound` with no `open`/`close`;
- route error plus after-response double release remaining idempotent and `beforeHandle` never reserving;
- invalid-Origin, invalid-ticket, Hub-rejected, replaced, and slow-closing sockets retaining their lifecycle lease until close;
- replacement overlap fitting only inside the 32-slot raw reserve without exceeding the lease cap;
- general and description bucket exact burst/refill boundaries, shared refill timestamp, and backward clock behavior;
- malformed frames consuming the general bucket;
- unknown/replaced sockets being silently dropped without allocating rate state;
- Elysia 1.4.29 real-runtime parser receiving the raw socket and resolving it through the route `WeakMap`;
- internal `DROP_NOTIFY` sending once from the message callback while external sentinel shapes are charged and silently discarded;
- attach, leave, ICE, offer, and answer all consuming general budget;
- socket replacement inheriting rate state;
- one rate error per depleted episode and half-capacity reset;
- rejected messages causing no touch, lookup, transition, or forwarding;
- rate state removal on visitor expiry;
- the existing 512 KiB inbound frame close;
- exact Bun backpressure configuration;
- `REALTIME_MAX_SOCKETS` boundaries 33/1,024, default 512, derived Hub default 480, and exact raw/authenticated rejection boundaries.

### 17.5 Web API and realtime client

Tests cover:

- exact ticket request headers/path/body, shared `ApiClientOptions.signal`, and `AbortSignal` propagation for ticket/recovery requests;
- ticket response validation and positive-delta-seconds `Retry-After` parsing/rejection/clamping;
- URL containing only `ticket`;
- no socket before ticket resolution;
- repeated `connect` not issuing in parallel;
- close/room change/attempt timeout aborting ticket resolution and producing no late socket;
- every reconnect using a distinct ticket;
- constructor failure discarding its ticket and terminalizing without another issuance;
- normal receiver mode issuing at most three possibly orphaned tickets and preserving the fourth service slot for the post-strict first attempt;
- sender four-unconfirmed-ticket exhaustion terminalizing as unavailable without a strict-recovery loop;
- post-strict first issuance consuming the reserved fourth slot and any further issuance receiving capacity `Retry-After`;
- browser `onopen` not emitting application `open`;
- current-socket post-`onopen` `visitor:ready` setting ready before synchronous `open`;
- early, duplicate, stale, malformed, and wrong-visitor readiness never completing authentication;
- pre-ready frames and handshake errors never reaching ordinary message subscribers;
- browser error/close races using one guarded attempt failure and never exposing event data;
- exhausted WebSocket handshakes without a fixed server frame mapping to `REALTIME_HANDSHAKE_UNAVAILABLE` and disallowing strict recovery;
- one three-second attempt timer covering ticket fetch through readiness;
- normal receiver epochs clipping two reconnects/`Retry-After` at seven seconds and preserving the final three-second strict-HTTP reserve;
- sender/post-strict epochs allowing three reconnects within the full 10-second realtime deadline;
- attach sent once and its boolean success checked before PeerSession work;
- no disconnected queue, pre-ready `send` returning false without side effects, and post-ready readyState/native-send failure entering the guarded retry path;
- retryable network/429/5xx behavior;
- terminal identity and Origin behavior;
- stable-ready reconnect budget reset;
- `receiver-post-strict` switching to normal receiver policy only after five stable seconds;
- `strictRecoveryAllowed` exact truth table across sender, receiver, post-strict unstable/stable, rate/capacity, identity, and unclassified handshake failure;
- old attempt events/failures ignored;
- abort rejection exiting silently even when a provider later resolves;
- exactly one `failure` followed by exactly one `closed`, including callback reentry and socket/error races;
- explicit close producing no failure;
- no secret material in emitted failure data.

### 17.6 App

App tests cover:

- create-room, invitation join, approved manual join, and receiver recovery all using the same ticket flow after successful HTTP bootstrap;
- no ticket request before bootstrap;
- reconnect clearing PeerSession but preserving receiver recovery;
- first receiver transient terminal failure immediately starting one strict HTTP recovery;
- ticket-rate, ticket-store-capacity, authenticated-Hub-capacity, and unclassified pre-upgrade/network handshake failures skipping strict recovery;
- strict recovery refreshing a connecting participant's 15-second attach deadline without resurrecting an expired participant;
- successful strict recovery refreshing TURN/bootstrap and starting one final 10-second realtime budget with zero reserve;
- a second realtime terminal failure before stability clearing room recovery, while five stable seconds restore eligibility for a later disconnect;
- retryable strict-HTTP failure showing the existing prompt only before `recoverableUntil`;
- strict-recovery HTTP timeout/unmount abort and ignored late completion;
- strict-recovery HTTP 429 extending the independent join cooldown while `retryNotBeforeAt` is enforced by both UI state and click handler;
- recovery expiry occurring before that 429 duration ends, clearing the old room recovery while every new membership action remains blocked until cooldown expiry;
- App-level realtime join cooldown surviving room cleanup, using max-deadline extension, blocking create/invite/manual-finalize/recovery in UI and handlers, and clearing at expiry;
- live manual receipts resuming after cooldown while expired receipts return to the form;
- exact tab-scoped cooldown persistence, malformed/expired/>60-second-future cleanup, reload restoration, and monotonic reconstruction;
- deadline expiry aborting work, clearing persisted room recovery, preserving the visitor, and showing the fixed rejoin copy;
- page startup starting its 10-second HTTP deadline before attempting saved receiver recovery and honoring the server result;
- `VISITOR_NOT_FOUND` clearing recovery and replacing the visitor;
- terminal room errors clearing recovery;
- sender retry exhaustion not showing receiver recovery;
- leave/change-room/unmount invalidating late ticket results;
- page unmount preserving tab-scoped receiver recovery for refresh;
- failure listener recording only and the subsequent closed listener performing one cleanup/toast;
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
- Bun remains pinned by `packageManager`, Elysia is pinned exactly to 1.4.29, and dependency upgrades must rerun the real-WebSocket adapter regression;
- proxy, WAF, CDN, APM, tracing, and exception reporting must omit or redact complete query strings;
- application logs must omit request URLs, Authorization, ticket responses, frames, SDP, and ICE;
- the gateway must enforce per-IP connection and WebSocket byte/throughput limits before the application;
- `REALTIME_MAX_SOCKETS` must be chosen from the documented memory formula, with process RSS/heap and coturn capacity monitoring.

Update API and Web READMEs to document the ticket flow, hard cut, Elysia parser boundary, rate behavior, slow-socket behavior, socket-memory formula, required gateway limits, and exact recovery semantics. The service worker does not change because API and WebSocket requests are already outside its static allowlist.

## 19. Acceptance Criteria

The milestone is complete only when:

1. No long-lived visitor token enters a WebSocket URL.
2. A ticket is 256-bit, expires after 30 seconds, is stored only by digest, and succeeds at most once.
3. Exact-format unknown, expired, and replayed tickets are externally indistinguishable; malformed query shapes fail before upgrade without consuming a valid ticket.
4. Invalid Origin cannot consume a ticket.
5. Replaying a ticket cannot replace a valid socket or mutate room state.
6. Old `?token=` and mixed query protocols are rejected.
7. After Elysia's pinned primitive decode, malformed and valid frames share a bounded general budget before body schema and Hub work; the earlier raw transport boundary is documented and enforced by payload and gateway limits.
8. Offer/answer work has its additional bounded budget.
9. Reconnect cannot reset an authenticated visitor's rate budget.
10. Rejected frames have zero business-state effects and do not amplify error responses.
11. Every socket has an explicit 512 KiB native outbound queue limit, slow sockets close automatically, and a pre-upgrade lease held through raw close bounds the default 512-slot process to 256 MiB of theoretical native queued payload.
12. The Web treats `visitor:ready` as authentication readiness and never queues disconnected signaling.
13. Every reconnect obtains a fresh ticket, and stale async work cannot resurrect an obsolete room.
14. Client-owned eligibility gives a receiver at most three pre-recovery ticket issuances, seven seconds of realtime retry, a reserved three-second strict-HTTP window, and the reserved fourth ticket slot for one final post-recovery client. Ticket/rate/authenticated-capacity/unclassified-handshake, expired, identity, and terminal room failures do not claim a recovery path that cannot succeed; any reported retry duration gates every new membership action at App level.
15. Ticket and visitor secrets are absent from storage, DOM, ordinary DTOs, errors, logs, and unrelated snapshots; focused ticket tests use deterministic non-production fixtures only where the ticket response itself is under test.
16. Focused tests, workspace verification, forced lint/test/typecheck/build, and diff checks all pass.

## 20. Explicitly Deferred

The next product/security milestones remain:

- invitation rotation and revocation;
- room locking and sender participant removal;
- application-layer authenticated encryption;
- an application-owned raw Bun WebSocket adapter or pre-JSON byte-rate gate beyond the required edge controls;
- resumable transfer, streaming-to-disk, and file digests;
- multi-instance shared room, ticket, rate, and signaling state.

Any future multi-instance deployment must move ticket issuance/consumption to shared storage with TTL and atomic get-and-delete semantics. This design intentionally targets the current bounded single-process runtime.
