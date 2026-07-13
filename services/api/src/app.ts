import { cors } from "@elysia/cors";
import { Elysia } from "elysia";
import { createDefaultContext, type AppContext } from "./context";
import { realtimeRoutes } from "./modules/realtime/routes";
import { roomAccessRoutes } from "./modules/room-access/routes";
import { roomRoutes } from "./modules/room/routes";
import { visitorRoutes } from "./modules/visitor/routes";

export const createApp = (context: AppContext = createDefaultContext()) =>
  // Exact request contracts are security boundaries. Do not silently strip
  // caller-supplied fields before schema validation.
  new Elysia({ normalize: false })
    .use(cors({
      origin: context.config.corsAllowedOrigins,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["content-type", "authorization"],
      credentials: false,
    }))
    .onRequest(({ request, set }) => {
      const pathname = new URL(request.url).pathname;
      if (pathname !== "/v1/rooms" && !pathname.startsWith("/v1/rooms/")) return;
      set.headers["cache-control"] = "no-store";
      set.headers["referrer-policy"] = "no-referrer";
    })
    .get("/health", () => ({ ok: true }))
    .use(visitorRoutes(context))
    .use(roomRoutes(context))
    .use(roomAccessRoutes(context))
    .use(realtimeRoutes(context));
