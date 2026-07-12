import { describe, expect, test } from "bun:test";
import type {
  PublicRoom,
  RtcConfigurationDto,
} from "@p2p/contracts";
import { createMaintenanceService } from "../maintenance/service";
import { createRateLimitService } from "../rate-limit/service";
import { createTurnService } from "../turn/service";
import { createVisitorService } from "../visitor/service";
import type { Visitor } from "../visitor/model";
import type { RoomMutationPlan } from "./model";
import { createRoomBootstrapService } from "./bootstrap";
import { createRoomService } from "./service";

const visitor: Visitor = {
  id: "vis_001",
  token: "tok_001",
  avatarSeed: "avatar_001",
  displayName: "访客 0001",
  createdAt: 1_000,
  lastSeenAt: 1_000,
};

const room: PublicRoom = {
  code: "123456",
  senderId: visitor.id,
  receivers: [],
  participants: [{
    visitor: {
      id: visitor.id,
      avatarSeed: visitor.avatarSeed,
      displayName: visitor.displayName,
      createdAt: visitor.createdAt,
      lastSeenAt: visitor.lastSeenAt,
    },
    role: "sender",
    joinedAt: 1_000,
    status: "connecting",
  }],
  createdAt: 1_000,
  expiresAt: 61_000,
};

const plan: RoomMutationPlan = {
  id: "plan_1",
  revision: 0,
  kind: "create",
  visitorId: visitor.id,
  role: "sender",
  room,
};

const rtcConfiguration: RtcConfigurationDto = {
  iceServers: [{
    urls: ["turn:turn.example.com:3478"],
    username: "361:vis_001",
    credential: "signed",
    credentialType: "password",
  }],
};

describe("room bootstrap orchestration", () => {
  test("creates in strict sweep, auth, prepare, limits, TURN, commit order", () => {
    const calls: string[] = [];
    let consumed: unknown;
    const bootstrap = createRoomBootstrapService({
      maintenance: {
        sweepForAdmission() {
          calls.push("sweep");
          return [];
        },
      },
      visitors: {
        touch(token: string) {
          calls.push(`touch:${token}`);
          return visitor;
        },
      },
      rooms: {
        prepareCreate(token: string) {
          calls.push(`prepare:${token}`);
          return { ok: true as const, plan };
        },
        prepareJoin() {
          throw new Error("unexpected join");
        },
        commit(committedPlan: RoomMutationPlan) {
          calls.push(`commit:${committedPlan.id}`);
          return { ok: true as const, room };
        },
      },
      rateLimits: {
        consumeMany(checks) {
          calls.push("limits");
          consumed = checks;
          return { ok: true as const };
        },
      },
      turn: {
        issue(visitorId: string, expiresAt: number) {
          calls.push(`turn:${visitorId}:${String(expiresAt)}`);
          return {
            ok: true as const,
            credential: {
              rtcConfiguration,
              credentialExpiresAt: 361_000,
            },
          };
        },
      },
    });

    expect(bootstrap.createRoom({
      visitorToken: visitor.token,
      clientIp: "203.0.113.10",
      iceMode: "api",
    })).toEqual({
      ok: true,
      bootstrap: {
        room,
        rtcConfiguration,
        credentialExpiresAt: 361_000,
      },
    });
    expect(calls).toEqual([
      "sweep",
      "touch:tok_001",
      "prepare:tok_001",
      "limits",
      "turn:vis_001:61000",
      "commit:plan_1",
    ]);
    expect(consumed).toEqual([
      { key: "room:create:ip:203.0.113.10", limit: 30, windowMs: 3_600_000 },
      { key: "room:create:visitor:vis_001", limit: 10, windowMs: 3_600_000 },
      { key: "turn:credential:instance", limit: 300, windowMs: 60_000 },
      { key: "turn:credential:ip:203.0.113.10", limit: 20, windowMs: 60_000 },
      { key: "turn:credential:visitor:vis_001", limit: 5, windowMs: 60_000 },
      { key: "turn:credential:room:123456", limit: 30, windowMs: 60_000 },
    ]);
  });

  test("joins in off mode without invoking TURN and uses exact join policies", () => {
    const calls: string[] = [];
    let consumed: unknown;
    const joinPlan: RoomMutationPlan = {
      ...plan,
      id: "plan_join",
      revision: 1,
      kind: "join",
      visitorId: "vis_002",
      role: "receiver",
    };
    const receiver = { ...visitor, id: "vis_002", token: "tok_002" };
    const bootstrap = createRoomBootstrapService({
      maintenance: {
        sweepForAdmission() {
          calls.push("sweep");
          return [];
        },
      },
      visitors: {
        touch() {
          calls.push("touch");
          return receiver;
        },
      },
      rooms: {
        prepareCreate() {
          throw new Error("unexpected create");
        },
        prepareJoin(code, token, role) {
          calls.push(`prepare:${code}:${token}:${role}`);
          return { ok: true as const, plan: joinPlan };
        },
        commit() {
          calls.push("commit");
          return { ok: true as const, room };
        },
      },
      rateLimits: {
        consumeMany(checks) {
          calls.push("limits");
          consumed = checks;
          return { ok: true as const };
        },
      },
      turn: {
        issue() {
          calls.push("turn");
          throw new Error("TURN must not run in off mode");
        },
      },
    });

    expect(bootstrap.joinRoom({
      code: room.code,
      visitorToken: receiver.token,
      clientIp: "198.51.100.4",
      role: "receiver",
      iceMode: "off",
    })).toEqual({
      ok: true,
      bootstrap: { room },
    });
    expect(calls).toEqual([
      "sweep",
      "touch",
      "prepare:123456:tok_002:receiver",
      "limits",
      "commit",
    ]);
    expect(consumed).toEqual([
      { key: "room:join:ip:198.51.100.4", limit: 60, windowMs: 60_000 },
      { key: "room:join:visitor:vis_002", limit: 20, windowMs: 60_000 },
    ]);
  });

  test("sweeps before rejecting an invalid visitor and performs no later effects", () => {
    const calls: string[] = [];
    const bootstrap = createRoomBootstrapService({
      maintenance: {
        sweepForAdmission() {
          calls.push("sweep");
          return [];
        },
      },
      visitors: {
        touch() {
          calls.push("touch");
          return undefined;
        },
      },
      rooms: {
        prepareCreate() {
          calls.push("prepare");
          return { ok: false as const, error: { code: "VISITOR_NOT_FOUND" as const, message: "bad" } };
        },
        prepareJoin() {
          throw new Error("unexpected join");
        },
        commit() {
          calls.push("commit");
          return { ok: false as const, error: { code: "INVALID_STATE" as const, message: "bad" } };
        },
      },
      rateLimits: {
        consumeMany() {
          calls.push("limits");
          return { ok: true as const };
        },
      },
      turn: {
        issue() {
          calls.push("turn");
          return { ok: false as const, error: { code: "TURN_NOT_CONFIGURED" as const, message: "bad" } };
        },
      },
    });

    expect(bootstrap.createRoom({
      visitorToken: "bad",
      clientIp: "unknown",
      iceMode: "off",
    })).toEqual({
      ok: false,
      error: { code: "VISITOR_NOT_FOUND", message: "访客不存在或已过期" },
    });
    expect(calls).toEqual(["sweep", "touch"]);
  });

  test("rate and TURN failures leave no created room or joined receiver", () => {
    let visitorIndex = 0;
    let roomIndex = 0;
    const visitors = createVisitorService({
      now: () => 1_000,
      createId: () => `vis_${String(++visitorIndex).padStart(3, "0")}`,
      createToken: () => `tok_${String(visitorIndex).padStart(3, "0")}`,
      createAvatarSeed: () => `avatar_${String(visitorIndex).padStart(3, "0")}`,
    });
    const rooms = createRoomService({
      visitors,
      now: () => 1_000,
      createCode: () => String(200_000 + ++roomIndex),
      createPlanId: () => `plan_${String(roomIndex)}`,
    });
    const rateLimits = createRateLimitService({ now: () => 1_000 });
    const maintenance = createMaintenanceService({ rooms, visitors, rateLimits });
    const sender = visitors.createVisitor();
    const receiver = visitors.createVisitor();
    const rateFailure = createRoomBootstrapService({
      maintenance,
      visitors,
      rooms,
      rateLimits: {
        consumeMany: () => ({
          ok: false,
          error: { code: "RATE_LIMITED", message: "limited", retryAfterMs: 1 },
        }),
      },
      turn: createTurnService({ stunUrls: [], turn: undefined }, { now: () => 1_000 }),
    });

    expect(rateFailure.createRoom({
      visitorToken: sender.token,
      clientIp: "203.0.113.1",
      iceMode: "off",
    })).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    expect(rooms.getRoom("200001")).toMatchObject({
      ok: false,
      error: { code: "ROOM_NOT_FOUND" },
    });

    const created = rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    expect(rateFailure.joinRoom({
      code: created.room.code,
      visitorToken: receiver.token,
      clientIp: "203.0.113.2",
      role: "receiver",
      iceMode: "off",
    })).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    expect(rooms.getRoom(created.room.code)).toMatchObject({
      ok: true,
      room: { receivers: [] },
    });

    const turnFailure = createRoomBootstrapService({
      maintenance,
      visitors,
      rooms,
      rateLimits,
      turn: createTurnService({ stunUrls: [], turn: undefined }, { now: () => 1_000 }),
    });
    expect(turnFailure.createRoom({
      visitorToken: receiver.token,
      clientIp: "203.0.113.2",
      iceMode: "api",
    })).toEqual({
      ok: false,
      error: { code: "TURN_NOT_CONFIGURED", message: "TURN 中继服务尚未配置" },
    });
    expect(rooms.getRoom("200003")).toMatchObject({
      ok: false,
      error: { code: "ROOM_NOT_FOUND" },
    });
  });

  test("a receiver join survives sender attach during TURN credential issuance", () => {
    let visitorIndex = 0;
    const visitors = createVisitorService({
      now: () => 1_000,
      createId: () => `vis_${String(++visitorIndex).padStart(3, "0")}`,
      createToken: () => `tok_${String(visitorIndex).padStart(3, "0")}`,
      createAvatarSeed: () => `avatar_${String(visitorIndex).padStart(3, "0")}`,
    });
    const rooms = createRoomService({
      visitors,
      now: () => 1_000,
      createCode: () => "300001",
      createPlanId: () => crypto.randomUUID(),
    });
    const rateLimits = createRateLimitService({ now: () => 1_000 });
    const maintenance = createMaintenanceService({ rooms, visitors, rateLimits });
    const sender = visitors.createVisitor();
    const receiver = visitors.createVisitor();
    const created = rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    const bootstrap = createRoomBootstrapService({
      maintenance,
      visitors,
      rooms,
      rateLimits,
      turn: {
        issue() {
          rooms.attach(created.room.code, sender.id, "sender");
          return {
            ok: true,
            credential: {
              rtcConfiguration,
              credentialExpiresAt: created.room.expiresAt + 300_000,
            },
          };
        },
      },
    });

    expect(bootstrap.joinRoom({
      code: created.room.code,
      visitorToken: receiver.token,
      clientIp: "203.0.113.8",
      role: "receiver",
      iceMode: "api",
    })).toMatchObject({
      ok: true,
      bootstrap: {
        room: {
          receivers: [receiver.id],
          participants: [
            { visitor: { id: sender.id }, role: "sender", status: "online" },
            { visitor: { id: receiver.id }, role: "receiver", status: "connecting" },
          ],
        },
      },
    });
    expect(rooms.getRoom(created.room.code)).toMatchObject({
      ok: true,
      room: { receivers: [receiver.id] },
    });
  });
});
