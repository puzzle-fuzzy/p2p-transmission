import type {
  RateLimitCheck,
  RateLimitResult,
} from "./model";

type Bucket = {
  count: number;
  limit: number;
  windowMs: number;
  windowStartedAt: number;
};

export type RateLimitServiceOptions = {
  now?: () => number;
  maxKeys?: number;
  retentionMs?: number;
};

export type RateLimitService = {
  consumeMany(checks: readonly RateLimitCheck[]): RateLimitResult;
  sweep(): number;
  size(): number;
};

const assertPositiveSafeInteger = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
};

const normalizeChecks = (checks: readonly RateLimitCheck[]) => {
  const normalized = new Map<string, RateLimitCheck>();

  for (const check of checks) {
    if (!check.key || check.key.length > 256) {
      throw new RangeError("Rate-limit keys must contain 1 to 256 characters");
    }
    assertPositiveSafeInteger(check.limit, "Rate-limit limit");
    assertPositiveSafeInteger(check.windowMs, "Rate-limit window");

    const previous = normalized.get(check.key);
    if (previous) {
      if (previous.limit !== check.limit || previous.windowMs !== check.windowMs) {
        throw new RangeError("Duplicate rate-limit keys must use identical policy");
      }
      continue;
    }
    normalized.set(check.key, { ...check });
  }

  return Array.from(normalized.values());
};

export const createRateLimitService = ({
  now = Date.now,
  maxKeys = 50_000,
  retentionMs = 60_000,
}: RateLimitServiceOptions = {}): RateLimitService => {
  assertPositiveSafeInteger(maxKeys, "Rate-limit key capacity");
  assertPositiveSafeInteger(retentionMs, "Rate-limit retention");
  const buckets = new Map<string, Bucket>();

  return {
    consumeMany(checks) {
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new RangeError("Rate-limit clock must return epoch milliseconds");
      }
      const normalized = normalizeChecks(checks);
      if (normalized.length === 0) return { ok: true };

      const unseen = normalized.filter(check => !buckets.has(check.key)).length;
      if (buckets.size + unseen > maxKeys) {
        return {
          ok: false,
          error: {
            code: "CAPACITY_EXCEEDED",
            message: "限流状态容量已满",
          },
        };
      }

      const prepared = normalized.map(check => {
        const bucket = buckets.get(check.key);
        if (bucket && (bucket.limit !== check.limit || bucket.windowMs !== check.windowMs)) {
          throw new RangeError("A rate-limit key cannot change policy while retained");
        }
        const windowExpired = !bucket
          || timestamp >= bucket.windowStartedAt + check.windowMs;
        return {
          check,
          count: windowExpired ? 0 : bucket.count,
          windowStartedAt: windowExpired ? timestamp : bucket.windowStartedAt,
        };
      });

      for (const candidate of prepared) {
        if (candidate.count + 1 <= candidate.check.limit) continue;
        return {
          ok: false,
          error: {
            code: "RATE_LIMITED",
            message: "请求过于频繁，请稍后重试",
            retryAfterMs: Math.max(
              1,
              candidate.windowStartedAt + candidate.check.windowMs - timestamp,
            ),
          },
        };
      }

      for (const candidate of prepared) {
        buckets.set(candidate.check.key, {
          count: candidate.count + 1,
          limit: candidate.check.limit,
          windowMs: candidate.check.windowMs,
          windowStartedAt: candidate.windowStartedAt,
        });
      }
      return { ok: true };
    },
    sweep() {
      const timestamp = now();
      let removed = 0;
      for (const [key, bucket] of buckets) {
        if (timestamp < bucket.windowStartedAt + bucket.windowMs + retentionMs) {
          continue;
        }
        buckets.delete(key);
        removed += 1;
      }
      return removed;
    },
    size() {
      return buckets.size;
    },
  };
};
