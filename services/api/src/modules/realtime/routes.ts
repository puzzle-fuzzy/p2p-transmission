import { Elysia, t } from "elysia";
import type { AppContext } from "../../context";
import { createRealtimeHub, type RealtimeSocket } from "./hub";

const signalPayload = {
  type: t.Union([
    t.Literal("signal:offer"),
    t.Literal("signal:answer"),
    t.Literal("signal:ice"),
  ]),
  roomCode: t.String(),
  to: t.String(),
  sdp: t.Optional(t.Any()),
  candidate: t.Optional(t.Any()),
};

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
  t.Object(signalPayload),
  t.Object({
    type: t.Literal("transfer:prepare"),
    roomCode: t.String(),
    items: t.Array(t.Object({
      id: t.String(),
      kind: t.Union([t.Literal("text"), t.Literal("file")]),
      name: t.Optional(t.String()),
      size: t.Optional(t.Number()),
      mimeType: t.Optional(t.String()),
    })),
  }),
  t.Object({
    type: t.Literal("transfer:state"),
    roomCode: t.String(),
    state: t.Union([
      t.Literal("ready"),
      t.Literal("transferring"),
      t.Literal("done"),
      t.Literal("error"),
    ]),
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
