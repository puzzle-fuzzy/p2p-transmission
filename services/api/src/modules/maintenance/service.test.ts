import { describe, expect, test } from "bun:test";
import type { RoomTransition } from "../room/model";
import { createMaintenanceService } from "./service";

const left = (roomCode: string, visitorId: string): RoomTransition => ({
  type: "participant:left",
  roomCode,
  visitorId,
});

const createHarness = () => {
  const calls: string[] = [];
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
    maintenance: createMaintenanceService({ rooms, visitors, rateLimits }),
  };
};

describe("maintenance service", () => {
  test("owns the complete admission sweep in deterministic cascade order", () => {
    const { calls, maintenance } = createHarness();

    expect(maintenance.sweepForAdmission()).toEqual([
      left("100001", "room-expired"),
      left("room-visitor-a", "visitor-a"),
      left("room-visitor-b", "visitor-b"),
      { type: "visitor:expired", visitorId: "visitor-a" },
      { type: "visitor:expired", visitorId: "visitor-b" },
    ]);
    expect(calls).toEqual([
      "rooms.cleanup",
      "visitors.list",
      "rooms.remove:visitor-a",
      "rooms.remove:visitor-b",
      "visitors.remove:visitor-a",
      "visitors.remove:visitor-b",
      "rateLimits.sweep",
    ]);
  });

  test("sweeps only room and attach deadlines on the room cadence", () => {
    const { calls, maintenance } = createHarness();

    expect(maintenance.sweepRooms()).toEqual([
      left("100001", "room-expired"),
    ]);
    expect(calls).toEqual(["rooms.cleanup"]);
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
      "rooms.remove:visitor-b",
      "visitors.remove:visitor-a",
      "visitors.remove:visitor-b",
      "rateLimits.sweep",
    ]);
  });
});
