import { describe, expect, test } from "bun:test";
import type {
  ClientRealtimeMessage,
  RoomAccessServerMessage,
  ServerRealtimeMessage,
  SignalServerMessage,
} from "@p2p/contracts";
import { createMaintenanceService } from "../maintenance/service";
import { createRoomAccessService } from "../room-access/service";
import { createRoomService } from "../room/service";
import { createVisitorService } from "../visitor/service";
import {
  createRealtimeHub,
  type RealtimeHub,
  type RealtimeSocket,
} from "./hub";

const ALLOWED_ORIGIN = "http://localhost:5713";
const TEST_INVITE_TOKEN = `inv_${"A".repeat(43)}`;

const createSocket = (
  id: string,
  options: {
    origin?: string | null;
    throwOnSend?: boolean;
    onClose?: () => void;
  } = {},
) => {
  const sent: ServerRealtimeMessage[] = [];
  let closes = 0;
  const socket: RealtimeSocket = {
    id,
    origin: options.origin === undefined ? ALLOWED_ORIGIN : options.origin,
    send(message) {
      if (options.throwOnSend) throw new Error("send failed");
      sent.push(message);
    },
    close() {
      closes += 1;
      options.onClose?.();
    },
  };
  return {
    socket,
    sent,
    closeCount: () => closes,
  };
};

const latestErrorCode = (messages: readonly ServerRealtimeMessage[]) =>
  messages.filter((message): message is Extract<ServerRealtimeMessage, { type: "error" }> =>
    message.type === "error").slice(-1)[0]?.code;

const signalMessages = (messages: readonly ServerRealtimeMessage[]) =>
  messages.filter((message): message is SignalServerMessage =>
    message.type === "signal:offer"
    || message.type === "signal:answer"
    || message.type === "signal:ice");

const accessMessages = (messages: readonly ServerRealtimeMessage[]) =>
  messages.filter((message): message is RoomAccessServerMessage =>
    message.type === "room:join-requests"
    || message.type === "room:join-requested"
    || message.type === "room:join-request-resolved");

const leftMessages = (messages: readonly ServerRealtimeMessage[], visitorId?: string) =>
  messages.filter(message =>
    message.type === "participant:left"
    && (visitorId === undefined || message.visitorId === visitorId));

type HarnessOptions = {
  maxSockets?: number;
  maxVisitors?: number;
  idleTtlMs?: number;
  failAccessSnapshots?: boolean;
};

const createHarness = (options: HarnessOptions = {}) => {
  let timestamp = 0;
  let visitorIndex = 0;
  let roomIndex = 345_677;
  let requestIndex = 0;
  const now = () => timestamp;
  const visitors = createVisitorService({
    now,
    idleTtlMs: options.idleTtlMs,
    maxVisitors: options.maxVisitors,
    createId: () => `vis_${String(++visitorIndex).padStart(3, "0")}`,
    createToken: () => `tok_${String(visitorIndex).padStart(3, "0")}`,
    createAvatarSeed: () => `avatar_${String(visitorIndex)}`,
  });
  const rooms = createRoomService({
    visitors,
    now,
    attachTimeoutMs: 15_000,
    createCode: () => String(++roomIndex),
    inviteCrypto: {
      createToken: () => TEST_INVITE_TOKEN,
      digest: () => new Uint8Array([1]),
      equals: (left, right) => left.length === right.length
        && left.every((value, index) => value === right[index]),
    },
  });
  const roomAccess = createRoomAccessService({
    rooms,
    visitors,
    now,
    createRequestId: () => `request_${String(++requestIndex).padStart(3, "0")}`,
  });
  const maintenance = createMaintenanceService({
    rooms,
    roomAccess,
    visitors,
    rateLimits: { sweep: () => 0 },
  });
  const hub = createRealtimeHub({
    config: { corsAllowedOrigins: [ALLOWED_ORIGIN] },
    visitors,
    rooms,
    roomAccess: options.failAccessSnapshots
      ? {
          listPendingForSender: () => ({
            ok: false,
            error: {
              code: "ROOM_JOIN_REQUEST_NOT_FOUND" as const,
              message: "sensitive internal snapshot failure",
            },
          }),
          subscribe: roomAccess.subscribe,
        }
      : roomAccess,
    maintenance,
  }, { maxSockets: options.maxSockets });

  return {
    visitors,
    rooms,
    roomAccess,
    maintenance,
    hub,
    setNow(value: number) {
      timestamp = value;
    },
  };
};

type Harness = ReturnType<typeof createHarness>;

const bootstrapPair = (harness: Harness) => {
  const sender = harness.visitors.createVisitor();
  const receiver = harness.visitors.createVisitor();
  const created = harness.rooms.createRoom(sender.token);
  if (!created.ok) throw new Error("expected room creation");
  const joined = harness.rooms.joinRoom(created.room.code, receiver.token, "receiver");
  if (!joined.ok) throw new Error("expected room join");
  return { sender, receiver, roomCode: created.room.code };
};

const connect = (
  hub: RealtimeHub,
  socket: RealtimeSocket,
  token: string,
) => {
  const result = hub.connect(socket, token);
  if (!result.ok) throw new Error(`expected realtime connection: ${result.error.code}`);
  return result;
};

const attach = (
  hub: RealtimeHub,
  socketId: string,
  roomCode: string,
  role: "sender" | "receiver",
) => hub.handleMessage(socketId, { type: "room:attach", roomCode, role });

const participantStatus = (harness: Harness, roomCode: string, visitorId: string) => {
  const result = harness.rooms.getInternalRoomSnapshot(roomCode);
  if (!result.ok) return undefined;
  return result.room.participants.find(
    participant => participant.visitor.id === visitorId,
  )?.status;
};

const offer = (
  roomCode: string,
  to: string,
): ClientRealtimeMessage => ({
  type: "signal:offer",
  roomCode,
  to,
  peerSessionId: "peer_session_1",
  description: { type: "offer", sdp: "v=0\r\n" },
});

describe("realtime hub attach and resume", () => {
  test("room:attach is attach-only and never creates membership", () => {
    const harness = createHarness();
    const sender = harness.visitors.createVisitor();
    const outsider = harness.visitors.createVisitor();
    const created = harness.rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    const senderSocket = createSocket("socket_sender");
    const outsiderSocket = createSocket("socket_outsider");
    connect(harness.hub, senderSocket.socket, sender.token);
    connect(harness.hub, outsiderSocket.socket, outsider.token);

    attach(harness.hub, outsiderSocket.socket.id, created.room.code, "receiver");
    expect(latestErrorCode(outsiderSocket.sent)).toBe("ROOM_MEMBERSHIP_REQUIRED");
    const roomAfterAttach = harness.rooms.getInternalRoomSnapshot(created.room.code);
    expect(roomAfterAttach.ok && roomAfterAttach.room.participants
      .some(participant => participant.visitor.id === outsider.id)).toBe(false);

    attach(harness.hub, senderSocket.socket.id, created.room.code, "receiver");
    expect(latestErrorCode(senderSocket.sent)).toBe("INVALID_STATE");
    attach(harness.hub, senderSocket.socket.id, created.room.code, "sender");
    expect(participantStatus(harness, created.room.code, sender.id)).toBe("online");
    expect(senderSocket.sent).toContainEqual(expect.objectContaining({
      type: "room:participants",
      room: expect.objectContaining({ code: created.room.code }),
    }));
  });

  test("rejects attach at the exact deadline and publishes its removal transition", () => {
    const harness = createHarness();
    const { sender, receiver, roomCode } = bootstrapPair(harness);
    const senderSocket = createSocket("socket_sender");
    const receiverSocket = createSocket("socket_receiver");
    connect(harness.hub, senderSocket.socket, sender.token);
    attach(harness.hub, senderSocket.socket.id, roomCode, "sender");
    connect(harness.hub, receiverSocket.socket, receiver.token);

    harness.setNow(15_000);
    attach(harness.hub, receiverSocket.socket.id, roomCode, "receiver");

    expect(latestErrorCode(receiverSocket.sent)).toBe("ROOM_MEMBERSHIP_REQUIRED");
    expect(leftMessages(senderSocket.sent, receiver.id)).toHaveLength(1);
    expect(participantStatus(harness, roomCode, receiver.id)).toBeUndefined();
  });

  test("forwards signaling only when both members are online and both current sockets attached", () => {
    const harness = createHarness();
    const { sender, receiver, roomCode } = bootstrapPair(harness);
    const senderSocket = createSocket("socket_sender");
    const receiverSocket = createSocket("socket_receiver");
    connect(harness.hub, senderSocket.socket, sender.token);
    connect(harness.hub, receiverSocket.socket, receiver.token);
    attach(harness.hub, senderSocket.socket.id, roomCode, "sender");
    attach(harness.hub, receiverSocket.socket.id, roomCode, "receiver");

    harness.hub.handleMessage(senderSocket.socket.id, offer(roomCode, receiver.id));
    expect(signalMessages(receiverSocket.sent)).toEqual([{
      type: "signal:offer",
      roomCode,
      from: sender.id,
      peerSessionId: "peer_session_1",
      description: { type: "offer", sdp: "v=0\r\n" },
    }]);

    harness.hub.disconnect(receiverSocket.socket.id);
    harness.hub.handleMessage(senderSocket.socket.id, offer(roomCode, receiver.id));
    expect(latestErrorCode(senderSocket.sent)).toBe("SIGNAL_TARGET_NOT_IN_ROOM");

    const unattachedReceiver = createSocket("socket_receiver_new");
    connect(harness.hub, unattachedReceiver.socket, receiver.token);
    const serviceAttach = harness.rooms.attach(roomCode, receiver.id, "receiver");
    expect(serviceAttach.ok).toBe(true);
    harness.hub.handleMessage(senderSocket.socket.id, offer(roomCode, receiver.id));
    expect(signalMessages(unattachedReceiver.sent)).toHaveLength(0);
    expect(latestErrorCode(senderSocket.sent)).toBe("SIGNAL_TARGET_NOT_IN_ROOM");

    const replacementSender = createSocket("socket_sender_new");
    connect(harness.hub, replacementSender.socket, sender.token);
    harness.hub.handleMessage(replacementSender.socket.id, offer(roomCode, receiver.id));
    expect(latestErrorCode(replacementSender.sent)).toBe("SIGNAL_NOT_ALLOWED");
  });

  test("unexpected disconnect becomes connecting and can resume inside 15 seconds", () => {
    const harness = createHarness();
    const { sender, receiver, roomCode } = bootstrapPair(harness);
    const senderSocket = createSocket("socket_sender");
    const receiverSocket = createSocket("socket_receiver");
    connect(harness.hub, senderSocket.socket, sender.token);
    connect(harness.hub, receiverSocket.socket, receiver.token);
    attach(harness.hub, senderSocket.socket.id, roomCode, "sender");
    attach(harness.hub, receiverSocket.socket.id, roomCode, "receiver");
    const leftBefore = leftMessages(senderSocket.sent, receiver.id).length;

    harness.hub.disconnect(receiverSocket.socket.id);
    expect(participantStatus(harness, roomCode, receiver.id)).toBe("connecting");
    expect(leftMessages(senderSocket.sent, receiver.id)).toHaveLength(leftBefore);

    harness.setNow(14_999);
    const resumed = createSocket("socket_receiver_resumed");
    connect(harness.hub, resumed.socket, receiver.token);
    attach(harness.hub, resumed.socket.id, roomCode, "receiver");
    expect(participantStatus(harness, roomCode, receiver.id)).toBe("online");
  });

  test("maintenance removes a disconnected member once after the resume deadline", () => {
    const harness = createHarness();
    const { sender, receiver, roomCode } = bootstrapPair(harness);
    const senderSocket = createSocket("socket_sender");
    const receiverSocket = createSocket("socket_receiver");
    connect(harness.hub, senderSocket.socket, sender.token);
    connect(harness.hub, receiverSocket.socket, receiver.token);
    attach(harness.hub, senderSocket.socket.id, roomCode, "sender");
    attach(harness.hub, receiverSocket.socket.id, roomCode, "receiver");
    harness.hub.disconnect(receiverSocket.socket.id);

    harness.setNow(15_000);
    const janitor = harness.visitors.createVisitor();
    connect(harness.hub, createSocket("socket_janitor").socket, janitor.token);
    expect(leftMessages(senderSocket.sent, receiver.id)).toHaveLength(1);
    const secondJanitor = harness.visitors.createVisitor();
    connect(harness.hub, createSocket("socket_janitor_2").socket, secondJanitor.token);
    expect(leftMessages(senderSocket.sent, receiver.id)).toHaveLength(1);
  });

  test("explicit receiver leave is immediate and disconnect does not duplicate it", () => {
    const harness = createHarness();
    const { sender, receiver, roomCode } = bootstrapPair(harness);
    const senderSocket = createSocket("socket_sender");
    const receiverSocket = createSocket("socket_receiver");
    connect(harness.hub, senderSocket.socket, sender.token);
    connect(harness.hub, receiverSocket.socket, receiver.token);
    attach(harness.hub, senderSocket.socket.id, roomCode, "sender");
    attach(harness.hub, receiverSocket.socket.id, roomCode, "receiver");

    harness.hub.handleMessage(receiverSocket.socket.id, { type: "room:leave", roomCode });
    harness.hub.disconnect(receiverSocket.socket.id);
    expect(leftMessages(senderSocket.sent, receiver.id)).toHaveLength(1);
    expect(participantStatus(harness, roomCode, receiver.id)).toBeUndefined();
  });

  test("replacement marks old rooms connecting, starts empty, and stale close cannot downgrade it", () => {
    const harness = createHarness();
    const { sender, receiver, roomCode } = bootstrapPair(harness);
    const receiverSocket = createSocket("socket_receiver");
    connect(harness.hub, receiverSocket.socket, receiver.token);
    attach(harness.hub, receiverSocket.socket.id, roomCode, "receiver");

    let hub!: RealtimeHub;
    const oldSender = createSocket("socket_sender_old", {
      onClose: () => hub.disconnect("socket_sender_old"),
    });
    hub = harness.hub;
    connect(hub, oldSender.socket, sender.token);
    attach(hub, oldSender.socket.id, roomCode, "sender");
    const newSender = createSocket("socket_sender_new");

    connect(hub, newSender.socket, sender.token);
    expect(oldSender.closeCount()).toBe(1);
    expect(participantStatus(harness, roomCode, sender.id)).toBe("connecting");
    hub.disconnect(oldSender.socket.id);
    expect(participantStatus(harness, roomCode, sender.id)).toBe("connecting");

    hub.handleMessage(receiverSocket.socket.id, {
      type: "signal:answer",
      roomCode,
      to: sender.id,
      peerSessionId: "peer_session_1",
      description: { type: "answer", sdp: "v=0" },
    });
    expect(signalMessages(newSender.sent)).toHaveLength(0);
    expect(latestErrorCode(receiverSocket.sent)).toBe("SIGNAL_TARGET_NOT_IN_ROOM");

    attach(hub, newSender.socket.id, roomCode, "sender");
    hub.handleMessage(receiverSocket.socket.id, {
      type: "signal:answer",
      roomCode,
      to: sender.id,
      peerSessionId: "peer_session_2",
      description: { type: "answer", sdp: "v=0" },
    });
    expect(signalMessages(newSender.sent)).toContainEqual(expect.objectContaining({
      type: "signal:answer",
      peerSessionId: "peer_session_2",
    }));
  });

  test("full capacity permits a net-zero replacement but rejects a distinct socket", () => {
    const harness = createHarness({ maxSockets: 2 });
    const first = harness.visitors.createVisitor();
    const second = harness.visitors.createVisitor();
    const third = harness.visitors.createVisitor();
    const firstSocket = createSocket("socket_first");
    const secondSocket = createSocket("socket_second");
    connect(harness.hub, firstSocket.socket, first.token);
    connect(harness.hub, secondSocket.socket, second.token);

    const rejected = createSocket("socket_third");
    expect(harness.hub.connect(rejected.socket, third.token)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "CAPACITY_EXCEEDED" }),
    });
    expect(rejected.closeCount()).toBe(1);

    const replacement = createSocket("socket_first_new");
    expect(harness.hub.connect(replacement.socket, first.token).ok).toBe(true);
    expect(firstSocket.closeCount()).toBe(1);
  });

  test("admission sweep closes an expired socket before applying the socket cap", () => {
    const harness = createHarness({ maxSockets: 1, idleTtlMs: 100 });
    const stale = harness.visitors.createVisitor();
    const staleSocket = createSocket("socket_stale");
    connect(harness.hub, staleSocket.socket, stale.token);
    harness.setNow(100);
    const fresh = harness.visitors.createVisitor();
    const freshSocket = createSocket("socket_fresh");

    expect(harness.hub.connect(freshSocket.socket, fresh.token).ok).toBe(true);
    expect(staleSocket.closeCount()).toBe(1);
    expect(freshSocket.closeCount()).toBe(0);
  });

  test("origin policy fails closed without touching or replacing an existing generation", () => {
    const harness = createHarness({ maxSockets: 1 });
    const visitor = harness.visitors.createVisitor();
    const current = createSocket("socket_current");
    connect(harness.hub, current.socket, visitor.token);
    harness.setNow(50);

    for (const [id, origin] of [
      ["missing", null],
      ["malformed", "not-an-origin"],
      ["foreign", "https://evil.example"],
    ] as const) {
      const rejected = createSocket(`socket_${id}`, { origin });
      const result = harness.hub.connect(rejected.socket, visitor.token);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe("ORIGIN_NOT_ALLOWED");
      expect(rejected.closeCount()).toBe(1);
      expect(current.closeCount()).toBe(0);
    }
    expect(harness.visitors.getById(visitor.id)?.lastSeenAt).toBe(0);
  });

  test("connect and accepted attach, signal, and leave touch the visitor; rejected signal does not", () => {
    const harness = createHarness();
    const { sender, receiver, roomCode } = bootstrapPair(harness);
    const senderSocket = createSocket("socket_sender");
    const receiverSocket = createSocket("socket_receiver");
    harness.setNow(10);
    connect(harness.hub, senderSocket.socket, sender.token);
    connect(harness.hub, receiverSocket.socket, receiver.token);
    expect(harness.visitors.getById(sender.id)?.lastSeenAt).toBe(10);

    harness.setNow(20);
    attach(harness.hub, senderSocket.socket.id, roomCode, "sender");
    expect(harness.visitors.getById(sender.id)?.lastSeenAt).toBe(20);
    harness.setNow(30);
    harness.hub.handleMessage(senderSocket.socket.id, offer(roomCode, receiver.id));
    expect(harness.visitors.getById(sender.id)?.lastSeenAt).toBe(20);

    attach(harness.hub, receiverSocket.socket.id, roomCode, "receiver");
    harness.setNow(40);
    harness.hub.handleMessage(senderSocket.socket.id, offer(roomCode, receiver.id));
    expect(harness.visitors.getById(sender.id)?.lastSeenAt).toBe(40);
    harness.setNow(50);
    harness.hub.handleMessage(senderSocket.socket.id, { type: "room:leave", roomCode });
    expect(harness.visitors.getById(sender.id)?.lastSeenAt).toBe(50);
  });

  test("one throwing room recipient does not prevent transition delivery to other peers", () => {
    const harness = createHarness();
    const sender = harness.visitors.createVisitor();
    const receiverA = harness.visitors.createVisitor();
    const receiverB = harness.visitors.createVisitor();
    const created = harness.rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    for (const receiver of [receiverA, receiverB]) {
      const joined = harness.rooms.joinRoom(created.room.code, receiver.token, "receiver");
      if (!joined.ok) throw new Error("expected join");
    }
    const senderSocket = createSocket("socket_sender");
    const broken = createSocket("socket_broken", { throwOnSend: true });
    const healthy = createSocket("socket_healthy");
    connect(harness.hub, senderSocket.socket, sender.token);
    connect(harness.hub, broken.socket, receiverA.token);
    connect(harness.hub, healthy.socket, receiverB.token);
    attach(harness.hub, senderSocket.socket.id, created.room.code, "sender");
    attach(harness.hub, broken.socket.id, created.room.code, "receiver");
    attach(harness.hub, healthy.socket.id, created.room.code, "receiver");

    harness.hub.handleMessage(senderSocket.socket.id, {
      type: "room:leave",
      roomCode: created.room.code,
    });
    expect(leftMessages(healthy.sent, sender.id)).toHaveLength(1);
  });
});

describe("realtime hub room access notifications", () => {
  test("sender attach always receives one canonical snapshot while receivers receive none", () => {
    const harness = createHarness();
    const sender = harness.visitors.createVisitor();
    const receiver = harness.visitors.createVisitor();
    const waitingA = harness.visitors.createVisitor();
    const waitingB = harness.visitors.createVisitor();
    const created = harness.rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    const joined = harness.rooms.joinRoom(created.room.code, receiver.token, "receiver");
    if (!joined.ok) throw new Error("expected receiver membership");
    const firstSenderSocket = createSocket("socket_sender_first");
    const receiverSocket = createSocket("socket_receiver");
    connect(harness.hub, firstSenderSocket.socket, sender.token);
    connect(harness.hub, receiverSocket.socket, receiver.token);
    attach(harness.hub, firstSenderSocket.socket.id, created.room.code, "sender");
    attach(harness.hub, receiverSocket.socket.id, created.room.code, "receiver");

    expect(accessMessages(firstSenderSocket.sent)).toEqual([{
      type: "room:join-requests",
      roomCode: created.room.code,
      requests: [],
    }]);
    expect(accessMessages(receiverSocket.sent)).toEqual([]);

    harness.setNow(200);
    const pendingA = harness.roomAccess.createOrGetPending(
      created.room.code,
      waitingA.token,
    );
    harness.setNow(100);
    const pendingB = harness.roomAccess.createOrGetPending(
      created.room.code,
      waitingB.token,
    );
    if (!pendingA.ok || !pendingB.ok) throw new Error("expected pending requests");

    const replacement = createSocket("socket_sender_replacement");
    connect(harness.hub, replacement.socket, sender.token);
    attach(harness.hub, replacement.socket.id, created.room.code, "sender");

    expect(accessMessages(replacement.sent)).toEqual([{
      type: "room:join-requests",
      roomCode: created.room.code,
      requests: [
        expect.objectContaining({ requestId: pendingB.receipt.requestId }),
        expect.objectContaining({ requestId: pendingA.receipt.requestId }),
      ],
    }]);
    const serialized = JSON.stringify(accessMessages(replacement.sent));
    expect(serialized).not.toContain(waitingA.token);
    expect(serialized).not.toContain(waitingB.token);
    expect(serialized).not.toContain(TEST_INVITE_TOKEN);
  });

  test("incremental events target only the current sender attached to that room", () => {
    const harness = createHarness();
    const senderA = harness.visitors.createVisitor();
    const senderB = harness.visitors.createVisitor();
    const receiverA = harness.visitors.createVisitor();
    const waitingA = harness.visitors.createVisitor();
    const waitingB = harness.visitors.createVisitor();
    const roomA = harness.rooms.createRoom(senderA.token);
    const roomB = harness.rooms.createRoom(senderB.token);
    if (!roomA.ok || !roomB.ok) throw new Error("expected rooms");
    const receiverJoin = harness.rooms.joinRoom(roomA.room.code, receiverA.token, "receiver");
    if (!receiverJoin.ok) throw new Error("expected receiver membership");

    const oldSenderSocket = createSocket("socket_sender_a_old");
    const senderBSocket = createSocket("socket_sender_b");
    const receiverSocket = createSocket("socket_receiver_a");
    const unattachedSocket = createSocket("socket_unattached");
    connect(harness.hub, oldSenderSocket.socket, senderA.token);
    connect(harness.hub, senderBSocket.socket, senderB.token);
    connect(harness.hub, receiverSocket.socket, receiverA.token);
    connect(harness.hub, unattachedSocket.socket, waitingB.token);
    attach(harness.hub, oldSenderSocket.socket.id, roomA.room.code, "sender");
    attach(harness.hub, senderBSocket.socket.id, roomB.room.code, "sender");
    attach(harness.hub, receiverSocket.socket.id, roomA.room.code, "receiver");
    const baseline = {
      oldSender: accessMessages(oldSenderSocket.sent).length,
      senderB: accessMessages(senderBSocket.sent).length,
      receiver: accessMessages(receiverSocket.sent).length,
      unattached: accessMessages(unattachedSocket.sent).length,
    };

    const pendingA = harness.roomAccess.createOrGetPending(roomA.room.code, waitingA.token);
    if (!pendingA.ok) throw new Error("expected pending request");
    expect(accessMessages(oldSenderSocket.sent).slice(baseline.oldSender)).toEqual([{
      type: "room:join-requested",
      request: expect.objectContaining({ requestId: pendingA.receipt.requestId }),
    }]);
    expect(accessMessages(senderBSocket.sent)).toHaveLength(baseline.senderB);
    expect(accessMessages(receiverSocket.sent)).toHaveLength(baseline.receiver);
    expect(accessMessages(unattachedSocket.sent)).toHaveLength(baseline.unattached);

    const replacement = createSocket("socket_sender_a_new");
    connect(harness.hub, replacement.socket, senderA.token);
    const cancelled = harness.roomAccess.cancel(
      roomA.room.code,
      pendingA.receipt.requestId,
      waitingA.token,
    );
    if (!cancelled.ok) throw new Error("expected cancellation");
    expect(accessMessages(oldSenderSocket.sent)).toHaveLength(baseline.oldSender + 1);
    expect(accessMessages(replacement.sent)).toEqual([]);

    attach(harness.hub, replacement.socket.id, roomA.room.code, "sender");
    expect(accessMessages(replacement.sent)).toEqual([{
      type: "room:join-requests",
      roomCode: roomA.room.code,
      requests: [],
    }]);
    const pendingB = harness.roomAccess.createOrGetPending(roomA.room.code, waitingB.token);
    if (!pendingB.ok) throw new Error("expected second pending request");
    expect(accessMessages(replacement.sent).slice(-1)).toEqual([{
      type: "room:join-requested",
      request: expect.objectContaining({ requestId: pendingB.receipt.requestId }),
    }]);

    harness.hub.disconnect(replacement.socket.id);
    const resolvedAfterDisconnect = harness.roomAccess.cancel(
      roomA.room.code,
      pendingB.receipt.requestId,
      waitingB.token,
    );
    if (!resolvedAfterDisconnect.ok) throw new Error("expected cancellation");
    expect(accessMessages(replacement.sent).slice(-1)[0]?.type).toBe("room:join-requested");
  });

  test("all access resolution states are delivered without bearer secrets", () => {
    const harness = createHarness();
    const sender = harness.visitors.createVisitor();
    const created = harness.rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    const senderSocket = createSocket("socket_sender");
    connect(harness.hub, senderSocket.socket, sender.token);
    attach(harness.hub, senderSocket.socket.id, created.room.code, "sender");

    const createRequest = () => {
      const visitor = harness.visitors.createVisitor();
      const request = harness.roomAccess.createOrGetPending(created.room.code, visitor.token);
      if (!request.ok) throw new Error("expected pending request");
      return { visitor, receipt: request.receipt };
    };

    const approved = createRequest();
    harness.roomAccess.decide(
      created.room.code,
      approved.receipt.requestId,
      sender.token,
      "approve",
    );
    const rejected = createRequest();
    harness.roomAccess.decide(
      created.room.code,
      rejected.receipt.requestId,
      sender.token,
      "reject",
    );
    const cancelled = createRequest();
    harness.roomAccess.cancel(
      created.room.code,
      cancelled.receipt.requestId,
      cancelled.visitor.token,
    );
    const expired = createRequest();
    harness.setNow(expired.receipt.expiresAt);
    harness.roomAccess.cleanupExpiredState();

    harness.setNow(expired.receipt.expiresAt + 1);
    const finalized = createRequest();
    const approvedForFinalize = harness.roomAccess.decide(
      created.room.code,
      finalized.receipt.requestId,
      sender.token,
      "approve",
    );
    if (!approvedForFinalize.ok) throw new Error("expected approval");
    const accessPlan = harness.roomAccess.prepareFinalize(
      created.room.code,
      finalized.receipt.requestId,
      finalized.visitor.token,
    );
    if (!accessPlan.ok || accessPlan.mode !== "commit") {
      throw new Error("expected finalize plan");
    }
    const roomPlan = harness.rooms.prepareApprovedReceiverJoin(
      created.room.code,
      finalized.visitor.token,
    );
    if (!roomPlan.ok) throw new Error("expected room plan");
    const commit = harness.roomAccess.commitFinalize(
      accessPlan.plan,
      () => harness.rooms.commit(roomPlan.plan),
    );
    if (!commit.ok) throw new Error("expected finalize commit");

    const resolved = accessMessages(senderSocket.sent).filter(
      (message): message is Extract<RoomAccessServerMessage, {
        type: "room:join-request-resolved";
      }> => message.type === "room:join-request-resolved",
    );
    expect(resolved.map(message => message.state)).toEqual([
      "approved",
      "rejected",
      "cancelled",
      "expired",
      "expired",
      "approved",
      "finalized",
    ]);
    const serialized = JSON.stringify(accessMessages(senderSocket.sent));
    for (const token of [
      approved.visitor.token,
      rejected.visitor.token,
      cancelled.visitor.token,
      expired.visitor.token,
      finalized.visitor.token,
    ]) {
      expect(serialized).not.toContain(token);
    }
    expect(serialized).not.toContain(TEST_INVITE_TOKEN);
  });

  test("snapshot failure stays generic and does not detach valid sender membership", () => {
    const harness = createHarness({ failAccessSnapshots: true });
    const sender = harness.visitors.createVisitor();
    const created = harness.rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    const senderSocket = createSocket("socket_sender");
    connect(harness.hub, senderSocket.socket, sender.token);

    attach(harness.hub, senderSocket.socket.id, created.room.code, "sender");

    expect(participantStatus(harness, created.room.code, sender.id)).toBe("online");
    expect(accessMessages(senderSocket.sent)).toEqual([]);
    expect(latestErrorCode(senderSocket.sent)).toBe("ROOM_ACCESS_UNAVAILABLE");
    expect(JSON.stringify(senderSocket.sent)).not.toContain(
      "sensitive internal snapshot failure",
    );
  });

  test("a throwing sender socket cannot escape the access subscriber", () => {
    const harness = createHarness();
    const sender = harness.visitors.createVisitor();
    const waiting = harness.visitors.createVisitor();
    const created = harness.rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    const broken = createSocket("socket_broken_sender", { throwOnSend: true });
    connect(harness.hub, broken.socket, sender.token);
    attach(harness.hub, broken.socket.id, created.room.code, "sender");

    expect(() => harness.roomAccess.createOrGetPending(
      created.room.code,
      waiting.token,
    )).not.toThrow();
  });
});
