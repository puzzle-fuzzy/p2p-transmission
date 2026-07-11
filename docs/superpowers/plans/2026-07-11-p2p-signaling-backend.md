# P2P Signaling Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first backend slice for visitor identity, room membership, and WebRTC signaling without storing or relaying file contents.

**Architecture:** The API service remains a Bun + Elysia app. Business state lives in small in-memory services with explicit TTL cleanup, while HTTP routes and WebSocket routes stay thin adapters around those services.

**Tech Stack:** Bun 1.3, Elysia, TypeScript, Bun test.

## Global Constraints

- The backend is a signaling server, not a file storage server.
- Text and files transfer peer-to-peer through browser WebRTC DataChannels in later frontend work.
- The server may relay metadata and WebRTC signaling messages only.
- Rooms are short-lived and stored in memory for MVP.
- A room has one sender and one or more receivers.
- Visitor identity is temporary: `visitorId`, `avatarSeed`, `displayName`, and `token`.

---

### Task 1: Service Models And Deterministic Core Behavior

**Files:**
- Create: `services/api/src/shared/ids.ts`
- Create: `services/api/src/shared/time.ts`
- Create: `services/api/src/modules/visitor/model.ts`
- Create: `services/api/src/modules/visitor/service.ts`
- Create: `services/api/src/modules/room/model.ts`
- Create: `services/api/src/modules/room/service.ts`
- Test: `services/api/src/modules/visitor/service.test.ts`
- Test: `services/api/src/modules/room/service.test.ts`
- Modify: `services/api/package.json`

**Interfaces:**
- Produces: `createVisitorService(options?: VisitorServiceOptions): VisitorService`
- Produces: `createRoomService(options?: RoomServiceOptions): RoomService`
- Produces: `RoomService.createRoom(senderToken: string): RoomResult`
- Produces: `RoomService.joinRoom(code: string, visitorToken: string, role?: ParticipantRole): RoomResult`

- [ ] Add Bun test scripts to `services/api/package.json`.
- [ ] Write visitor service tests that expect stable token lookup and public visitor shape.
- [ ] Run `bun test src/modules/visitor/service.test.ts` and confirm it fails because files do not exist.
- [ ] Implement visitor model and service.
- [ ] Run `bun test src/modules/visitor/service.test.ts` and confirm it passes.
- [ ] Write room service tests for create, join, sender uniqueness, missing room, bad token, and cleanup.
- [ ] Run `bun test src/modules/room/service.test.ts` and confirm it fails because room service does not exist.
- [ ] Implement room model and service.
- [ ] Run `bun test src/modules/room/service.test.ts` and confirm it passes.

### Task 2: HTTP App Routes

**Files:**
- Create: `services/api/src/app.ts`
- Create: `services/api/src/context.ts`
- Create: `services/api/src/modules/visitor/routes.ts`
- Create: `services/api/src/modules/room/routes.ts`
- Test: `services/api/src/app.test.ts`
- Modify: `services/api/src/index.ts`

**Interfaces:**
- Consumes: `VisitorService`
- Consumes: `RoomService`
- Produces: `createApp(context?: Partial<AppContext>): Elysia`

- [ ] Write route tests for `GET /health`, `POST /v1/visitors`, `POST /v1/rooms`, `POST /v1/rooms/:code/join`, and `GET /v1/rooms/:code`.
- [ ] Run `bun test src/app.test.ts` and confirm it fails because `createApp` does not exist.
- [ ] Implement `AppContext`, route modules, and `createApp`.
- [ ] Update `src/index.ts` to listen through `createApp`.
- [ ] Run `bun test src/app.test.ts` and confirm it passes.

### Task 3: WebSocket Signaling Hub

**Files:**
- Create: `services/api/src/modules/realtime/model.ts`
- Create: `services/api/src/modules/realtime/hub.ts`
- Create: `services/api/src/modules/realtime/routes.ts`
- Test: `services/api/src/modules/realtime/hub.test.ts`
- Modify: `services/api/src/app.ts`

**Interfaces:**
- Consumes: `VisitorService`
- Consumes: `RoomService`
- Produces: `createRealtimeHub(context: AppContext): RealtimeHub`
- Produces: `RealtimeHub.connect(socket: RealtimeSocket, token: string): RealtimeConnectionResult`
- Produces: `RealtimeHub.handleMessage(socketId: string, message: ClientRealtimeMessage): void`
- Produces: `RealtimeHub.disconnect(socketId: string): void`

- [ ] Write hub tests for auth failure, room join broadcast, direct signal forwarding, and participant leave broadcast.
- [ ] Run `bun test src/modules/realtime/hub.test.ts` and confirm it fails because hub does not exist.
- [ ] Implement realtime message models and hub.
- [ ] Implement Elysia WebSocket route `/v1/realtime`.
- [ ] Run `bun test src/modules/realtime/hub.test.ts` and confirm it passes.

### Task 4: Verification And API Notes

**Files:**
- Modify: `services/api/README.md`

**Interfaces:**
- Consumes: all routes and services from Tasks 1-3.

- [ ] Document visitor, room, and WebSocket message contracts in `services/api/README.md`.
- [ ] Run `bun test`.
- [ ] Run `bun run typecheck`.
- [ ] Run the API locally with `bun run dev` long enough to hit `GET /health`.
