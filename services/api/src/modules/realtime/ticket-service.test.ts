import { describe, expect, test } from "bun:test";
import { createRealtimeTicketService } from "./ticket-service";

describe("realtime connection tickets", () => {
  test("issues an opaque one-time ticket and rejects replay", () => {
    let timestamp = 1_000;
    const service = createRealtimeTicketService({
      getByToken: token => token === "visitor-token"
        ? {
            id: "vis_1",
            avatarSeed: "avatar_1",
            displayName: "访客 0001",
            token,
            createdAt: 1,
            lastSeenAt: timestamp,
          }
        : undefined,
    }, { now: () => timestamp, ttlMs: 60_000 });

    const issued = service.issue("visitor-token");
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.ticket).not.toContain("visitor-token");

    expect(service.consume(issued.ticket)).toEqual({
      ok: true,
      visitorToken: "visitor-token",
    });
    expect(service.consume(issued.ticket)).toEqual({
      ok: false,
      error: {
        code: "REALTIME_TICKET_INVALID",
        message: "实时连接票据无效或已过期",
      },
    });

    timestamp += 1;
  });

  test("expires tickets and limits outstanding tickets per visitor", () => {
    let timestamp = 1_000;
    const visitor = {
      id: "vis_1",
      avatarSeed: "avatar_1",
      displayName: "访客 0001",
      token: "visitor-token",
      createdAt: 1,
      lastSeenAt: timestamp,
    };
    const service = createRealtimeTicketService(
      { getByToken: token => token === visitor.token ? visitor : undefined },
      { now: () => timestamp, ttlMs: 10, maxPerVisitor: 1 },
    );

    const issued = service.issue(visitor.token);
    expect(issued.ok).toBe(true);
    expect(service.issue(visitor.token)).toMatchObject({
      ok: false,
      error: { code: "CAPACITY_EXCEEDED" },
    });
    timestamp += 10;
    if (!issued.ok) return;
    expect(service.consume(issued.ticket)).toMatchObject({
      ok: false,
      error: { code: "REALTIME_TICKET_INVALID" },
    });
  });
});
