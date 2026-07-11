import { describe, expect, test } from "bun:test";
import { createVisitorService } from "./service";

describe("visitor service", () => {
  test("creates a temporary visitor with token-backed lookup", () => {
    const visitors = createVisitorService({
      now: () => 1_000,
      createId: () => "vis_001",
      createToken: () => "tok_001",
      createAvatarSeed: () => "avatar_001",
    });

    const created = visitors.createVisitor();

    expect(created).toEqual({
      id: "vis_001",
      avatarSeed: "avatar_001",
      displayName: "访客 0001",
      token: "tok_001",
      createdAt: 1_000,
      lastSeenAt: 1_000,
    });
    expect(visitors.getByToken("tok_001")).toEqual(created);
  });

  test("exposes public visitor fields without leaking token", () => {
    const visitors = createVisitorService({
      now: () => 2_000,
      createId: () => "vis_002",
      createToken: () => "tok_002",
      createAvatarSeed: () => "avatar_002",
    });

    const visitor = visitors.createVisitor();

    expect(visitors.toPublic(visitor)).toEqual({
      id: "vis_002",
      avatarSeed: "avatar_002",
      displayName: "访客 0002",
      createdAt: 2_000,
      lastSeenAt: 2_000,
    });
  });

  test("touch updates last seen for valid tokens only", () => {
    let currentTime = 3_000;
    const visitors = createVisitorService({
      now: () => currentTime,
      createId: () => "vis_003",
      createToken: () => "tok_003",
      createAvatarSeed: () => "avatar_003",
    });

    visitors.createVisitor();
    currentTime = 4_000;

    expect(visitors.touch("tok_003")?.lastSeenAt).toBe(4_000);
    expect(visitors.touch("missing")).toBeUndefined();
  });

  test("allows exactly 10,000 visitors and rejects the next without eviction", () => {
    let sequence = 0;
    const visitors = createVisitorService({
      now: () => 1_000,
      createId: () => `vis_${++sequence}`,
      createToken: () => `tok_${sequence}`,
      createAvatarSeed: () => `avatar_${sequence}`,
    });

    for (let index = 0; index < 10_000; index += 1) {
      expect(visitors.tryCreateVisitor().ok).toBe(true);
    }
    expect(visitors.size()).toBe(10_000);
    expect(visitors.tryCreateVisitor()).toEqual({
      ok: false,
      error: { code: "CAPACITY_EXCEEDED", message: "访客容量已满" },
    });
    expect(visitors.size()).toBe(10_000);
  });

  test("detects idle expiry without deleting or self-sweeping", () => {
    let currentTime = 0;
    let sequence = 0;
    const visitors = createVisitorService({
      now: () => currentTime,
      idleTtlMs: 100,
      maxVisitors: 2,
      createId: () => `vis_${++sequence}`,
      createToken: () => `tok_${sequence}`,
      createAvatarSeed: () => `avatar_${sequence}`,
    });
    const first = visitors.createVisitor();
    currentTime = 50;
    const second = visitors.createVisitor();
    currentTime = 100;

    expect(visitors.listExpiredVisitorIds()).toEqual([first.id]);
    expect(visitors.getByToken(first.token)).toBeUndefined();
    expect(visitors.getById(first.id)).toEqual(first);
    expect(visitors.tryCreateVisitor().ok).toBe(false);
    expect(visitors.size()).toBe(2);
    expect(visitors.getByToken(second.token)).toEqual(second);
  });

  test("touch extends TTL and remove clears both lookup maps", () => {
    let currentTime = 0;
    const visitors = createVisitorService({
      now: () => currentTime,
      idleTtlMs: 100,
      createId: () => "vis_touch",
      createToken: () => "tok_touch",
      createAvatarSeed: () => "avatar_touch",
    });
    const visitor = visitors.createVisitor();

    currentTime = 99;
    expect(visitors.touch(visitor.token)?.lastSeenAt).toBe(99);
    currentTime = 150;
    expect(visitors.listExpiredVisitorIds()).toEqual([]);
    expect(visitors.remove(visitor.id)).toBe(true);
    expect(visitors.remove(visitor.id)).toBe(false);
    expect(visitors.getById(visitor.id)).toBeUndefined();
    expect(visitors.getByToken(visitor.token)).toBeUndefined();
    expect(visitors.size()).toBe(0);
  });

  test("createVisitor preserves its success return type and throws at capacity", () => {
    let sequence = 0;
    const visitors = createVisitorService({
      maxVisitors: 1,
      createId: () => `vis_${++sequence}`,
      createToken: () => `tok_${sequence}`,
      createAvatarSeed: () => `avatar_${sequence}`,
    });

    expect(visitors.createVisitor().id).toBe("vis_1");
    expect(() => visitors.createVisitor()).toThrow("访客容量已满");
  });
});
