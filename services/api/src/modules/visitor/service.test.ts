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
});
