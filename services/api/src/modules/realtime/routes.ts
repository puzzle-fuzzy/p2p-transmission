import { Elysia, t } from "elysia";
import type { AppContext } from "../../context";
import { createRealtimeHub, type RealtimeSocket } from "./hub";

const peerSessionIdSchema = t.String({ minLength: 1, maxLength: 96 });

const offerDescriptionSchema = t.Object({
  type: t.Literal("offer"),
  sdp: t.String(),
});

const answerDescriptionSchema = t.Object({
  type: t.Literal("answer"),
  sdp: t.String(),
});

const iceCandidateSchema = t.Object({
  candidate: t.String(),
  sdpMid: t.Union([t.String(), t.Null()]),
  sdpMLineIndex: t.Union([t.Number(), t.Null()]),
  usernameFragment: t.Union([t.String(), t.Null()]),
});

const clientMessageSchema = t.Union([
  t.Object({
    type: t.Literal("room:join"),
    roomCode: t.String(),
    role: t.Union([t.Literal("sender"), t.Literal("receiver")]),
  }),
  t.Object({
    type: t.Literal("room:leave"),
    roomCode: t.String(),
  }),
  t.Object({
    type: t.Literal("signal:offer"),
    roomCode: t.String(),
    to: t.String(),
    peerSessionId: peerSessionIdSchema,
    description: offerDescriptionSchema,
  }),
  t.Object({
    type: t.Literal("signal:answer"),
    roomCode: t.String(),
    to: t.String(),
    peerSessionId: peerSessionIdSchema,
    description: answerDescriptionSchema,
  }),
  t.Object({
    type: t.Literal("signal:ice"),
    roomCode: t.String(),
    to: t.String(),
    peerSessionId: peerSessionIdSchema,
    candidate: t.Union([iceCandidateSchema, t.Null()]),
  }),
]);

export const realtimeRoutes = (context: AppContext) => {
  const hub = createRealtimeHub(context);

  return new Elysia()
    .ws("/v1/realtime", {
      query: t.Object({
        token: t.String(),
      }),
      body: clientMessageSchema,
      open(ws) {
        const socket: RealtimeSocket = {
          id: ws.id,
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
