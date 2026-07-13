import { cors } from "@elysia/cors";
import { Elysia } from "elysia";
import { createDefaultContext, type AppContext } from "./context";
import { realtimeRoutes } from "./modules/realtime/routes";
import { roomAccessRoutes } from "./modules/room-access/routes";
import { roomRoutes } from "./modules/room/routes";
import { visitorRoutes } from "./modules/visitor/routes";

export const MAX_REALTIME_PAYLOAD_BYTES = 512 * 1_024;

export const createApp = (context: AppContext = createDefaultContext()) =>
  // Exact request contracts are security boundaries. Do not silently strip
  // caller-supplied fields before schema validation.
  new Elysia({
    normalize: false,
    websocket: {
      maxPayloadLength: MAX_REALTIME_PAYLOAD_BYTES,
    },
  })
    .onRequest(({ request, set }) => {
      const pathname = new URL(request.url).pathname;
      if (pathname !== "/v1" && !pathname.startsWith("/v1/")) return;
      set.headers["cache-control"] = "no-store";
      set.headers["referrer-policy"] = "no-referrer";
    })
    .onAfterHandle(() => {
      context.stateStore?.save();
    })
    .use(cors({
      origin: context.config.corsAllowedOrigins,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["content-type", "authorization"],
      credentials: false,
    }))
    .onError(({ code, status }) => {
      if (code !== "VALIDATION" && code !== "PARSE") return;

      return status(code === "VALIDATION" ? 422 : 400, {
        error: {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        },
      });
    })
    .get("/health", () => ({ ok: true }))
    .use(visitorRoutes(context))
    .use(roomRoutes(context))
    .use(roomAccessRoutes(context))
    .use(realtimeRoutes(context));
