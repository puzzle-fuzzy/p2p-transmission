import { Elysia } from "elysia";
import type { AppContext } from "../../context";

const HOUR_MS = 60 * 60 * 1_000;

export const visitorRoutes = (context: AppContext) =>
  new Elysia({ prefix: "/v1/visitors" })
    .post("/", ({ headers, request, server, set, status }) => {
      context.maintenance.sweepForAdmission();
      const clientIp = context.clientIp.resolve({
        directAddress: server?.requestIP(request)?.address,
        headers,
      });
      const limited = context.rateLimits.consumeMany([{
        key: `visitor:create:ip:${clientIp}`,
        limit: 30,
        windowMs: HOUR_MS,
      }]);
      if (!limited.ok) {
        if (limited.error.code === "RATE_LIMITED") {
          set.headers["retry-after"] = String(
            Math.ceil(limited.error.retryAfterMs / 1_000),
          );
          return status(429, { error: limited.error });
        }
        return status(503, { error: limited.error });
      }

      const result = context.visitors.tryCreateVisitor();
      if (!result.ok) return status(503, { error: result.error });

      return {
        visitor: context.visitors.toPublic(result.visitor),
        token: result.visitor.token,
      };
    });
