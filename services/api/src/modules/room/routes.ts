import { Elysia, t } from "elysia";
import type { AppContext } from "../../context";
import type { RoomError, RoomResult } from "./model";

const tokenFromHeaders = (headers: Record<string, string | undefined>) => {
  const authorization = headers.authorization;

  if (!authorization?.startsWith("Bearer ")) return "";

  return authorization.slice("Bearer ".length).trim();
};

const statusForRoomError = (error: RoomError) => {
  if (error.code === "ROOM_NOT_FOUND") return 404;
  if (error.code === "ROOM_SENDER_EXISTS") return 409;

  return 401;
};

const roomResponse = (result: RoomResult, status: (code: number, body: unknown) => unknown) => {
  if (result.ok) return { room: result.room };

  return status(statusForRoomError(result.error), { error: result.error });
};

export const roomRoutes = (context: AppContext) =>
  new Elysia({ prefix: "/v1/rooms" })
    .post("/", ({ headers, status }) => {
      const result = context.rooms.createRoom(tokenFromHeaders(headers));

      return roomResponse(result, status);
    })
    .post("/:code/join", ({ body, headers, params, status }) => {
      const result = context.rooms.joinRoom(
        params.code,
        tokenFromHeaders(headers),
        body.role,
      );

      return roomResponse(result, status);
    }, {
      body: t.Object({
        role: t.Optional(t.Union([
          t.Literal("sender"),
          t.Literal("receiver"),
        ])),
      }),
    })
    .get("/:code", ({ params, status }) => {
      const result = context.rooms.getRoom(params.code);

      return roomResponse(result, status);
    });
