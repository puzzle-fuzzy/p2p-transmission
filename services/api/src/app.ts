import { cors } from "@elysia/cors";
import { Elysia } from "elysia";
import { createDefaultContext, type AppContext } from "./context";
import { realtimeRoutes } from "./modules/realtime/routes";
import { roomRoutes } from "./modules/room/routes";
import { visitorRoutes } from "./modules/visitor/routes";

export const createApp = (context: AppContext = createDefaultContext()) =>
  new Elysia()
    .use(cors({
      origin: context.config.corsAllowedOrigins,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["content-type", "authorization"],
      credentials: false,
    }))
    .get("/health", () => ({ ok: true }))
    .use(visitorRoutes(context))
    .use(roomRoutes(context))
    .use(realtimeRoutes(context));
