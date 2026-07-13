import { Elysia, t } from "elysia";
import type { AppContext } from "../../context";
import type {
  RoomAccessOperationResult,
  RoomBootstrapError,
  RoomBootstrapResult,
  RoomOwnerBootstrapResult,
} from "./bootstrap";

export const iceModeSchema = t.Union([
  t.Literal("off"),
  t.Literal("api"),
]);

export const roomCodeParamsSchema = t.Object({
  code: t.String({ pattern: "^[0-9]{6}$" }),
}, { additionalProperties: false });

const inviteJoinBodySchema = t.Object({
  iceMode: iceModeSchema,
  admission: t.Object({
    kind: t.Literal("invite"),
    inviteToken: t.String({ minLength: 1, maxLength: 128 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const recoveryJoinBodySchema = t.Object({
  iceMode: iceModeSchema,
  admission: t.Object({
    kind: t.Literal("recovery"),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const createRoomBodySchema = t.Object({
  iceMode: iceModeSchema,
}, { additionalProperties: false });

export const tokenFromHeaders = (
  headers: Record<string, string | undefined>,
) => {
  const authorization = headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return "";
  return authorization.slice("Bearer ".length).trim();
};

const statusForBootstrapError = (error: RoomBootstrapError) => {
  switch (error.code) {
    case "RATE_LIMITED":
      return 429;
    case "CAPACITY_EXCEEDED":
    case "TURN_NOT_CONFIGURED":
      return 503;
    case "ROOM_JOIN_REQUEST_REJECTED":
      return 403;
    case "ROOM_JOIN_REQUEST_CANCELLED":
    case "ROOM_JOIN_REQUEST_EXPIRED":
      return 410;
    case "ROOM_SENDER_EXISTS":
    case "ROOM_JOIN_REQUEST_NOT_APPROVED":
    case "INVALID_STATE":
      return 409;
    case "ROOM_NOT_FOUND":
    case "ROOM_EXPIRED":
    case "ROOM_ACCESS_DENIED":
    case "ROOM_REQUEST_UNAVAILABLE":
    case "ROOM_JOIN_REQUEST_NOT_FOUND":
      return 404;
    case "VISITOR_NOT_FOUND":
    case "ROOM_MEMBERSHIP_REQUIRED":
      return 401;
  }
};

type RouteSet = {
  headers: Record<string, string | number | readonly string[]>;
};

type RouteStatus = (code: number, body: unknown) => unknown;

const errorResponse = (
  error: RoomBootstrapError,
  set: RouteSet,
  status: RouteStatus,
) => {
  if (error.code === "RATE_LIMITED") {
    set.headers["retry-after"] = String(Math.ceil(error.retryAfterMs / 1_000));
  }
  return status(statusForBootstrapError(error), { error });
};

export const bootstrapResponse = (
  result: RoomBootstrapResult | RoomOwnerBootstrapResult,
  set: RouteSet,
  status: RouteStatus,
) => result.ok
  ? result.bootstrap
  : errorResponse(result.error, set, status);

export const roomAccessResponse = (
  result: RoomAccessOperationResult,
  set: RouteSet,
  status: RouteStatus,
  successStatus = 200,
) => result.ok
  ? status(successStatus, result.receipt)
  : errorResponse(result.error, set, status);

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
      body: createRoomBodySchema,
    })
    .post("/:code/join", ({ body, headers, params, request, server, set, status }) => {
      const result = context.roomBootstrap.joinRoom({
        code: params.code,
        visitorToken: tokenFromHeaders(headers),
        clientIp: context.clientIp.resolve({
          directAddress: server?.requestIP(request)?.address,
          headers,
        }),
        iceMode: body.iceMode,
        admission: body.admission,
      });
      return bootstrapResponse(result, set, status);
    }, {
      params: roomCodeParamsSchema,
      body: t.Union([
        inviteJoinBodySchema,
        recoveryJoinBodySchema,
      ]),
    });
