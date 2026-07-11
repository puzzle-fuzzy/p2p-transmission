# WebRTC Text Transfer Design

## Objective

Complete the first real end-to-end transfer slice: one sender creates a room, one or more receivers join, the browsers establish WebRTC DataChannels, and the sender can offer a text transfer that every receiver explicitly accepts or rejects before the text body is sent.

This milestone replaces the current mock text transfer. File bytes, TURN deployment, resumable transfers, and production deployment remain outside this scope.

## Product Constraints

- The signaling server must never receive or relay transferred text.
- A receiver must explicitly choose `接收` or `拒绝` before the sender transmits the text body to that receiver.
- One sender may offer the same text to multiple connected receivers; every receiver decides independently.
- Only the room sender may initiate a transfer in this milestone.
- The UI keeps the current restrained dark workbench aesthetic: flat surfaces, faint warm-white borders, Signal Purple primary action, red only for errors, no decorative shadows.
- The transfer action becomes ready only when at least one DataChannel is open. Room participant count alone is not a connection-ready signal.
- File transfer remains visible as the next capability but must not simulate success or imply that bytes were transferred.

## Chosen Approach

Use the existing WebSocket channel only for `offer`, `answer`, and ICE candidate signaling. Use each peer's WebRTC DataChannel for transfer requests, receiver decisions, the accepted text body, and delivery acknowledgement.

This is preferred over WebSocket transfer negotiation because it keeps all transfer-specific data between browsers. It is preferred over sending the text immediately and asking afterward because acceptance must happen before content delivery.

## Architecture

### Shared wire contracts

Move browser/server signaling DTOs into `packages/contracts`. The shared package contains platform-neutral public visitor, room, and realtime message types plus the DataChannel protocol parser. It must not import DOM types, React, Elysia, storage, or other IO.

WebRTC descriptions and candidates cross the signaling boundary as explicit serializable DTOs. Every offer, answer, and ICE message carries a `peerSessionId`, so late messages from a replaced connection cannot mutate the current peer.

### Signaling authorization

The API realtime hub will validate that:

- the signaling socket has joined the referenced room;
- the target visitor is a current participant in that room;
- the sender is not targeting itself;
- only the room sender can send offers and only a receiver can answer the sender;
- transfer metadata messages cannot be injected by non-members.

Invalid messages return stable realtime error codes and are not forwarded.

### Browser peer session

A framework-independent `PeerSession` service owns one `RTCPeerConnection` per remote visitor.

- The room sender is always the offerer.
- The sender creates one ordered DataChannel named `p2p-transfer` per receiver.
- The channel protocol is `p2p-transfer.v1`; channels with another label or protocol are closed.
- The receiver creates its peer when an offer arrives and adopts the channel through `ondatachannel`.
- ICE candidates received before `remoteDescription` are queued and flushed afterward.
- Offers create a fresh `peerSessionId`; answers, ICE, callbacks, and queued candidates with an older ID are ignored.
- Removed room participants have their channel and peer connection closed immediately.
- A peer is considered ready only while its DataChannel state is `open`.
- The service exposes events rather than importing React, so protocol and lifecycle behavior can be unit tested with fake WebRTC objects.

The first implementation uses configurable STUN URLs with a public STUN default. TURN credentials and relay policy are deliberately deferred.

### DataChannel protocol

Every message is UTF-8 JSON with `v: 1` and must pass runtime shape validation before it affects UI state. Transfer IDs, frame size, field lengths, character count, and UTF-8 byte count are bounded and checked.

```ts
type TextTransferRequest = {
  v: 1
  type: 'transfer:request'
  transferId: string
  kind: 'text'
  characterCount: number
  byteLength: number
}

type TextTransferDecision = {
  v: 1
  type: 'transfer:decision'
  transferId: string
  decision: 'accept' | 'reject'
}

type TextTransferPayload = {
  v: 1
  type: 'transfer:text'
  transferId: string
  text: string
}

type TextTransferReceipt = {
  v: 1
  type: 'transfer:receipt'
  transferId: string
  status: 'received'
}

type TextTransferCancel = {
  v: 1
  type: 'transfer:cancel'
  transferId: string
}

type TextTransferError = {
  v: 1
  type: 'transfer:error'
  transferId: string
  code: 'INVALID_STATE' | 'CONTENT_MISMATCH' | 'CONTENT_TOO_LARGE'
}
```

Sender flow:

1. Create a transfer ID and retain the text in sender memory.
2. Send `transfer:request` to every open receiver channel.
3. On `accept`, send `transfer:text` only to that peer.
4. On `reject`, mark only that peer rejected and do not send the text.
5. On `transfer:receipt`, report successful delivery for that peer.
6. Expire unanswered requests after 30 seconds and send `transfer:cancel`; late decisions cannot send the text.

Receiver flow:

1. Validate `transfer:request` and present the confirmation dialog.
2. `拒绝` sends a reject decision and removes the pending request.
3. `接收` sends an accept decision and changes the dialog to a waiting state.
4. A matching `transfer:text` becomes the received-text view and triggers a receipt.
5. Payloads with unknown, rejected, or mismatched transfer IDs are ignored and surfaced as protocol errors.
6. Accepted requests expire if no payload arrives within 15 seconds.

The text limit remains 500 characters for this milestone. The UTF-8 byte length is computed with `TextEncoder` rather than inferred from JavaScript string length.

## Frontend State And Components

### App orchestration

`App` continues to own visitor, room, and realtime lifecycle. It creates one `PeerSession` after HTTP room creation or join, forwards server signaling messages to it, and synchronizes peers whenever room participants change.

Realtime readiness and transfer readiness are separate:

- WebSocket status describes signaling availability.
- Open DataChannel count controls the sender's transfer button.
- A receiver can remain in a waiting screen while the peer negotiates.

An expired locally stored visitor token is replaced once when a room operation returns `VISITOR_NOT_FOUND`; the requested room action is then retried with the fresh session.

### Sender panel

The sender retains the existing text composer. Pressing `传输` calls `PeerSession.offerText(text)` instead of a timer. The action label reflects the number of open receivers. File UI is explicitly marked as unavailable in this milestone and contains no mock progress.

Sender feedback uses the existing toast system for request sent, receiver rejected, delivery confirmed, signaling failure, and peer disconnection.

### Receiver waiting state

Receivers do not see an editable sender composer. They see a compact status panel containing the room code, sender identity when available, and one of: connecting, ready and waiting, receiving, or last transfer received.

### Receive confirmation dialog

The new `ReceiveTextDialog` uses the native `dialog` top layer and behaves as a real accessible modal:

- a full-viewport translucent charcoal scrim;
- a flat `#2d2d2d` panel with a faint warm-white border and 12px radius;
- sender avatar, sender display name, text character/byte summary, and a short privacy note;
- secondary `拒绝` and Signal Purple primary `接收` actions;
- initial focus on `拒绝` to prevent accidental acceptance, native Tab focus containment, and Escape equivalent to reject while a decision is pending;
- `role="dialog"`, `aria-modal="true"`, labelled title and description;
- responsive width using viewport padding instead of fixed desktop width;
- reduced-motion-safe opacity and scale transition.

After acceptance, the same modal shows `正在接收…`. After payload arrival it closes and the receiver panel switches to a read-only `收到的文本` surface with `复制文本` and `完成` actions.

Only one incoming request is presented at a time. Additional requests are queued in arrival order.

## Failure Handling

- WebSocket close/error updates signaling status and attempts bounded reconnect with exponential delay while the room view is active.
- DataChannel or peer failure removes that peer from the ready count and rejects its outstanding sender-side transfer state.
- Malformed DataChannel JSON never reaches React state; the peer session emits a stable `PROTOCOL_ERROR` event.
- A receiver acceptance waits for a matching payload. If the peer closes first, the dialog becomes an understandable failure state with a close action.
- Transfer request and payload timers are cleared on every terminal state; late accept, payload, receipt, or timeout events are idempotently ignored.
- A stale visitor session is regenerated once, avoiding an infinite retry loop.
- Component unmount closes timers, WebSocket subscriptions, DataChannels, and peer connections.

## Test Strategy

### API

- A room member can signal another participant.
- A non-member cannot target a room participant.
- A participant cannot target a visitor outside the room.
- A receiver cannot send an offer, a sender cannot send an answer, and nobody can signal itself.
- `peerSessionId` is validated and forwarded unchanged.
- Disconnecting a superseded socket cannot remove the visitor's current socket mapping.

### Web unit tests

- Protocol parser accepts every valid message and rejects malformed JSON and invalid shapes.
- Protocol parser rejects unknown versions, oversized frames, mismatched counts, overlong IDs, and payloads over 500 characters.
- Peer session follows offer/answer/ICE order, queues early ICE, reports channel readiness, and closes removed peers.
- Old `peerSessionId` answer, ICE, DataChannel, and callback events cannot update a replacement peer.
- Text request is sent to all ready receivers.
- Text payload is sent only after that receiver accepts.
- Reject, receipt, cancel, timeout, malformed payload, and peer-close paths emit deterministic events.
- Existing room reducer tests are updated so participant count no longer means DataChannel readiness.

### Component tests

Component behavior will remain thin enough to cover through state/service tests in this milestone. Manual browser verification covers focus, Escape, responsive layout, copy action, and visual alignment.

### End-to-end acceptance

Using two independent browser sessions:

1. Sender creates a room and receiver joins.
2. Both report a WebRTC connection; sender transfer action becomes enabled.
3. Sender offers text; receiver sees the modal before the sender sends the payload.
4. Reject leaves the receiver without the text and informs the sender.
5. A second offer accepted by the receiver displays the exact original text.
6. Copy places the exact text on the clipboard.
7. Closing the receiver session returns the sender to a waiting state.

## Deferred Work

- File metadata, chunking, backpressure, hashing, cancellation, download, and resume.
- TURN credentials, relay fallback, and production NAT success telemetry.
- Persistent rooms or horizontal API scaling.
- Automated multi-context Playwright coverage; manual two-session verification is required for this milestone.
