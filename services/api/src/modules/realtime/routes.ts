import { Elysia, t } from "elysia";
import type { AppContext } from "../../context";
import { createRealtimeHub, type RealtimeSocket } from "./hub";
import type { ServerRealtimeMessage } from "./model";

const peerSessionIdSchema = t.String({ minLength: 1, maxLength: 96 });
const roomCodeSchema = t.String({ pattern: "^[0-9]{6}$" });
const visitorIdSchema = t.String({ minLength: 1, maxLength: 96 });
const sessionDescriptionSchema = t.String({ minLength: 1, maxLength: 262_144 });

const offerDescriptionSchema = t.Object({
  type: t.Literal("offer"),
  sdp: sessionDescriptionSchema,
}, { additionalProperties: false });

const answerDescriptionSchema = t.Object({
  type: t.Literal("answer"),
  sdp: sessionDescriptionSchema,
}, { additionalProperties: false });

const iceCandidateSchema = t.Object({
  candidate: t.String({ maxLength: 4_096 }),
  sdpMid: t.Union([t.String({ maxLength: 256 }), t.Null()]),
  sdpMLineIndex: t.Union([
    t.Integer({ minimum: 0, maximum: 65_535 }),
    t.Null(),
  ]),
  usernameFragment: t.Union([t.String({ maxLength: 256 }), t.Null()]),
}, { additionalProperties: false });

const clientMessageSchema = t.Union([
  t.Object({
    type: t.Literal("room:attach"),
    roomCode: roomCodeSchema,
    role: t.Union([t.Literal("sender"), t.Literal("receiver")]),
  }, { additionalProperties: false }),
  t.Object({
    type: t.Literal("room:leave"),
    roomCode: roomCodeSchema,
  }, { additionalProperties: false }),
  t.Object({
    type: t.Literal("signal:offer"),
    roomCode: roomCodeSchema,
    to: visitorIdSchema,
    peerSessionId: peerSessionIdSchema,
    description: offerDescriptionSchema,
  }, { additionalProperties: false }),
  t.Object({
    type: t.Literal("signal:answer"),
    roomCode: roomCodeSchema,
    to: visitorIdSchema,
    peerSessionId: peerSessionIdSchema,
    description: answerDescriptionSchema,
  }, { additionalProperties: false }),
  t.Object({
    type: t.Literal("signal:ice"),
    roomCode: roomCodeSchema,
    to: visitorIdSchema,
    peerSessionId: peerSessionIdSchema,
    candidate: t.Union([iceCandidateSchema, t.Null()]),
  }, { additionalProperties: false }),
]);

const invalidRealtimeMessage = Object.freeze({
  type: "error" as const,
  code: "INVALID_REALTIME_MESSAGE",
  message: "实时消息格式无效",
});

const realtimeProcessingError = Object.freeze({
  type: "error" as const,
  code: "REALTIME_INTERNAL_ERROR",
  message: "实时消息处理失败",
});

export const toRealtimeErrorMessage = (error: unknown): ServerRealtimeMessage => {
  const code = (
    typeof error === "object"
    && error !== null
    && "code" in error
  )
    ? error.code
    : undefined;

  return code === "VALIDATION" || code === "PARSE"
    ? invalidRealtimeMessage
    : realtimeProcessingError;
};

export const realtimeRoutes = (context: AppContext) => {
  const hub = createRealtimeHub(context);

  return new Elysia()
    .ws("/v1/realtime", {
      headers: t.Object({
        origin: t.Optional(t.String()),
      }),
      query: t.Object({
        token: t.String({ minLength: 1, maxLength: 128 }),
      }, { additionalProperties: false }),
      body: clientMessageSchema,
      error({ error }) {
        return toRealtimeErrorMessage(error);
      },
      open(ws) {
        const socket: RealtimeSocket = {
          id: ws.id,
          origin: ws.data.headers.origin ?? null,
          send: message => ws.send(message),
          close: () => ws.close(),
        };

        hub.connect(socket, ws.data.query.token);
      },
      message(ws, message) {
        hub.handleMessage(ws.id, message);
      },
      close(ws) {
        hub.disconnect(ws.id);
      },
    });
};
