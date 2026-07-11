import { Elysia } from "elysia";
import { createDefaultContext, type AppContext } from "./context";
import { realtimeRoutes } from "./modules/realtime/routes";
import { roomRoutes } from "./modules/room/routes";
import { visitorRoutes } from "./modules/visitor/routes";

export const createApp = (context: AppContext = createDefaultContext()) =>
  new Elysia()
    .onRequest(({ set }) => {
      set.headers["access-control-allow-origin"] = "*";
      set.headers["access-control-allow-methods"] = "GET,POST,OPTIONS";
      set.headers["access-control-allow-headers"] = "content-type,authorization";
    })
    .options("/*", ({ status }) => status(204))
    .get("/health", () => ({ ok: true }))
    .use(visitorRoutes(context))
    .use(roomRoutes(context))
    .use(realtimeRoutes(context));
