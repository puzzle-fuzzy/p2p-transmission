import { describe, expect, test } from "bun:test";
import type { ApiConfig } from "./config";
import type { AppContext } from "./context";
import { createApp } from "./app";
import { createMaintenanceService } from "./modules/maintenance/service";
import { createRateLimitService } from "./modules/rate-limit/service";
import { createRoomAccessService } from "./modules/room-access/service";
import { createRoomBootstrapService } from "./modules/room/bootstrap";
import { createRoomService } from "./modules/room/service";
import { createTurnService } from "./modules/turn/service";
import { createVisitorService } from "./modules/visitor/service";
import { createNodeRoomInviteCrypto } from "./shared/room-invite-crypto";

type HarnessOptions = {
  maxRooms?: number;
  maxReceivers?: number;
  maxVisitors?: number;
  turnConfigured?: boolean;
};

const createTestHarness = ({
  maxRooms,
  maxReceivers,
  maxVisitors,
  turnConfigured = true,
}: HarnessOptions = {}) => {
  let timestamp = 1_000;
  let visitorIndex = 0;
  let roomIndex = 0;
  const config: ApiConfig = {
    port: 3000,
    stunUrls: ["stun:stun.example.com:3478"],
    ...(turnConfigured
      ? {
          turn: {
            urls: ["turn:turn.example.com:3478"],
            sharedSecret: "0123456789abcdef0123456789abcdef",
            credentialGraceMs: 300_000,
          },
        }
      : {}),
    corsAllowedOrigins: ["http://localhost:5713"],
    trustProxy: false,
    trustedProxyIps: new Set(),
  };
  const visitors = createVisitorService({
    now: () => timestamp,
    maxVisitors,
    createId: () => `vis_${String(++visitorIndex).padStart(3, "0")}`,
    createToken: () => `tok_${String(visitorIndex).padStart(3, "0")}`,
    createAvatarSeed: () => `avatar_${String(visitorIndex).padStart(3, "0")}`,
  });
  const rooms = createRoomService({
    visitors,
    inviteCrypto: createNodeRoomInviteCrypto(),
    now: () => timestamp,
    maxRooms,
    maxReceivers,
    createCode: () => String(234_560 + ++roomIndex),
    createPlanId: () => `plan_${String(roomIndex)}_${crypto.randomUUID()}`,
  });
  const roomAccess = createRoomAccessService({
    rooms,
    visitors,
    now: () => timestamp,
  });
  const rateLimits = createRateLimitService({ now: () => timestamp });
  const turn = createTurnService(config, { now: () => timestamp });
  const maintenance = createMaintenanceService({
    rooms,
    roomAccess,
    visitors,
    rateLimits,
  });
  const roomBootstrap = createRoomBootstrapService({
    maintenance,
    visitors,
    rooms,
    roomAccess,
    rateLimits,
    turn,
  });
  const context: AppContext = {
    config,
    visitors,
    rooms,
    roomAccess,
    rateLimits,
    turn,
    maintenance,
    roomBootstrap,
    clientIp: { resolve: () => "203.0.113.10" },
  };
  return {
    app: createApp(context),
    context,
    advanceTime: (milliseconds: number) => {
      timestamp += milliseconds;
    },
  };
};

const json = async <T>(response: Response) => response.json() as Promise<T>;

const createVisitor = async (app: ReturnType<typeof createApp>) => {
  const response = await app.handle(new Request("http://api.test/v1/visitors", {
    method: "POST",
  }));
  return json<{ visitor: { id: string }; token: string }>(response);
};

const roomRequest = (
  token: string,
  body?: unknown,
) => new Request("http://api.test/v1/rooms", {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("app routes", () => {
  test("reports health and enforces the exact configured CORS allowlist", async () => {
    const { app } = createTestHarness();

    const response = await app.handle(new Request("http://api.test/health", {
      headers: { origin: "http://localhost:5713" },
    }));
    const disallowed = await app.handle(new Request("http://api.test/health", {
      headers: { origin: "https://untrusted.example" },
    }));
    const options = await app.handle(new Request("http://api.test/v1/visitors", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5713",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,authorization",
      },
    }));

    expect(response.status).toBe(200);
    expect(await json<{ ok: true }>(response)).toEqual({ ok: true });
    expect(response.headers.get("access-control-allow-origin"))
      .toBe("http://localhost:5713");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(disallowed.headers.get("access-control-allow-origin")).toBeNull();
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin"))
      .toBe("http://localhost:5713");
    expect(options.headers.get("access-control-allow-methods"))
      .toBe("GET, POST, OPTIONS");
    expect(options.headers.get("access-control-allow-headers"))
      .toBe("content-type, authorization");
    expect(options.headers.get("cache-control")).toBe("no-store");
    expect(options.headers.get("referrer-policy")).toBe("no-referrer");
    expect([
      response.headers.get("access-control-allow-origin"),
      disallowed.headers.get("access-control-allow-origin"),
      options.headers.get("access-control-allow-origin"),
    ]).not.toContain("*");
  });

  test("creates visitors with public identity and token", async () => {
    const { app } = createTestHarness();

    const response = await app.handle(new Request("http://api.test/v1/visitors", {
      method: "POST",
    }));
    const body = await json<{
      visitor: {
        id: string;
        avatarSeed: string;
        displayName: string;
        createdAt: number;
        lastSeenAt: number;
      };
      token: string;
    }>(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(body).toEqual({
      visitor: {
        id: "vis_001",
        avatarSeed: "avatar_001",
        displayName: "访客 0001",
        createdAt: 1_000,
        lastSeenAt: 1_000,
      },
      token: "tok_001",
    });
  });

  test("sweeps, consumes exactly 30 creations per hour per IP, then creates", async () => {
    const { app, context } = createTestHarness();
    const calls: string[] = [];
    const sweepForAdmission = context.maintenance.sweepForAdmission;
    const consumeMany = context.rateLimits.consumeMany;
    const tryCreateVisitor = context.visitors.tryCreateVisitor;
    context.maintenance.sweepForAdmission = () => {
      calls.push("sweep");
      return sweepForAdmission();
    };
    context.rateLimits.consumeMany = checks => {
      calls.push(`limits:${JSON.stringify(checks)}`);
      return consumeMany(checks);
    };
    context.visitors.tryCreateVisitor = () => {
      calls.push("create");
      return tryCreateVisitor();
    };

    const response = await app.handle(new Request("http://api.test/v1/visitors", {
      method: "POST",
    }));

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "sweep",
      'limits:[{"key":"visitor:create:ip:203.0.113.10","limit":30,"windowMs":3600000}]',
      "create",
    ]);
  });

  test("maps visitor creation rate and state capacity failures", async () => {
    const limitedHarness = createTestHarness();
    for (let index = 0; index < 30; index += 1) {
      const response = await limitedHarness.app.handle(new Request(
        "http://api.test/v1/visitors",
        { method: "POST" },
      ));
      expect(response.status).toBe(200);
    }
    const limited = await limitedHarness.app.handle(new Request(
      "http://api.test/v1/visitors",
      { method: "POST" },
    ));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3600");
    expect(await json<{ error: { code: string } }>(limited)).toMatchObject({
      error: { code: "RATE_LIMITED" },
    });
    expect(limitedHarness.context.visitors.size()).toBe(30);

    const fullHarness = createTestHarness({ maxVisitors: 1 });
    expect((await fullHarness.app.handle(new Request(
      "http://api.test/v1/visitors",
      { method: "POST" },
    ))).status).toBe(200);
    const full = await fullHarness.app.handle(new Request(
      "http://api.test/v1/visitors",
      { method: "POST" },
    ));
    expect(full.status).toBe(503);
    expect(await json<{ error: { code: string } }>(full)).toMatchObject({
      error: { code: "CAPACITY_EXCEEDED" },
    });
    expect(fullHarness.context.visitors.size()).toBe(1);
  });

  test("creates an owner bootstrap with an in-memory invite and private headers", async () => {
    const { app } = createTestHarness();
    const sender = await createVisitor(app);

    const response = await app.handle(roomRequest(sender.token, { iceMode: "off" }));
    const body = await json<{
      room: { code: string; expiresAt: number };
      invite: { token: string; expiresAt: number };
      rtcConfiguration?: unknown;
    }>(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(body.room.code).toBe("234561");
    expect(body.invite.token).toMatch(/^inv_[A-Za-z0-9_-]{43}$/u);
    expect(body.invite.expiresAt).toBe(body.room.expiresAt);
    expect(body.rtcConfiguration).toBeUndefined();
  });

  test("joins only through exact invite or recovery bodies and never accepts a role", async () => {
    const { app } = createTestHarness();
    const sender = await createVisitor(app);
    const receiver = await createVisitor(app);
    const createdResponse = await app.handle(roomRequest(sender.token, { iceMode: "off" }));
    const created = await json<{
      room: { code: string };
      invite: { token: string };
    }>(createdResponse);
    const joinUrl = `http://api.test/v1/rooms/${created.room.code}/join`;
    const sendJoin = (body: unknown) => app.handle(new Request(joinUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${receiver.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }));

    const invalidBodies = [
      {},
      { iceMode: "off" },
      { iceMode: "off", role: "receiver", admission: { kind: "recovery" } },
      { iceMode: "off", admission: { kind: "approval", requestId: "req_1" } },
      { iceMode: "off", admission: { kind: "recovery", inviteToken: created.invite.token } },
      {
        iceMode: "off",
        admission: { kind: "invite", inviteToken: created.invite.token, requestId: "req_1" },
      },
      { iceMode: "off", admission: { kind: "invite" } },
      { iceMode: "static", admission: { kind: "recovery" } },
    ];
    for (const body of invalidBodies) {
      const invalid = await sendJoin(body);
      expect(invalid.status).toBe(422);
      expect(invalid.headers.get("cache-control")).toBe("no-store");
      expect(invalid.headers.get("referrer-policy")).toBe("no-referrer");
      const invalidText = await invalid.text();
      expect(invalidText).not.toContain(created.invite.token);
      expect(JSON.parse(invalidText)).toEqual({
        error: {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        },
      });
    }

    const invalidJson = await app.handle(new Request(joinUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${receiver.token}`,
        "content-type": "application/json",
      },
      body: `{"admission":{"kind":"invite","inviteToken":"${created.invite.token}"`,
    }));
    const invalidJsonText = await invalidJson.text();
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.headers.get("cache-control")).toBe("no-store");
    expect(invalidJson.headers.get("referrer-policy")).toBe("no-referrer");
    expect(invalidJsonText).not.toContain(created.invite.token);
    expect(JSON.parse(invalidJsonText)).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "Request validation failed",
      },
    });

    const malformedInvite = await sendJoin({
      iceMode: "off",
      admission: { kind: "invite", inviteToken: "not-an-invite" },
    });
    expect(malformedInvite.status).toBe(404);
    expect(await json<{ error: { code: string } }>(malformedInvite)).toMatchObject({
      error: { code: "ROOM_ACCESS_DENIED" },
    });

    const invited = await sendJoin({
      iceMode: "off",
      admission: { kind: "invite", inviteToken: created.invite.token },
    });
    expect(invited.status).toBe(200);
    expect(await json<{ room: { receivers: string[] } }>(invited)).toMatchObject({
      room: { receivers: [receiver.visitor.id] },
    });

    const recovered = await sendJoin({
      iceMode: "off",
      admission: { kind: "recovery" },
    });
    expect(recovered.status).toBe(200);
  });

  test("validates ASCII room codes and bounded request IDs before dispatch", async () => {
    const { app } = createTestHarness();
    const visitor = await createVisitor(app);
    const headers = { authorization: `Bearer ${visitor.token}` };

    for (const code of ["12345", "1234567", "abc123", "１２３４５６"]) {
      const response = await app.handle(new Request(
        `http://api.test/v1/rooms/${code}/join-requests`,
        { method: "POST", headers },
      ));
      expect(response.status).toBe(422);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }

    const overlongRequestId = "r".repeat(97);
    const response = await app.handle(new Request(
      `http://api.test/v1/rooms/123456/join-requests/${overlongRequestId}`,
      { headers },
    ));
    expect(response.status).toBe(422);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("returns authoritative manual-request receipts with 202 on every replay", async () => {
    const { app, context } = createTestHarness();
    const sender = await createVisitor(app);
    const receiver = await createVisitor(app);
    const createdResponse = await app.handle(roomRequest(sender.token, { iceMode: "off" }));
    const created = await json<{ room: { code: string } }>(createdResponse);
    expect(context.rooms.attach(created.room.code, sender.visitor.id, "sender").ok).toBe(true);
    const requestUrl = `http://api.test/v1/rooms/${created.room.code}/join-requests`;
    const requestJoin = () => app.handle(new Request(requestUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${receiver.token}` },
    }));

    const pendingResponse = await requestJoin();
    const pending = await json<{ requestId: string; state: string }>(pendingResponse);
    expect(pendingResponse.status).toBe(202);
    expect(pending.state).toBe("pending");

    const decision = await app.handle(new Request(
      `${requestUrl}/${pending.requestId}/decision`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sender.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision: "approve" }),
      },
    ));
    expect(decision.status).toBe(200);

    const approvedReplay = await requestJoin();
    expect(approvedReplay.status).toBe(202);
    expect(await json<{ requestId: string; state: string }>(approvedReplay)).toMatchObject({
      requestId: pending.requestId,
      state: "approved",
    });

    const cancelled = await app.handle(new Request(
      `${requestUrl}/${pending.requestId}/cancel`,
      { method: "POST", headers: { authorization: `Bearer ${receiver.token}` } },
    ));
    expect(cancelled.status).toBe(200);
    const terminalReplay = await requestJoin();
    expect(terminalReplay.status).toBe(202);
    expect(await json<{ requestId: string; state: string }>(terminalReplay)).toMatchObject({
      requestId: pending.requestId,
      state: "cancelled",
    });
  });

  test("serves status, decision, finalize, and cancel with authoritative states", async () => {
    const { app, context } = createTestHarness();
    const sender = await createVisitor(app);
    const receiver = await createVisitor(app);
    const outsider = await createVisitor(app);
    const created = await json<{ room: { code: string } }>(await app.handle(
      roomRequest(sender.token, { iceMode: "off" }),
    ));
    context.rooms.attach(created.room.code, sender.visitor.id, "sender");
    const base = `http://api.test/v1/rooms/${created.room.code}/join-requests`;
    const pendingResponse = await app.handle(new Request(base, {
      method: "POST",
      headers: { authorization: `Bearer ${receiver.token}` },
    }));
    const pending = await json<{ requestId: string }>(pendingResponse);
    const requestUrl = `${base}/${pending.requestId}`;

    const statusResponse = await app.handle(new Request(requestUrl, {
      headers: { authorization: `Bearer ${receiver.token}` },
    }));
    expect(statusResponse.status).toBe(200);
    expect(await json<{ state: string }>(statusResponse)).toMatchObject({ state: "pending" });

    const outsiderStatus = await app.handle(new Request(requestUrl, {
      headers: { authorization: `Bearer ${outsider.token}` },
    }));
    expect(outsiderStatus.status).toBe(404);
    expect(await json<{ error: { code: string } }>(outsiderStatus)).toMatchObject({
      error: { code: "ROOM_JOIN_REQUEST_NOT_FOUND" },
    });

    const outsiderOperations = [
      new Request(`${requestUrl}/decision`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${outsider.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision: "approve" }),
      }),
      new Request(`${requestUrl}/finalize`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${outsider.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ iceMode: "off" }),
      }),
      new Request(`${requestUrl}/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${outsider.token}` },
      }),
    ];
    for (const operation of outsiderOperations) {
      const response = await app.handle(operation);
      expect(response.status).toBe(404);
      expect(await json<{ error: { code: string } }>(response)).toMatchObject({
        error: { code: "ROOM_JOIN_REQUEST_NOT_FOUND" },
      });
    }

    const prematureFinalize = await app.handle(new Request(`${requestUrl}/finalize`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${receiver.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ iceMode: "off" }),
    }));
    expect(prematureFinalize.status).toBe(409);
    expect(await json<{ error: { code: string } }>(prematureFinalize)).toMatchObject({
      error: { code: "ROOM_JOIN_REQUEST_NOT_APPROVED" },
    });

    const approved = await app.handle(new Request(`${requestUrl}/decision`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sender.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "approve" }),
    }));
    expect(approved.status).toBe(200);
    expect(await json<{ state: string }>(approved)).toMatchObject({ state: "approved" });

    const finalized = await app.handle(new Request(`${requestUrl}/finalize`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${receiver.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ iceMode: "off" }),
    }));
    expect(finalized.status).toBe(200);
    expect(await json<{ room: { receivers: string[] } }>(finalized)).toMatchObject({
      room: { receivers: [receiver.visitor.id] },
    });

    const finalizedReceipt = await app.handle(new Request(requestUrl, {
      headers: { authorization: `Bearer ${receiver.token}` },
    }));
    expect(await json<{ state: string }>(finalizedReceipt)).toMatchObject({ state: "finalized" });

    const repeatedDecision = await app.handle(new Request(`${requestUrl}/decision`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sender.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "reject" }),
    }));
    const repeatedCancel = await app.handle(new Request(`${requestUrl}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${receiver.token}` },
    }));
    expect(repeatedDecision.status).toBe(200);
    expect(repeatedCancel.status).toBe(200);
    expect(await json<{ state: string }>(repeatedDecision)).toMatchObject({ state: "finalized" });
    expect(await json<{ state: string }>(repeatedCancel)).toMatchObject({ state: "finalized" });
  });

  test("maps rejected, cancelled, and expired finalization states precisely", async () => {
    const makePending = async () => {
      const harness = createTestHarness();
      const sender = await createVisitor(harness.app);
      const receiver = await createVisitor(harness.app);
      const created = await json<{ room: { code: string } }>(await harness.app.handle(
        roomRequest(sender.token, { iceMode: "off" }),
      ));
      harness.context.rooms.attach(created.room.code, sender.visitor.id, "sender");
      const base = `http://api.test/v1/rooms/${created.room.code}/join-requests`;
      const pending = await json<{ requestId: string }>(await harness.app.handle(new Request(base, {
        method: "POST",
        headers: { authorization: `Bearer ${receiver.token}` },
      })));
      return { ...harness, sender, receiver, requestUrl: `${base}/${pending.requestId}` };
    };
    const finalize = (fixture: Awaited<ReturnType<typeof makePending>>) =>
      fixture.app.handle(new Request(`${fixture.requestUrl}/finalize`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.receiver.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ iceMode: "off" }),
      }));

    const rejected = await makePending();
    await rejected.app.handle(new Request(`${rejected.requestUrl}/decision`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rejected.sender.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "reject" }),
    }));
    expect((await finalize(rejected)).status).toBe(403);

    const cancelled = await makePending();
    await cancelled.app.handle(new Request(`${cancelled.requestUrl}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${cancelled.receiver.token}` },
    }));
    expect((await finalize(cancelled)).status).toBe(410);

    const expired = await makePending();
    expired.advanceTime(90_001);
    expect((await finalize(expired)).status).toBe(410);
  });

  test("returns uniform manual-room errors and never exposes a public snapshot", async () => {
    const missingHarness = createTestHarness();
    const missingVisitor = await createVisitor(missingHarness.app);
    const missing = await missingHarness.app.handle(new Request(
      "http://api.test/v1/rooms/000000/join-requests",
      { method: "POST", headers: { authorization: `Bearer ${missingVisitor.token}` } },
    ));
    expect(missing.status).toBe(404);
    expect(await json<{ error: { code: string } }>(missing)).toMatchObject({
      error: { code: "ROOM_REQUEST_UNAVAILABLE" },
    });

    const offlineHarness = createTestHarness();
    const sender = await createVisitor(offlineHarness.app);
    const receiver = await createVisitor(offlineHarness.app);
    const created = await json<{ room: { code: string } }>(await offlineHarness.app.handle(
      roomRequest(sender.token, { iceMode: "off" }),
    ));
    const offline = await offlineHarness.app.handle(new Request(
      `http://api.test/v1/rooms/${created.room.code}/join-requests`,
      { method: "POST", headers: { authorization: `Bearer ${receiver.token}` } },
    ));
    expect(offline.status).toBe(404);
    expect(await json<{ error: { code: string } }>(offline)).toMatchObject({
      error: { code: "ROOM_REQUEST_UNAVAILABLE" },
    });

    const expiredHarness = createTestHarness();
    const expiredSender = await createVisitor(expiredHarness.app);
    const expiredCreated = await json<{ room: { code: string } }>(await expiredHarness.app.handle(
      roomRequest(expiredSender.token, { iceMode: "off" }),
    ));
    expiredHarness.advanceTime(30 * 60_000 + 1);
    const freshVisitor = await createVisitor(expiredHarness.app);
    const expired = await expiredHarness.app.handle(new Request(
      `http://api.test/v1/rooms/${expiredCreated.room.code}/join-requests`,
      { method: "POST", headers: { authorization: `Bearer ${freshVisitor.token}` } },
    ));
    expect(expired.status).toBe(404);
    expect(await json<{ error: { code: string } }>(expired)).toMatchObject({
      error: { code: "ROOM_REQUEST_UNAVAILABLE" },
    });

    const closedHarness = createTestHarness();
    const closedSender = await createVisitor(closedHarness.app);
    const closedReceiver = await createVisitor(closedHarness.app);
    const closedCreated = await json<{ room: { code: string } }>(await closedHarness.app.handle(
      roomRequest(closedSender.token, { iceMode: "off" }),
    ));
    closedHarness.context.rooms.leave(
      closedCreated.room.code,
      closedSender.visitor.id,
    );
    const closed = await closedHarness.app.handle(new Request(
      `http://api.test/v1/rooms/${closedCreated.room.code}/join-requests`,
      { method: "POST", headers: { authorization: `Bearer ${closedReceiver.token}` } },
    ));
    expect(closed.status).toBe(404);
    expect(await json<{ error: { code: string } }>(closed)).toMatchObject({
      error: { code: "ROOM_REQUEST_UNAVAILABLE" },
    });

    const fullHarness = createTestHarness();
    const fullSender = await createVisitor(fullHarness.app);
    const fullCreated = await json<{ room: { code: string } }>(await fullHarness.app.handle(
      roomRequest(fullSender.token, { iceMode: "off" }),
    ));
    fullHarness.context.rooms.attach(fullCreated.room.code, fullSender.visitor.id, "sender");
    const fullRequestUrl = `http://api.test/v1/rooms/${fullCreated.room.code}/join-requests`;
    for (let index = 0; index < 5; index += 1) {
      const pendingVisitor = await createVisitor(fullHarness.app);
      expect((await fullHarness.app.handle(new Request(fullRequestUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${pendingVisitor.token}` },
      }))).status).toBe(202);
    }
    const overflowVisitor = await createVisitor(fullHarness.app);
    const full = await fullHarness.app.handle(new Request(fullRequestUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${overflowVisitor.token}` },
    }));
    expect(full.status).toBe(404);
    expect(await json<{ error: { code: string } }>(full)).toMatchObject({
      error: { code: "ROOM_REQUEST_UNAVAILABLE" },
    });

    const publicLookup = await offlineHarness.app.handle(new Request(
      `http://api.test/v1/rooms/${created.room.code}`,
    ));
    expect(publicLookup.status).toBe(404);
  });

  test("maps finalize TURN and receiver-capacity failures to 503", async () => {
    const prepareApproved = async (
      harness: ReturnType<typeof createTestHarness>,
      sender: Awaited<ReturnType<typeof createVisitor>>,
      receiver: Awaited<ReturnType<typeof createVisitor>>,
      roomCode: string,
    ) => {
      harness.context.rooms.attach(roomCode, sender.visitor.id, "sender");
      const base = `http://api.test/v1/rooms/${roomCode}/join-requests`;
      const pending = await json<{ requestId: string }>(await harness.app.handle(new Request(base, {
        method: "POST",
        headers: { authorization: `Bearer ${receiver.token}` },
      })));
      const requestUrl = `${base}/${pending.requestId}`;
      expect((await harness.app.handle(new Request(`${requestUrl}/decision`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sender.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision: "approve" }),
      }))).status).toBe(200);
      return requestUrl;
    };
    const finalize = (
      harness: ReturnType<typeof createTestHarness>,
      requestUrl: string,
      receiverToken: string,
      iceMode: "off" | "api",
    ) => harness.app.handle(new Request(`${requestUrl}/finalize`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${receiverToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ iceMode }),
    }));

    const withoutTurn = createTestHarness({ turnConfigured: false });
    const turnSender = await createVisitor(withoutTurn.app);
    const turnReceiver = await createVisitor(withoutTurn.app);
    const turnRoom = await json<{ room: { code: string } }>(await withoutTurn.app.handle(
      roomRequest(turnSender.token, { iceMode: "off" }),
    ));
    const turnRequest = await prepareApproved(
      withoutTurn,
      turnSender,
      turnReceiver,
      turnRoom.room.code,
    );
    const turnFailure = await finalize(withoutTurn, turnRequest, turnReceiver.token, "api");
    expect(turnFailure.status).toBe(503);
    expect(await json<{ error: { code: string } }>(turnFailure)).toMatchObject({
      error: { code: "TURN_NOT_CONFIGURED" },
    });

    const atCapacity = createTestHarness({ maxReceivers: 1 });
    const capacitySender = await createVisitor(atCapacity.app);
    const existingReceiver = await createVisitor(atCapacity.app);
    const waitingReceiver = await createVisitor(atCapacity.app);
    const capacityRoom = await json<{
      room: { code: string };
      invite: { token: string };
    }>(await atCapacity.app.handle(roomRequest(capacitySender.token, { iceMode: "off" })));
    const capacityRequest = await prepareApproved(
      atCapacity,
      capacitySender,
      waitingReceiver,
      capacityRoom.room.code,
    );
    expect((await atCapacity.app.handle(new Request(
      `http://api.test/v1/rooms/${capacityRoom.room.code}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${existingReceiver.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          iceMode: "off",
          admission: { kind: "invite", inviteToken: capacityRoom.invite.token },
        }),
      },
    ))).status).toBe(200);
    const capacityFailure = await finalize(
      atCapacity,
      capacityRequest,
      waitingReceiver.token,
      "off",
    );
    expect(capacityFailure.status).toBe(503);
    expect(await json<{ error: { code: string } }>(capacityFailure)).toMatchObject({
      error: { code: "CAPACITY_EXCEEDED" },
    });
  });

  test("maps private-route auth, rate, TURN, and capacity errors with private headers", async () => {
    const { app, context } = createTestHarness();
    const unauthorized = await app.handle(roomRequest("bad", { iceMode: "off" }));
    expect(unauthorized.status).toBe(401);

    const sender = await createVisitor(app);
    const receiver = await createVisitor(app);
    const created = await json<{ room: { code: string } }>(await app.handle(
      roomRequest(sender.token, { iceMode: "off" }),
    ));
    context.rooms.attach(created.room.code, sender.visitor.id, "sender");
    const joinRequest = () => app.handle(new Request(
      `http://api.test/v1/rooms/${created.room.code}/join-requests`,
      { method: "POST", headers: { authorization: `Bearer ${receiver.token}` } },
    ));
    expect((await joinRequest()).status).toBe(202);
    expect((await joinRequest()).status).toBe(202);
    expect((await joinRequest()).status).toBe(202);
    const limited = await joinRequest();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");

    const withoutTurn = createTestHarness({ turnConfigured: false });
    const turnSender = await createVisitor(withoutTurn.app);
    const turnFailure = await withoutTurn.app.handle(roomRequest(
      turnSender.token,
      { iceMode: "api" },
    ));
    expect(turnFailure.status).toBe(503);

    const atCapacity = createTestHarness({ maxRooms: 1 });
    const senderOne = await createVisitor(atCapacity.app);
    const senderTwo = await createVisitor(atCapacity.app);
    expect((await atCapacity.app.handle(roomRequest(
      senderOne.token,
      { iceMode: "off" },
    ))).status).toBe(200);
    const capacityFailure = await atCapacity.app.handle(roomRequest(
      senderTwo.token,
      { iceMode: "off" },
    ));
    expect(capacityFailure.status).toBe(503);

    for (const response of [unauthorized, limited, turnFailure, capacityFailure]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });
});
