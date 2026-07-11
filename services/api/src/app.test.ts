import { describe, expect, test } from "bun:test";
import type { ApiConfig } from "./config";
import type { AppContext } from "./context";
import { createApp } from "./app";
import { createMaintenanceService } from "./modules/maintenance/service";
import { createRateLimitService } from "./modules/rate-limit/service";
import { createRoomBootstrapService } from "./modules/room/bootstrap";
import { createRoomService } from "./modules/room/service";
import { createTurnService } from "./modules/turn/service";
import { createVisitorService } from "./modules/visitor/service";

type HarnessOptions = {
  maxRooms?: number;
  turnConfigured?: boolean;
};

const createTestHarness = ({
  maxRooms,
  turnConfigured = true,
}: HarnessOptions = {}) => {
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
    now: () => 1_000,
    createId: () => `vis_${String(++visitorIndex).padStart(3, "0")}`,
    createToken: () => `tok_${String(visitorIndex).padStart(3, "0")}`,
    createAvatarSeed: () => `avatar_${String(visitorIndex).padStart(3, "0")}`,
  });
  const rooms = createRoomService({
    visitors,
    now: () => 1_000,
    maxRooms,
    createCode: () => String(234_560 + ++roomIndex),
    createPlanId: () => `plan_${String(roomIndex)}_${crypto.randomUUID()}`,
  });
  const rateLimits = createRateLimitService({ now: () => 1_000 });
  const turn = createTurnService(config, { now: () => 1_000 });
  const maintenance = createMaintenanceService({ rooms, visitors, rateLimits });
  const roomBootstrap = createRoomBootstrapService({
    maintenance,
    visitors,
    rooms,
    rateLimits,
    turn,
  });
  const context: AppContext = {
    config,
    visitors,
    rooms,
    rateLimits,
    turn,
    maintenance,
    roomBootstrap,
    clientIp: { resolve: () => "203.0.113.10" },
  };
  return { app: createApp(context), context };
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
  test("reports health and preserves the transitional CORS behavior", async () => {
    const { app } = createTestHarness();

    const response = await app.handle(new Request("http://api.test/health"));
    const options = await app.handle(new Request("http://api.test/v1/visitors", {
      method: "OPTIONS",
    }));

    expect(response.status).toBe(200);
    expect(await json<{ ok: true }>(response)).toEqual({ ok: true });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(options.status).toBe(204);
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

  test("maps missing iceMode to off and defaults join role to receiver", async () => {
    const { app } = createTestHarness();
    const sender = await createVisitor(app);
    const receiver = await createVisitor(app);

    const createResponse = await app.handle(roomRequest(sender.token));
    const created = await json<{
      room: {
        code: string;
        senderId: string;
        participants: Array<{ status: string }>;
      };
      rtcConfiguration?: unknown;
    }>(createResponse);
    const joinResponse = await app.handle(new Request(
      `http://api.test/v1/rooms/${created.room.code}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${receiver.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    ));
    const joined = await json<{
      room: {
        receivers: string[];
        participants: Array<{ role: string; status: string }>;
      };
      rtcConfiguration?: unknown;
    }>(joinResponse);

    expect(createResponse.status).toBe(200);
    expect(joinResponse.status).toBe(200);
    expect(created.rtcConfiguration).toBeUndefined();
    expect(joined.rtcConfiguration).toBeUndefined();
    expect(created.room.participants).toMatchObject([{ status: "connecting" }]);
    expect(joined.room.receivers).toEqual([receiver.visitor.id]);
    expect(joined.room.participants[joined.room.participants.length - 1]).toMatchObject({
      role: "receiver",
      status: "connecting",
    });
  });

  test("returns signed API ICE bootstrap with no-store and no shared secret", async () => {
    const { app } = createTestHarness();
    const sender = await createVisitor(app);

    const response = await app.handle(roomRequest(sender.token, { iceMode: "api" }));
    const body = await json<{
      room: { code: string; expiresAt: number };
      rtcConfiguration: {
        iceServers: Array<{
          urls: string[];
          username?: string;
          credential?: string;
        }>;
      };
      credentialExpiresAt: number;
    }>(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.room.code).toBe("234561");
    expect(body.credentialExpiresAt).toBe(body.room.expiresAt + 300_000);
    expect(body.rtcConfiguration.iceServers).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("0123456789abcdef0123456789abcdef");
  });

  test("rejects invalid present iceMode values", async () => {
    const { app } = createTestHarness();
    const sender = await createVisitor(app);

    const response = await app.handle(roomRequest(sender.token, { iceMode: "static" }));

    expect(response.status).toBe(422);
  });

  test("maps bootstrap errors to 401, 404, and 409", async () => {
    const { app } = createTestHarness();
    const sender = await createVisitor(app);
    const secondSender = await createVisitor(app);

    const unauthorized = await app.handle(roomRequest("bad"));
    const missing = await app.handle(new Request("http://api.test/v1/rooms/000000/join", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secondSender.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ role: "receiver", iceMode: "off" }),
    }));
    const createdResponse = await app.handle(roomRequest(sender.token, { iceMode: "off" }));
    const created = await json<{ room: { code: string } }>(createdResponse);
    const conflict = await app.handle(new Request(
      `http://api.test/v1/rooms/${created.room.code}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${secondSender.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ role: "sender", iceMode: "off" }),
      },
    ));

    expect(unauthorized.status).toBe(401);
    expect(await json<{ error: { code: string } }>(unauthorized)).toMatchObject({
      error: { code: "VISITOR_NOT_FOUND" },
    });
    expect(missing.status).toBe(404);
    expect(await json<{ error: { code: string } }>(missing)).toMatchObject({
      error: { code: "ROOM_NOT_FOUND" },
    });
    expect(conflict.status).toBe(409);
    expect(await json<{ error: { code: string } }>(conflict)).toMatchObject({
      error: { code: "ROOM_SENDER_EXISTS" },
    });
  });

  test("maps rate limits to 429 with Retry-After", async () => {
    const { app } = createTestHarness();
    const sender = await createVisitor(app);
    for (let index = 0; index < 10; index += 1) {
      const response = await app.handle(roomRequest(sender.token, { iceMode: "off" }));
      expect(response.status).toBe(200);
    }

    const limited = await app.handle(roomRequest(sender.token, { iceMode: "off" }));
    const body = await json<{ error: { code: string; retryAfterMs: number } }>(limited);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3600");
    expect(body.error).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 3_600_000 });
  });

  test("maps TURN and room capacity failures to 503", async () => {
    const withoutTurn = createTestHarness({ turnConfigured: false });
    const first = await createVisitor(withoutTurn.app);
    const turnFailure = await withoutTurn.app.handle(roomRequest(first.token, { iceMode: "api" }));

    const atCapacity = createTestHarness({ maxRooms: 1 });
    const senderOne = await createVisitor(atCapacity.app);
    const senderTwo = await createVisitor(atCapacity.app);
    expect((await atCapacity.app.handle(roomRequest(senderOne.token))).status).toBe(200);
    const capacityFailure = await atCapacity.app.handle(roomRequest(senderTwo.token));

    expect(turnFailure.status).toBe(503);
    expect(await json<{ error: { code: string } }>(turnFailure)).toMatchObject({
      error: { code: "TURN_NOT_CONFIGURED" },
    });
    expect(capacityFailure.status).toBe(503);
    expect(await json<{ error: { code: string } }>(capacityFailure)).toMatchObject({
      error: { code: "CAPACITY_EXCEEDED" },
    });
  });
});
