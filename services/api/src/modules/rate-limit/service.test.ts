import { describe, expect, test } from "bun:test";
import { createRateLimitService } from "./service";

describe("rate limit service", () => {
  test("increments multiple dimensions atomically", () => {
    const limiter = createRateLimitService({ now: () => 1_000 });
    const checks = [
      { key: "global:turn", limit: 300, windowMs: 60_000 },
      { key: "ip:203.0.113.1:turn", limit: 20, windowMs: 60_000 },
    ];

    expect(limiter.consumeMany(checks)).toEqual({ ok: true });
    expect(limiter.size()).toBe(2);
  });

  test("does not increment any key when one dimension is exhausted", () => {
    let now = 1_000;
    const limiter = createRateLimitService({ now: () => now });
    const global = { key: "global", limit: 10, windowMs: 60_000 };
    const visitor = { key: "visitor", limit: 1, windowMs: 60_000 };

    expect(limiter.consumeMany([visitor])).toEqual({ ok: true });
    const rejected = limiter.consumeMany([global, visitor]);
    expect(rejected).toEqual({
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: "请求过于频繁，请稍后重试",
        retryAfterMs: 60_000,
      },
    });

    now += 1;
    expect(limiter.consumeMany([global])).toEqual({ ok: true });
  });

  test("resets exactly at the window boundary", () => {
    let now = 1_000;
    const limiter = createRateLimitService({ now: () => now });
    const check = { key: "ip:create", limit: 1, windowMs: 60_000 };

    expect(limiter.consumeMany([check]).ok).toBe(true);
    expect(limiter.consumeMany([check]).ok).toBe(false);
    now = 61_000;
    expect(limiter.consumeMany([check])).toEqual({ ok: true });
  });

  test("deduplicates identical checks without double counting", () => {
    const limiter = createRateLimitService();
    const check = { key: "room:123456", limit: 1, windowMs: 60_000 };

    expect(limiter.consumeMany([check, check])).toEqual({ ok: true });
    expect(limiter.consumeMany([check])).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED" },
    });
  });

  test("rejects unseen keys at capacity but still serves retained keys", () => {
    const limiter = createRateLimitService({ maxKeys: 2 });
    const first = { key: "first", limit: 2, windowMs: 60_000 };
    const second = { key: "second", limit: 2, windowMs: 60_000 };
    const third = { key: "third", limit: 2, windowMs: 60_000 };

    expect(limiter.consumeMany([first, second])).toEqual({ ok: true });
    expect(limiter.consumeMany([third])).toEqual({
      ok: false,
      error: { code: "CAPACITY_EXCEEDED", message: "限流状态容量已满" },
    });
    expect(limiter.consumeMany([first])).toEqual({ ok: true });
  });

  test("sweeps only after window plus retention", () => {
    let now = 0;
    const limiter = createRateLimitService({
      now: () => now,
      retentionMs: 60_000,
    });
    limiter.consumeMany([{ key: "visitor:create", limit: 1, windowMs: 3_600_000 }]);

    now = 3_660_000 - 1;
    expect(limiter.sweep()).toBe(0);
    now += 1;
    expect(limiter.sweep()).toBe(1);
    expect(limiter.size()).toBe(0);
  });

  test("validates checks and conflicting duplicate policy", () => {
    const limiter = createRateLimitService();

    expect(() => limiter.consumeMany([{ key: "", limit: 1, windowMs: 1 }]))
      .toThrow(RangeError);
    expect(() => limiter.consumeMany([
      { key: "same", limit: 1, windowMs: 1 },
      { key: "same", limit: 2, windowMs: 1 },
    ])).toThrow(RangeError);
  });
});
