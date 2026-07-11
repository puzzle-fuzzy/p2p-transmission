import { describe, expect, test } from "bun:test";
import { createRoomService } from "../room/service";
import { createVisitorService } from "../visitor/service";
import { createRealtimeHub, type RealtimeSocket } from "./hub";

const createSocket = (id: string) => {
  const sent: unknown[] = [];
  const socket: RealtimeSocket = {
    id,
    send: message => sent.push(message),
    close: () => sent.push({ type: "closed" }),
  };

  return { socket, sent };
};

const createHarness = () => {
  let visitorIndex = 0;
  const visitors = createVisitorService({
    now: () => 5_000,
    createId: () => `vis_${String(++visitorIndex).padStart(3, "0")}`,
    createToken: () => `tok_${String(visitorIndex).padStart(3, "0")}`,
    createAvatarSeed: () => `avatar_${String(visitorIndex).padStart(3, "0")}`,
  });
  const rooms = createRoomService({
    visitors,
    now: () => 5_000,
    createCode: () => "345678",
  });
  const hub = createRealtimeHub({ visitors, rooms });

  return { visitors, rooms, hub };
};

describe("realtime hub", () => {
  test("rejects sockets with invalid visitor tokens", () => {
    const { hub } = createHarness();
    const { socket, sent } = createSocket("socket_1");

    const result = hub.connect(socket, "bad_token");

    expect(result).toEqual({
      ok: false,
      error: {
        code: "VISITOR_NOT_FOUND",
        message: "访客不存在或已过期",
      },
    });
    expect(sent).toEqual([
      {
        type: "error",
        code: "VISITOR_NOT_FOUND",
        message: "访客不存在或已过期",
      },
      { type: "closed" },
    ]);
  });

  test("broadcasts room participants after a receiver joins", () => {
    const { visitors, rooms, hub } = createHarness();
    const sender = visitors.createVisitor();
    const receiver = visitors.createVisitor();
    const created = rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    const senderSocket = createSocket("socket_sender");
    const receiverSocket = createSocket("socket_receiver");

    hub.connect(senderSocket.socket, sender.token);
    hub.handleMessage(senderSocket.socket.id, {
      type: "room:join",
      roomCode: created.room.code,
      role: "sender",
    });
    hub.connect(receiverSocket.socket, receiver.token);
    hub.handleMessage(receiverSocket.socket.id, {
      type: "room:join",
      roomCode: created.room.code,
      role: "receiver",
    });

    expect(senderSocket.sent[senderSocket.sent.length - 1]).toMatchObject({
      type: "room:participants",
      room: {
        code: "345678",
        receivers: ["vis_002"],
      },
    });
    expect(receiverSocket.sent[receiverSocket.sent.length - 1]).toMatchObject({
      type: "room:participants",
      room: {
        code: "345678",
        receivers: ["vis_002"],
      },
    });
  });

  test("forwards signaling messages to the targeted participant only", () => {
    const { visitors, rooms, hub } = createHarness();
    const sender = visitors.createVisitor();
    const receiver = visitors.createVisitor();
    const created = rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    const senderSocket = createSocket("socket_sender");
    const receiverSocket = createSocket("socket_receiver");

    hub.connect(senderSocket.socket, sender.token);
    hub.handleMessage(senderSocket.socket.id, { type: "room:join", roomCode: created.room.code, role: "sender" });
    hub.connect(receiverSocket.socket, receiver.token);
    hub.handleMessage(receiverSocket.socket.id, { type: "room:join", roomCode: created.room.code, role: "receiver" });
    hub.handleMessage(senderSocket.socket.id, {
      type: "signal:offer",
      roomCode: created.room.code,
      to: receiver.id,
      sdp: { type: "offer" },
    });

    expect(receiverSocket.sent[receiverSocket.sent.length - 1]).toEqual({
      type: "signal:offer",
      roomCode: "345678",
      from: sender.id,
      sdp: { type: "offer" },
    });
    expect(senderSocket.sent[senderSocket.sent.length - 1]).toMatchObject({ type: "room:participants" });
  });

  test("broadcasts participant leave on disconnect", () => {
    const { visitors, rooms, hub } = createHarness();
    const sender = visitors.createVisitor();
    const receiver = visitors.createVisitor();
    const created = rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    const senderSocket = createSocket("socket_sender");
    const receiverSocket = createSocket("socket_receiver");

    hub.connect(senderSocket.socket, sender.token);
    hub.handleMessage(senderSocket.socket.id, { type: "room:join", roomCode: created.room.code, role: "sender" });
    hub.connect(receiverSocket.socket, receiver.token);
    hub.handleMessage(receiverSocket.socket.id, { type: "room:join", roomCode: created.room.code, role: "receiver" });
    hub.disconnect(receiverSocket.socket.id);

    expect(senderSocket.sent[senderSocket.sent.length - 1]).toEqual({
      type: "participant:left",
      roomCode: "345678",
      visitorId: receiver.id,
    });
  });
});
