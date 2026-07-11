export type RateLimitCheck = {
  key: string;
  limit: number;
  windowMs: number;
};

export type RateLimitError =
  | {
      code: "RATE_LIMITED";
      message: string;
      retryAfterMs: number;
    }
  | {
      code: "CAPACITY_EXCEEDED";
      message: string;
    };

export type RateLimitResult =
  | { ok: true }
  | { ok: false; error: RateLimitError };
