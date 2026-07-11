import { describe, expect, test } from "bun:test";
import type {
  IceCandidateDto,
  ServerRealtimeMessage,
  SignalServerMessage,
} from "@p2p/contracts";
import { createRoomService } from "../room/service";
import { createVisitorService } from "../visitor/service";
import { createRealtimeHub, type RealtimeSocket } from "./hub";

const candidate: IceCandidateDto = {
  candidate: "candidate:1 1 UDP 2122260223 192.0.2.1 5000 typ host",
  sdpMid: "0",
  sdpMLineIndex: 0,
  usernameFragment: null,
};

const createSocket = (id: string) => {
  const sent: ServerRealtimeMessage[] = [];
  let closeCount = 0;
  const socket: RealtimeSocket = {
    id,
    send: message => sent.push(message),
    close: () => {
      closeCount += 1;
    },
  };

  return {
    socket,
    sent,
    closeCount: () => closeCount,
  };
};

const signalMessages = (messages: ServerRealtimeMessage[]) =>
  messages.filter((message): message is SignalServerMessage =>
    message.type === "signal:offer"
    || message.type === "signal:answer"
    || message.type === "signal:ice");

const latestErrorCode = (messages: ServerRealtimeMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === "error") return message.code;
  }

  return undefined;
};

const latestMessage = (messages: ServerRealtimeMessage[]) =>
  messages[messages.length - 1];

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
    const socket = createSocket("socket_1");

    const result = hub.connect(socket.socket, "bad_token");

    expect(result).toEqual({
      ok: false,
      error: {
        code: "VISITOR_NOT_FOUND",
        message: "访客不存在或已过期",
      },
    });
    expect(socket.sent).toEqual([{
      type: "error",
      code: "VISITOR_NOT_FOUND",
      message: "访客不存在或已过期",
    }]);
    expect(socket.closeCount()).toBe(1);
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

    expect(latestMessage(senderSocket.sent)).toMatchObject({
      type: "room:participants",
      room: {
        code: "345678",
        receivers: ["vis_002"],
      },
    });
    expect(latestMessage(receiverSocket.sent)).toMatchObject({
      type: "room:participants",
      room: {
        code: "345678",
        receivers: ["vis_002"],
      },
    });
  });

  test("lets a sender offer to a receiver and preserves the signaling DTO", () => {
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
    hub.handleMessage(senderSocket.socket.id, {
      type: "signal:offer",
      roomCode: created.room.code,
      to: receiver.id,
      peerSessionId: "peer_session_1",
      description: { type: "offer", sdp: "v=0\r\n" },
    });

    expect(signalMessages(receiverSocket.sent)).toEqual([{
      type: "signal:offer",
      roomCode: "345678",
      from: sender.id,
      peerSessionId: "peer_session_1",
      description: { type: "offer", sdp: "v=0\r\n" },
    }]);
    expect(signalMessages(senderSocket.sent)).toHaveLength(0);
  });

  test("rejects signaling when the socket did not join the room", () => {
    const { visitors, rooms, hub } = createHarness();
    const sender = visitors.createVisitor();
    const receiver = visitors.createVisitor();
    const created = rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    const senderSocket = createSocket("socket_sender");
    const receiverSocket = createSocket("socket_receiver");

    hub.connect(senderSocket.socket, sender.token);
    hub.connect(receiverSocket.socket, receiver.token);
    hub.handleMessage(receiverSocket.socket.id, {
      type: "room:join",
      roomCode: created.room.code,
      role: "receiver",
    });
    hub.handleMessage(senderSocket.socket.id, {
      type: "signal:offer",
      roomCode: created.room.code,
      to: receiver.id,
      peerSessionId: "peer_session_1",
      description: { type: "offer", sdp: "v=0" },
    });

    expect(signalMessages(receiverSocket.sent)).toHaveLength(0);
    expect(latestErrorCode(senderSocket.sent)).toBe("SIGNAL_NOT_ALLOWED");
  });

  test("rejects a target outside the room", () => {
    const { visitors, rooms, hub } = createHarness();
    const sender = visitors.createVisitor();
    const outsider = visitors.createVisitor();
    const created = rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    const senderSocket = createSocket("socket_sender");
    const outsiderSocket = createSocket("socket_outsider");

    hub.connect(senderSocket.socket, sender.token);
    hub.handleMessage(senderSocket.socket.id, {
      type: "room:join",
      roomCode: created.room.code,
      role: "sender",
    });
    hub.connect(outsiderSocket.socket, outsider.token);
    hub.handleMessage(senderSocket.socket.id, {
      type: "signal:offer",
      roomCode: created.room.code,
      to: outsider.id,
      peerSessionId: "peer_session_1",
      description: { type: "offer", sdp: "v=0" },
    });

    expect(signalMessages(outsiderSocket.sent)).toHaveLength(0);
    expect(latestErrorCode(senderSocket.sent)).toBe("SIGNAL_TARGET_NOT_IN_ROOM");
  });

  test("rejects signaling to self", () => {
    const { visitors, rooms, hub } = createHarness();
    const sender = visitors.createVisitor();
    const created = rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    const senderSocket = createSocket("socket_sender");

    hub.connect(senderSocket.socket, sender.token);
    hub.handleMessage(senderSocket.socket.id, {
      type: "room:join",
      roomCode: created.room.code,
      role: "sender",
    });
    hub.handleMessage(senderSocket.socket.id, {
      type: "signal:offer",
      roomCode: created.room.code,
      to: sender.id,
      peerSessionId: "peer_session_1",
      description: { type: "offer", sdp: "v=0" },
    });

    expect(signalMessages(senderSocket.sent)).toHaveLength(0);
    expect(latestErrorCode(senderSocket.sent)).toBe("SIGNAL_NOT_ALLOWED");
  });

  test("rejects offers from receivers and answers from senders", () => {
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
    hub.handleMessage(receiverSocket.socket.id, {
      type: "signal:offer",
      roomCode: created.room.code,
      to: sender.id,
      peerSessionId: "peer_session_receiver",
      description: { type: "offer", sdp: "v=0" },
    });
    hub.handleMessage(senderSocket.socket.id, {
      type: "signal:answer",
      roomCode: created.room.code,
      to: receiver.id,
      peerSessionId: "peer_session_sender",
      description: { type: "answer", sdp: "v=0" },
    });

    expect(signalMessages(senderSocket.sent)).toHaveLength(0);
    expect(signalMessages(receiverSocket.sent)).toHaveLength(0);
    expect(latestErrorCode(receiverSocket.sent)).toBe("SIGNAL_NOT_ALLOWED");
    expect(latestErrorCode(senderSocket.sent)).toBe("SIGNAL_NOT_ALLOWED");
  });

  test("allows ICE only between sender and receiver roles", () => {
    const { visitors, rooms, hub } = createHarness();
    const sender = visitors.createVisitor();
    const receiverA = visitors.createVisitor();
    const receiverB = visitors.createVisitor();
    const created = rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    const senderSocket = createSocket("socket_sender");
    const receiverASocket = createSocket("socket_receiver_a");
    const receiverBSocket = createSocket("socket_receiver_b");

    for (const [socket, visitor, role] of [
      [senderSocket, sender, "sender"],
      [receiverASocket, receiverA, "receiver"],
      [receiverBSocket, receiverB, "receiver"],
    ] as const) {
      hub.connect(socket.socket, visitor.token);
      hub.handleMessage(socket.socket.id, {
        type: "room:join",
        roomCode: created.room.code,
        role,
      });
    }

    hub.handleMessage(senderSocket.socket.id, {
      type: "signal:ice",
      roomCode: created.room.code,
      to: receiverA.id,
      peerSessionId: "peer_session_1",
      candidate,
    });
    hub.handleMessage(receiverASocket.socket.id, {
      type: "signal:ice",
      roomCode: created.room.code,
      to: sender.id,
      peerSessionId: "peer_session_1",
      candidate: null,
    });
    hub.handleMessage(receiverASocket.socket.id, {
      type: "signal:ice",
      roomCode: created.room.code,
      to: receiverB.id,
      peerSessionId: "peer_session_1",
      candidate,
    });

    expect(signalMessages(receiverASocket.sent)).toEqual([{
      type: "signal:ice",
      roomCode: "345678",
      from: sender.id,
      peerSessionId: "peer_session_1",
      candidate,
    }]);
    expect(signalMessages(senderSocket.sent)).toEqual([{
      type: "signal:ice",
      roomCode: "345678",
      from: receiverA.id,
      peerSessionId: "peer_session_1",
      candidate: null,
    }]);
    expect(signalMessages(receiverBSocket.sent)).toHaveLength(0);
    expect(latestErrorCode(receiverASocket.sent)).toBe("SIGNAL_NOT_ALLOWED");
  });

  test("does not let an old replaced socket disconnect the current socket", () => {
    const { visitors, rooms, hub } = createHarness();
    const sender = visitors.createVisitor();
    const receiver = visitors.createVisitor();
    const created = rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    const oldSenderSocket = createSocket("socket_sender_old");
    const newSenderSocket = createSocket("socket_sender_new");
    const receiverSocket = createSocket("socket_receiver");

    hub.connect(oldSenderSocket.socket, sender.token);
    hub.handleMessage(oldSenderSocket.socket.id, {
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
    hub.connect(newSenderSocket.socket, sender.token);
    hub.disconnect(oldSenderSocket.socket.id);
    hub.handleMessage(receiverSocket.socket.id, {
      type: "signal:answer",
      roomCode: created.room.code,
      to: sender.id,
      peerSessionId: "peer_session_1",
      description: { type: "answer", sdp: "v=0" },
    });

    expect(oldSenderSocket.closeCount()).toBe(1);
    expect(signalMessages(newSenderSocket.sent)).toEqual([{
      type: "signal:answer",
      roomCode: "345678",
      from: receiver.id,
      peerSessionId: "peer_session_1",
      description: { type: "answer", sdp: "v=0" },
    }]);
  });

  test("broadcasts participant leave on current socket disconnect", () => {
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
    hub.disconnect(receiverSocket.socket.id);

    expect(latestMessage(senderSocket.sent)).toEqual({
      type: "participant:left",
      roomCode: "345678",
      visitorId: receiver.id,
    });
  });
});
