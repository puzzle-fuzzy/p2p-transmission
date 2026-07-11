# Web Room Realtime Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the React frontend to the Elysia signaling backend so users receive a visitor identity, create or join rooms, and see live room participants before WebRTC transfer work begins.

**Architecture:** Keep API and realtime networking in small typed client modules, keep room/session state in a pure reducer, and keep React components focused on rendering and user interaction. This phase stops at room membership and WebSocket signaling readiness; it does not implement WebRTC DataChannels or actual file transfer.

**Tech Stack:** React 19, Vite 8, TypeScript 6, Tailwind 4, Elysia API at `services/api`, Vitest for frontend pure/client tests.

## Global Constraints

- The backend is a signaling server, not a file storage server.
- Text and files transfer peer-to-peer through browser WebRTC DataChannels in a later phase.
- The server may relay metadata and WebRTC signaling messages only.
- A room has one sender and one or more receivers.
- Visitor identity is temporary: `visitorId`, `avatarSeed`, `displayName`, and `token`.
- UI stays fast, minimal, and reliable: no account flow, no storage UI, no decorative feature copy.
- Preserve the current dark, restrained design system in `DESIGN.md`.
- Do not stage or commit unrelated existing workspace changes; `apps/web/vite.config.ts` currently has an unstaged dev port change that must be explicitly kept or reverted before the implementation commit.

---

## File Structure

- `apps/web/src/shared/contracts.ts`: Shared frontend copies of backend HTTP and realtime contract types.
- `apps/web/src/lib/config.ts`: Runtime API and WebSocket base URL helpers.
- `apps/web/src/lib/api-client.ts`: Typed HTTP wrapper for visitor and room endpoints.
- `apps/web/src/lib/visitor-session.ts`: LocalStorage-backed visitor session read/write/clear helpers.
- `apps/web/src/lib/realtime-client.ts`: Small WebSocket client wrapper with typed send and event subscription.
- `apps/web/src/features/room/state.ts`: Pure room app state reducer and actions.
- `apps/web/src/features/room/state.test.ts`: Vitest reducer tests.
- `apps/web/src/lib/api-client.test.ts`: Vitest tests for request shape and error mapping.
- `apps/web/src/lib/visitor-session.test.ts`: Vitest tests for persistence behavior.
- `apps/web/src/lib/realtime-client.test.ts`: Vitest tests using a fake WebSocket implementation.
- `apps/web/src/App.tsx`: Bootstraps visitor session, room actions, WebSocket lifecycle, and screen state.
- `apps/web/src/components/RoomJoin.tsx`: Converts static UI into controlled create/join form.
- `apps/web/src/components/TransferPanel.tsx`: Accepts visitor/room/participants props and disables transfer until room is realtime-ready.
- `apps/web/src/components/Avatar.tsx`: Renders deterministic visitor avatar from `avatarSeed` instead of the Vite asset.

---

### Task 1: Frontend Test Harness And Config

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/package-lock.json`
- Create: `apps/web/src/lib/config.ts`

**Interfaces:**
- Produces: `getApiBaseUrl(): string`
- Produces: `getRealtimeUrl(token: string): string`

- [ ] **Step 1: Add Vitest**

Run:

```bash
cd apps/web
npm install -D vitest
```

Then add this script:

```json
{
  "scripts": {
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Create runtime config**

Create `apps/web/src/lib/config.ts`:

```ts
const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '')

export const getApiBaseUrl = () =>
  trimTrailingSlash(import.meta.env.VITE_API_URL ?? 'http://localhost:3000')

export const getRealtimeUrl = (token: string) => {
  const baseUrl = new URL(getApiBaseUrl())
  baseUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  baseUrl.pathname = '/v1/realtime'
  baseUrl.search = new URLSearchParams({ token }).toString()

  return baseUrl.toString()
}
```

- [ ] **Step 3: Verify harness**

Run:

```bash
cd apps/web
npm run test -- --passWithNoTests
npm run build
npm run lint
```

Expected: test runner starts, build passes, lint passes.

---

### Task 2: API Contracts, HTTP Client, And Visitor Session

**Files:**
- Create: `apps/web/src/shared/contracts.ts`
- Create: `apps/web/src/lib/api-client.ts`
- Create: `apps/web/src/lib/api-client.test.ts`
- Create: `apps/web/src/lib/visitor-session.ts`
- Create: `apps/web/src/lib/visitor-session.test.ts`

**Interfaces:**
- Consumes: `getApiBaseUrl()`
- Produces: `createVisitor(): Promise<VisitorSession>`
- Produces: `createRoom(token: string): Promise<PublicRoom>`
- Produces: `joinRoom(code: string, token: string, role?: ParticipantRole): Promise<PublicRoom>`
- Produces: `getRoom(code: string): Promise<PublicRoom>`
- Produces: `loadVisitorSession(storage?: StorageLike): VisitorSession | undefined`
- Produces: `saveVisitorSession(session: VisitorSession, storage?: StorageLike): void`
- Produces: `clearVisitorSession(storage?: StorageLike): void`

- [ ] **Step 1: Write failing HTTP client tests**

Create `apps/web/src/lib/api-client.test.ts` covering:

```ts
import { describe, expect, test, vi } from 'vitest'
import { createVisitor, createRoom, joinRoom, getRoom } from './api-client'

describe('api-client', () => {
  test('creates a visitor from POST /v1/visitors', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      visitor: { id: 'vis_1', avatarSeed: 'seed_1', displayName: '访客 0001', createdAt: 1, lastSeenAt: 1 },
      token: 'tok_1',
    })))
    const result = await createVisitor({ fetch: fetchMock, apiBaseUrl: 'http://api.test' })
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/v1/visitors', { method: 'POST' })
    expect(result.token).toBe('tok_1')
  })

  test('sends bearer token when creating and joining rooms', async () => {
    const room = { code: '123456', senderId: 'vis_1', receivers: [], participants: [], createdAt: 1, expiresAt: 2 }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ room })))
    await createRoom('tok_1', { fetch: fetchMock, apiBaseUrl: 'http://api.test' })
    await joinRoom('123456', 'tok_2', 'receiver', { fetch: fetchMock, apiBaseUrl: 'http://api.test' })
    await getRoom('123456', { fetch: fetchMock, apiBaseUrl: 'http://api.test' })
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://api.test/v1/rooms', {
      method: 'POST',
      headers: { authorization: 'Bearer tok_1' },
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://api.test/v1/rooms/123456/join', {
      method: 'POST',
      headers: { authorization: 'Bearer tok_2', 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'receiver' }),
    })
  })
})
```

Run:

```bash
cd apps/web
npm run test -- src/lib/api-client.test.ts
```

Expected: fails because `api-client.ts` does not exist.

- [ ] **Step 2: Implement contracts and HTTP client**

Create `contracts.ts` with `PublicVisitor`, `VisitorSession`, `ParticipantRole`, `PublicParticipant`, `PublicRoom`, `ApiError`, `ClientRealtimeMessage`, and `ServerRealtimeMessage` matching `services/api/README.md`.

Create `api-client.ts` with fetch injection support:

```ts
export type ApiClientOptions = {
  fetch?: typeof fetch
  apiBaseUrl?: string
}
```

Map non-2xx responses to `Error` messages from `{ error: { code, message } }`.

- [ ] **Step 3: Write and pass visitor session tests**

Create `visitor-session.test.ts` using an in-memory `StorageLike` object. Test valid load, malformed JSON returning `undefined`, save, and clear.

Run:

```bash
cd apps/web
npm run test -- src/lib/api-client.test.ts src/lib/visitor-session.test.ts
```

Expected: all tests pass.

---

### Task 3: Realtime Client

**Files:**
- Create: `apps/web/src/lib/realtime-client.ts`
- Create: `apps/web/src/lib/realtime-client.test.ts`

**Interfaces:**
- Consumes: `getRealtimeUrl(token: string)`
- Consumes: `ClientRealtimeMessage`
- Produces: `createRealtimeClient(options: RealtimeClientOptions): RealtimeClient`
- Produces: `RealtimeClient.connect(): void`
- Produces: `RealtimeClient.send(message: ClientRealtimeMessage): void`
- Produces: `RealtimeClient.close(): void`
- Produces: `RealtimeClient.subscribe(listener: (message: ServerRealtimeMessage) => void): () => void`

- [ ] **Step 1: Write failing realtime client tests**

Use a fake WebSocket class that records `url`, sent strings, and exposes `emitMessage(data: unknown)`.

Tests must verify:
- connect creates WebSocket with `/v1/realtime?token=...`
- `send()` JSON-stringifies typed messages
- incoming JSON is parsed and delivered to subscribers
- unsubscribe stops delivery
- invalid incoming JSON emits `{ type: 'error', code: 'CLIENT_PARSE_ERROR', message: '无法解析实时消息' }`

Run:

```bash
cd apps/web
npm run test -- src/lib/realtime-client.test.ts
```

Expected: fails because `realtime-client.ts` does not exist.

- [ ] **Step 2: Implement realtime client**

Implementation rules:
- Do not reconnect automatically in this task.
- Do not implement WebRTC signaling behavior here; this client only transports typed messages.
- Keep the WebSocket constructor injectable for tests:

```ts
type WebSocketConstructor = new (url: string) => WebSocket
```

- [ ] **Step 3: Verify**

Run:

```bash
cd apps/web
npm run test -- src/lib/realtime-client.test.ts
npm run build
```

Expected: realtime tests pass and TypeScript build passes.

---

### Task 4: Room Flow State Machine

**Files:**
- Create: `apps/web/src/features/room/state.ts`
- Create: `apps/web/src/features/room/state.test.ts`

**Interfaces:**
- Consumes: `VisitorSession`, `PublicRoom`, `ServerRealtimeMessage`
- Produces: `RoomFlowState`
- Produces: `RoomFlowAction`
- Produces: `initialRoomFlowState: RoomFlowState`
- Produces: `roomFlowReducer(state: RoomFlowState, action: RoomFlowAction): RoomFlowState`

- [ ] **Step 1: Write failing reducer tests**

Test these transitions:
- `visitor:ready` moves from `booting` to `lobby`
- `room:created` moves to `room` with role `sender`
- `room:joined` moves to `room` with role `receiver`
- `realtime:connected` updates status to `connecting`
- `room:participants` updates participants and marks `ready` when at least two participants exist
- `participant:left` removes a participant and marks room not ready when only one participant remains
- `error` stores a visible error string

Run:

```bash
cd apps/web
npm run test -- src/features/room/state.test.ts
```

Expected: fails because `state.ts` does not exist.

- [ ] **Step 2: Implement reducer**

Use this phase union:

```ts
type RoomPhase = 'booting' | 'lobby' | 'joining' | 'room' | 'connecting' | 'ready' | 'error'
```

Keep all user-facing error text in state as short Chinese strings.

- [ ] **Step 3: Verify**

Run:

```bash
cd apps/web
npm run test -- src/features/room/state.test.ts
```

Expected: reducer tests pass.

---

### Task 5: React UI Integration

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/RoomJoin.tsx`
- Modify: `apps/web/src/components/TransferPanel.tsx`
- Modify: `apps/web/src/components/Avatar.tsx`
- Modify: `apps/web/src/components/Loading.tsx` if needed

**Interfaces:**
- Consumes: `createVisitor`, `createRoom`, `joinRoom`, `loadVisitorSession`, `saveVisitorSession`, `createRealtimeClient`, `roomFlowReducer`
- Produces: usable screen flow for booting, lobby, room connecting, and ready.

- [ ] **Step 1: Convert `RoomJoin` to controlled actions**

`RoomJoin` props:

```ts
type RoomJoinProps = {
  busy?: boolean
  error?: string
  onCreateRoom(): void
  onJoinRoom(code: string): void
}
```

Preserve the six input boxes and paste distribution behavior. The join button is disabled unless six digits are present.

- [ ] **Step 2: Make `Avatar` deterministic**

`Avatar` props:

```ts
type AvatarProps = {
  seed: string
  label?: string
}
```

Render a simple circular avatar using deterministic initials/color from seed. Do not use network images.

- [ ] **Step 3: Add room context to `TransferPanel`**

`TransferPanel` props:

```ts
type TransferPanelProps = {
  visitor: PublicVisitor
  room: PublicRoom
  realtimeReady: boolean
}
```

Show the local avatar and a compact participant count/status near the existing top row. Keep transfer button disabled until `realtimeReady` is true.

- [ ] **Step 4: Wire `App`**

On mount:
- Load visitor session from LocalStorage.
- If missing, call `POST /v1/visitors`, save session, dispatch visitor ready.
- Render `Loading` while booting.

On create:
- Call `POST /v1/rooms`.
- Open realtime client.
- Send `room:join` as sender.

On join:
- Call `POST /v1/rooms/:code/join`.
- Open realtime client.
- Send `room:join` as receiver.

On realtime message:
- Dispatch `room:participants`, `participant:left`, and `error`.

- [ ] **Step 5: Verify frontend behavior**

Run:

```bash
cd apps/web
npm run test
npm run build
npm run lint
```

Expected: tests, build, and lint pass.

---

### Task 6: Local Two-Browser Verification

**Files:**
- Modify: `services/api/README.md` only if a useful frontend setup note is discovered.

**Interfaces:**
- Consumes: API server and web dev server.

- [ ] **Step 1: Start API**

Run:

```bash
cd services/api
PORT=3000 bun run dev
```

Expected: `Elysia is running at localhost:3000`.

- [ ] **Step 2: Start web**

Run:

```bash
cd apps/web
npm run dev
```

Expected: Vite local URL appears. If `apps/web/vite.config.ts` strict port change is kept, the URL should be `http://localhost:5713/`.

- [ ] **Step 3: Manual flow**

Open two browser windows:
- Window A enters the site and creates a room.
- Window A displays a six-digit room code and sender status.
- Window B enters the site and joins with that code.
- Both windows show two participants.
- Transfer panel becomes enabled only after realtime participant sync.
- Close Window B and confirm Window A reflects the participant leaving.

- [ ] **Step 4: Final verification**

Run:

```bash
cd services/api
bun test
bun run typecheck
cd ../../apps/web
npm run test
npm run build
npm run lint
```

Expected: all commands pass.

---

## Commit Boundary

Commit after Tasks 1-4 if all tests pass:

```bash
git add apps/web/package.json apps/web/package-lock.json apps/web/src/lib apps/web/src/shared apps/web/src/features
git commit -m "feat: add web room clients"
```

Commit after Tasks 5-6:

```bash
git add apps/web/src/App.tsx apps/web/src/components services/api/README.md
git commit -m "feat: connect web room flow"
```

Do not include unrelated `apps/web/vite.config.ts` unless explicitly deciding to keep the strict dev port as part of the web integration.
