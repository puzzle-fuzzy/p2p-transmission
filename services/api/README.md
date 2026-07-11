# P2P Transmission API

This service is the signaling backend for the P2P Transmission web app. It does not store or relay text or file contents. The backend only creates temporary visitors, manages short-lived rooms, and forwards WebRTC signaling messages.

## Development

```bash
bun install
bun run dev
```

The server listens on `PORT` or `3000`.

```bash
bun test
bun run typecheck
```

## HTTP API

### `GET /health`

Returns:

```json
{ "ok": true }
```

### `POST /v1/visitors`

Creates a temporary visitor when the user enters the page.

Returns:

```json
{
  "visitor": {
    "id": "vis_xxx",
    "avatarSeed": "avatar_xxx",
    "displayName": "访客 1234",
    "createdAt": 1760000000000,
    "lastSeenAt": 1760000000000
  },
  "token": "tok_xxx"
}
```

Store `token` locally and send it as `Authorization: Bearer <token>` for room requests.

### `POST /v1/rooms`

Creates a room. The authenticated visitor becomes the sender.

Headers:

```http
Authorization: Bearer tok_xxx
```

Returns:

```json
{
  "room": {
    "code": "345678",
    "senderId": "vis_xxx",
    "receivers": [],
    "participants": [],
    "createdAt": 1760000000000,
    "expiresAt": 1760001800000
  }
}
```

### `POST /v1/rooms/:code/join`

Joins an existing room. Receivers are the default role.

Headers:

```http
Authorization: Bearer tok_xxx
Content-Type: application/json
```

Body:

```json
{ "role": "receiver" }
```

### `GET /v1/rooms/:code`

Reads public room state. This is useful before opening a WebSocket.

## WebSocket API

Connect to:

```txt
ws://localhost:3000/v1/realtime?token=tok_xxx
```

Client messages:

```ts
type ClientRealtimeMessage =
  | { type: "room:join"; roomCode: string; role: "sender" | "receiver" }
  | { type: "room:leave"; roomCode: string }
  | { type: "signal:offer"; roomCode: string; to: string; sdp: unknown }
  | { type: "signal:answer"; roomCode: string; to: string; sdp: unknown }
  | { type: "signal:ice"; roomCode: string; to: string; candidate: unknown }
  | { type: "transfer:prepare"; roomCode: string; items: TransferItem[] }
  | { type: "transfer:state"; roomCode: string; state: "ready" | "transferring" | "done" | "error" }
```

Server messages:

```ts
type ServerRealtimeMessage =
  | { type: "visitor:ready"; visitor: PublicVisitor }
  | { type: "room:participants"; room: PublicRoom }
  | { type: "participant:left"; roomCode: string; visitorId: string }
  | { type: "signal:offer"; roomCode: string; from: string; sdp: unknown }
  | { type: "signal:answer"; roomCode: string; from: string; sdp: unknown }
  | { type: "signal:ice"; roomCode: string; from: string; candidate: unknown }
  | { type: "transfer:prepare"; roomCode: string; from: string; items: TransferItem[] }
  | { type: "transfer:state"; roomCode: string; from: string; state: "ready" | "transferring" | "done" | "error" }
  | { type: "error"; code: string; message: string }
```

## Error Codes

- `VISITOR_NOT_FOUND`: token is missing, invalid, or expired.
- `ROOM_NOT_FOUND`: room does not exist or has expired.
- `ROOM_SENDER_EXISTS`: attempted to join as sender when the room already has one.
