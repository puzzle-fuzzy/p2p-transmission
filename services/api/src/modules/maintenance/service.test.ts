import { describe, expect, test } from "bun:test";
import { createRoomAccessService } from "../room-access/service";
import type { RoomTransition } from "../room/model";
import { createRoomService } from "../room/service";
import { createVisitorService } from "../visitor/service";
import { createNodeRoomInviteCrypto } from "../../shared/room-invite-crypto";
import type { MaintenanceEvent } from "./model";
import {
  createMaintenanceService,
  type MaintenanceScheduler,
} from "./service";

const left = (roomCode: string, visitorId: string): RoomTransition => ({
  type: "participant:left",
  roomCode,
  visitorId,
});

const createHarness = () => {
  const calls: string[] = [];
  const scheduled = new Map<symbol, { callback: () => void; intervalMs: number }>();
  const cleared: symbol[] = [];
  const scheduler: MaintenanceScheduler = {
    setInterval(callback, intervalMs) {
      const handle = Symbol(String(intervalMs));
      scheduled.set(handle, { callback, intervalMs });
      return handle;
    },
    clearInterval(handle) {
      const timer = handle as symbol;
      cleared.push(timer);
      scheduled.delete(timer);
    },
  };
  const rooms = {
    cleanupExpiredState() {
      calls.push("rooms.cleanup");
      return [left("100001", "room-expired")];
    },
    removeVisitor(visitorId: string) {
      calls.push(`rooms.remove:${visitorId}`);
      return [left(`room-${visitorId}`, visitorId)];
    },
  };
  const roomAccess = {
    cleanupExpiredState() {
      calls.push("roomAccess.cleanup");
      return [{
        type: "room:join-request-resolved" as const,
        senderId: "sender",
        roomCode: "100001",
        requestId: "request-cleanup",
        state: "expired" as const,
      }];
    },
    removeVisitor(visitorId: string) {
      calls.push(`roomAccess.remove:${visitorId}`);
      return [{
        type: "room:join-request-resolved" as const,
        senderId: "sender",
        roomCode: "100001",
        requestId: `request-${visitorId}`,
        state: "expired" as const,
      }];
    },
  };
  const visitors = {
    listExpiredVisitorIds() {
      calls.push("visitors.list");
      return ["visitor-b", "visitor-a", "visitor-a"];
    },
    remove(visitorId: string) {
      calls.push(`visitors.remove:${visitorId}`);
      return true;
    },
  };
  const rateLimits = {
    sweep() {
      calls.push("rateLimits.sweep");
      return 2;
    },
  };
  return {
    calls,
    cleared,
    scheduled,
    scheduler,
    maintenance: createMaintenanceService({
      rooms,
      roomAccess,
      visitors,
      rateLimits,
      scheduler,
    }),
  };
};

describe("maintenance service", () => {
  test("owns the complete admission sweep in deterministic cascade order", () => {
    const { calls, maintenance } = createHarness();
    const published: Array<readonly MaintenanceEvent[]> = [];
    maintenance.subscribe(events => published.push(events));

    const events: MaintenanceEvent[] = [
      left("100001", "room-expired"),
      left("room-visitor-a", "visitor-a"),
      left("room-visitor-b", "visitor-b"),
      { type: "visitor:expired", visitorId: "visitor-a" },
      { type: "visitor:expired", visitorId: "visitor-b" },
    ];
    expect(maintenance.sweepForAdmission()).toEqual(events);
    expect(published).toEqual([events]);
    expect(calls).toEqual([
      "rooms.cleanup",
      "roomAccess.cleanup",
      "visitors.list",
      "rooms.remove:visitor-a",
      "roomAccess.remove:visitor-a",
      "visitors.remove:visitor-a",
      "rooms.remove:visitor-b",
      "roomAccess.remove:visitor-b",
      "visitors.remove:visitor-b",
      "rateLimits.sweep",
    ]);
  });

  test("sweeps only room and attach deadlines on the room cadence", () => {
    const { calls, maintenance } = createHarness();

    expect(maintenance.sweepRooms()).toEqual([
      left("100001", "room-expired"),
    ]);
    expect(calls).toEqual(["rooms.cleanup", "roomAccess.cleanup"]);
  });

  test("cascades visitor removals before deleting visitors and rate keys", () => {
    const { calls, maintenance } = createHarness();

    expect(maintenance.sweepVisitorsAndRateKeys()).toEqual([
      left("room-visitor-a", "visitor-a"),
      left("room-visitor-b", "visitor-b"),
      { type: "visitor:expired", visitorId: "visitor-a" },
      { type: "visitor:expired", visitorId: "visitor-b" },
    ]);
    expect(calls).toEqual([
      "visitors.list",
      "rooms.remove:visitor-a",
      "roomAccess.remove:visitor-a",
      "visitors.remove:visitor-a",
      "rooms.remove:visitor-b",
      "roomAccess.remove:visitor-b",
      "visitors.remove:visitor-b",
      "rateLimits.sweep",
    ]);
  });

  test("publishes each non-empty synchronous sweep once and supports unsubscribe", () => {
    const { maintenance } = createHarness();
    const first: Array<readonly MaintenanceEvent[]> = [];
    const second: Array<readonly MaintenanceEvent[]> = [];
    const unsubscribeFirst = maintenance.subscribe(events => first.push(events));
    maintenance.subscribe(events => second.push(events));

    maintenance.sweepRooms();
    unsubscribeFirst();
    unsubscribeFirst();
    maintenance.sweepVisitorsAndRateKeys();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(second[0]).toEqual([left("100001", "room-expired")]);
    expect(second[1]).toEqual([
      left("room-visitor-a", "visitor-a"),
      left("room-visitor-b", "visitor-b"),
      { type: "visitor:expired", visitorId: "visitor-a" },
      { type: "visitor:expired", visitorId: "visitor-b" },
    ]);
  });

  test("does not notify subscribers for an empty sweep", () => {
    const maintenance = createMaintenanceService({
      rooms: {
        cleanupExpiredState: () => [],
        removeVisitor: () => [],
      },
      roomAccess: {
        cleanupExpiredState: () => [],
        removeVisitor: () => [],
      },
      visitors: {
        listExpiredVisitorIds: () => [],
        remove: () => false,
      },
      rateLimits: { sweep: () => 0 },
    });
    let notifications = 0;
    maintenance.subscribe(() => {
      notifications += 1;
    });

    expect(maintenance.sweepForAdmission()).toEqual([]);
    expect(maintenance.sweepRooms()).toEqual([]);
    expect(maintenance.sweepVisitorsAndRateKeys()).toEqual([]);
    expect(notifications).toBe(0);
  });

  test("runs exact periodic cadences and start/stop are idempotent", () => {
    const { calls, cleared, maintenance, scheduled } = createHarness();
    const notifications: Array<readonly MaintenanceEvent[]> = [];
    maintenance.subscribe(events => notifications.push(events));

    maintenance.start();
    maintenance.start();

    expect(Array.from(scheduled.values()).map(timer => timer.intervalMs).sort())
      .toEqual([30_000, 60_000]);
    const roomTimer = Array.from(scheduled.values())
      .find(timer => timer.intervalMs === 30_000);
    const visitorTimer = Array.from(scheduled.values())
      .find(timer => timer.intervalMs === 60_000);
    expect(roomTimer).toBeDefined();
    expect(visitorTimer).toBeDefined();

    roomTimer?.callback();
    visitorTimer?.callback();
    expect(calls).toEqual([
      "rooms.cleanup",
      "roomAccess.cleanup",
      "visitors.list",
      "rooms.remove:visitor-a",
      "roomAccess.remove:visitor-a",
      "visitors.remove:visitor-a",
      "rooms.remove:visitor-b",
      "roomAccess.remove:visitor-b",
      "visitors.remove:visitor-b",
      "rateLimits.sweep",
    ]);
    expect(notifications).toHaveLength(2);

    maintenance.stop();
    maintenance.stop();
    expect(cleared).toHaveLength(2);
    expect(scheduled.size).toBe(0);

    roomTimer?.callback();
    visitorTimer?.callback();
    expect(calls).toHaveLength(10);
    expect(notifications).toHaveLength(2);
  });

  test("expires requests after room cleanup without republishing access transitions", () => {
    let now = 1_000;
    let visitorIndex = 0;
    const visitors = createVisitorService({
      now: () => now,
      createId: () => `visitor-${++visitorIndex}`,
      createToken: () => `token-${visitorIndex}`,
      createAvatarSeed: () => `avatar-${visitorIndex}`,
    });
    const sender = visitors.tryCreateVisitor();
    const receiver = visitors.tryCreateVisitor();
    if (!sender.ok || !receiver.ok) throw new Error("visitor setup failed");
    const rooms = createRoomService({
      visitors,
      inviteCrypto: createNodeRoomInviteCrypto(),
      now: () => now,
      ttlMs: 10,
      attachTimeoutMs: 100,
      createCode: () => "100001",
      createPlanId: () => crypto.randomUUID(),
    });
    const created = rooms.prepareCreate(sender.visitor.token);
    if (!created.ok) throw new Error("room setup failed");
    expect(rooms.commit(created.plan).ok).toBe(true);
    expect(rooms.attach("100001", sender.visitor.id, "sender").ok).toBe(true);

    const roomAccess = createRoomAccessService({
      rooms,
      visitors,
      now: () => now,
      requestTtlMs: 1_000,
      createRequestId: () => "request-1",
    });
    expect(roomAccess.createOrGetPending("100001", receiver.visitor.token)).toEqual({
      ok: true,
      receipt: {
        requestId: "request-1",
        state: "pending",
        expiresAt: 2_000,
      },
    });

    const accessTransitions: string[] = [];
    roomAccess.subscribe(() => {
      throw new Error("subscriber failure");
    });
    roomAccess.subscribe(transition => accessTransitions.push(transition.type));
    const maintenance = createMaintenanceService({
      rooms,
      roomAccess,
      visitors,
      rateLimits: { sweep: () => 0 },
    });
    const maintenanceEvents: Array<readonly MaintenanceEvent[]> = [];
    maintenance.subscribe(events => maintenanceEvents.push(events));

    now = 1_010;
    expect(maintenance.sweepRooms()).toEqual([
      left("100001", sender.visitor.id),
    ]);
    expect(accessTransitions).toEqual(["room:join-request-resolved"]);
    expect(maintenanceEvents).toEqual([[
      left("100001", sender.visitor.id),
    ]]);
    expect(roomAccess.readReceipt(
      "100001",
      "request-1",
      receiver.visitor.token,
    )).toMatchObject({
      ok: true,
      receipt: { state: "expired" },
    });
  });
});
