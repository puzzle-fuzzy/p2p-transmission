import { Elysia, t } from "elysia";
import type { AppContext } from "../../context";
import type { RoomBootstrapError, RoomBootstrapResult } from "./bootstrap";
import type { RoomError, RoomResult } from "./model";

const iceModeSchema = t.Union([
  t.Literal("off"),
  t.Literal("api"),
]);

const tokenFromHeaders = (headers: Record<string, string | undefined>) => {
  const authorization = headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return "";
  return authorization.slice("Bearer ".length).trim();
};

const statusForRoomError = (error: RoomError) => {
  if (error.code === "ROOM_NOT_FOUND" || error.code === "ROOM_EXPIRED") return 404;
  if (error.code === "ROOM_SENDER_EXISTS" || error.code === "INVALID_STATE") return 409;
  if (error.code === "CAPACITY_EXCEEDED") return 503;
  return 401;
};

const statusForBootstrapError = (error: RoomBootstrapError) => {
  if (error.code === "RATE_LIMITED") return 429;
  if (error.code === "CAPACITY_EXCEEDED" || error.code === "TURN_NOT_CONFIGURED") {
    return 503;
  }
  if (error.code === "ROOM_NOT_FOUND" || error.code === "ROOM_EXPIRED") return 404;
  if (error.code === "ROOM_SENDER_EXISTS" || error.code === "INVALID_STATE") return 409;
  return 401;
};

const roomResponse = (
  result: RoomResult,
  status: (code: number, body: unknown) => unknown,
) => result.ok
  ? { room: result.room }
  : status(statusForRoomError(result.error), { error: result.error });

const bootstrapResponse = (
  result: RoomBootstrapResult,
  set: { headers: Record<string, string | number | readonly string[]> },
  status: (code: number, body: unknown) => unknown,
) => {
  if (result.ok) {
    if (result.bootstrap.rtcConfiguration) {
      set.headers["cache-control"] = "no-store";
    }
    return result.bootstrap;
  }
  if (result.error.code === "RATE_LIMITED") {
    set.headers["retry-after"] = String(Math.ceil(result.error.retryAfterMs / 1_000));
  }
  return status(statusForBootstrapError(result.error), { error: result.error });
};

export const roomRoutes = (context: AppContext) =>
  new Elysia({ prefix: "/v1/rooms" })
    .post("/", ({ body, headers, request, server, set, status }) => {
      const result = context.roomBootstrap.createRoom({
        visitorToken: tokenFromHeaders(headers),
        clientIp: context.clientIp.resolve({
          directAddress: server?.requestIP(request)?.address,
          headers,
        }),
        iceMode: body.iceMode,
      });
      return bootstrapResponse(result, set, status);
    }, {
      body: t.Object({
        iceMode: iceModeSchema,
      }),
    })
    .post("/:code/join", ({ body, headers, params, request, server, set, status }) => {
      const result = context.roomBootstrap.joinRoom({
        code: params.code,
        visitorToken: tokenFromHeaders(headers),
        clientIp: context.clientIp.resolve({
          directAddress: server?.requestIP(request)?.address,
          headers,
        }),
        role: body.role ?? "receiver",
        iceMode: body.iceMode,
      });
      return bootstrapResponse(result, set, status);
    }, {
      body: t.Object({
        role: t.Optional(t.Union([
          t.Literal("sender"),
          t.Literal("receiver"),
        ])),
        iceMode: iceModeSchema,
      }),
    })
    .get("/:code", ({ params, status }) => {
      const result = context.rooms.getRoom(params.code);
      return roomResponse(result, status);
    });
