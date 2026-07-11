import { describe, expect, test } from "bun:test";
import { createVisitorService } from "../visitor/service";
import { createRoomService, type RoomServiceOptions } from "./service";

type ServiceOverrides = Partial<Pick<
  RoomServiceOptions,
  "attachTimeoutMs" | "maxReceivers" | "maxRooms" | "ttlMs"
>>;

const createServices = (overrides: ServiceOverrides = {}) => {
  let time = 10_000;
  let visitorIndex = 0;
  let roomIndex = 0;
  let planIndex = 0;
  const visitors = createVisitorService({
    now: () => time,
    maxVisitors: 10_000,
    createId: () => `vis_${String(++visitorIndex).padStart(4, "0")}`,
    createToken: () => `tok_${String(visitorIndex).padStart(4, "0")}`,
    createAvatarSeed: () => `avatar_${String(visitorIndex).padStart(4, "0")}`,
  });
  const rooms = createRoomService({
    visitors,
    now: () => time,
    ttlMs: overrides.ttlMs ?? 60_000,
    attachTimeoutMs: overrides.attachTimeoutMs,
    maxReceivers: overrides.maxReceivers,
    maxRooms: overrides.maxRooms,
    createCode: () => String(100_000 + ++roomIndex),
    createPlanId: () => `plan_${String(++planIndex)}`,
  });

  return {
    visitors,
    rooms,
    now: () => time,
    setTime: (value: number) => {
      time = value;
    },
  };
};

const createRoom = (
  services: ReturnType<typeof createServices>,
  senderToken: string,
) => {
  const result = services.rooms.createRoom(senderToken);
  if (!result.ok) throw new Error(`expected room: ${result.error.code}`);
  return result.room;
};

describe("room service prepared mutations", () => {
  test("prepares without mutating live rooms and commits a create plan once", () => {
    const { visitors, rooms } = createServices();
    const sender = visitors.createVisitor();

    const prepared = rooms.prepareCreate(sender.token);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.plan).toMatchObject({
      revision: 0,
      kind: "create",
      visitorId: sender.id,
      role: "sender",
    });
    expect(prepared.plan.room.participants).toEqual([{
      visitor: visitors.toPublic(sender),
      role: "sender",
      joinedAt: 10_000,
      status: "connecting",
    }]);
    expect(rooms.getRoom(prepared.plan.room.code)).toMatchObject({
      ok: false,
      error: { code: "ROOM_NOT_FOUND" },
    });

    const committed = rooms.commit(prepared.plan);
    expect(committed).toEqual({ ok: true, room: prepared.plan.room });
    expect(rooms.commit(prepared.plan)).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE" },
    });
  });

  test("keeps join plans immutable to the live map and rejects a stale revision", () => {
    const services = createServices();
    const sender = services.visitors.createVisitor();
    const receiverOne = services.visitors.createVisitor();
    const receiverTwo = services.visitors.createVisitor();
    const room = createRoom(services, sender.token);

    const first = services.rooms.prepareJoin(room.code, receiverOne.token, "receiver");
    const stale = services.rooms.prepareJoin(room.code, receiverTwo.token, "receiver");
    if (!first.ok || !stale.ok) throw new Error("expected join plans");
    expect(services.rooms.getRoom(room.code)).toMatchObject({
      ok: true,
      room: { receivers: [] },
    });
    expect(first.plan.room.receivers).toEqual([receiverOne.id]);
    expect(stale.plan.room.receivers).toEqual([receiverTwo.id]);

    expect(services.rooms.commit(first.plan)).toMatchObject({
      ok: true,
      room: { receivers: [receiverOne.id] },
    });
    expect(services.rooms.commit(stale.plan)).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE" },
    });
    expect(services.rooms.getRoom(room.code)).toMatchObject({
      ok: true,
      room: { receivers: [receiverOne.id] },
    });
  });

  test("rejects forged plans and rechecks sender and receiver policy", () => {
    const services = createServices();
    const sender = services.visitors.createVisitor();
    const receiver = services.visitors.createVisitor();
    const secondSender = services.visitors.createVisitor();
    const room = createRoom(services, sender.token);
    const prepared = services.rooms.prepareJoin(room.code, receiver.token, "receiver");
    if (!prepared.ok) throw new Error("expected join plan");

    expect(services.rooms.commit({
      ...prepared.plan,
      id: "forged",
      role: "sender",
    })).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE" },
    });
    expect(services.rooms.prepareJoin(room.code, secondSender.token, "sender")).toEqual({
      ok: false,
      error: {
        code: "ROOM_SENDER_EXISTS",
        message: "房间已经有发送者",
      },
    });
  });

  test("allows exactly twenty receivers and rejects the twenty-first without mutation", () => {
    const services = createServices();
    const sender = services.visitors.createVisitor();
    const room = createRoom(services, sender.token);

    for (let index = 0; index < 20; index += 1) {
      const receiver = services.visitors.createVisitor();
      const joined = services.rooms.joinRoom(room.code, receiver.token, "receiver");
      expect(joined.ok).toBe(true);
    }
    const overflow = services.visitors.createVisitor();
    expect(services.rooms.prepareJoin(room.code, overflow.token, "receiver")).toEqual({
      ok: false,
      error: {
        code: "CAPACITY_EXCEEDED",
        message: "房间接收者数量已达上限",
      },
    });
    const current = services.rooms.getRoom(room.code);
    expect(current.ok && current.room.receivers).toHaveLength(20);
  });

  test("allows exactly two thousand live rooms and rejects the next prepare", () => {
    const services = createServices();
    for (let index = 0; index < 2_000; index += 1) {
      const sender = services.visitors.createVisitor();
      expect(services.rooms.createRoom(sender.token).ok).toBe(true);
    }
    const overflow = services.visitors.createVisitor();

    expect(services.rooms.prepareCreate(overflow.token)).toEqual({
      ok: false,
      error: {
        code: "CAPACITY_EXCEEDED",
        message: "房间容量已满",
      },
    });
  });
});

describe("room membership attach and resume", () => {
  test("attaches a same-role member, rejects a wrong role, and is idempotent online", () => {
    const services = createServices();
    const sender = services.visitors.createVisitor();
    const stranger = services.visitors.createVisitor();
    const room = createRoom(services, sender.token);

    expect(services.rooms.attach(room.code, sender.id, "receiver")).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE" },
      transitions: [],
    });
    expect(services.rooms.attach(room.code, stranger.id, "receiver")).toMatchObject({
      ok: false,
      error: { code: "ROOM_MEMBERSHIP_REQUIRED" },
      transitions: [],
    });

    const attached = services.rooms.attach(room.code, sender.id, "sender");
    expect(attached).toMatchObject({
      ok: true,
      room: {
        participants: [{ role: "sender", status: "online" }],
      },
      transitions: [{
        type: "room:participants",
        room: {
          code: room.code,
          participants: [{ status: "online" }],
        },
      }],
    });
    expect(services.rooms.attach(room.code, sender.id, "sender")).toMatchObject({
      ok: true,
      transitions: [],
    });
  });

  test("uses an exact fifteen-second initial attach deadline", () => {
    const beforeDeadline = createServices();
    const beforeSender = beforeDeadline.visitors.createVisitor();
    const beforeRoom = createRoom(beforeDeadline, beforeSender.token);
    beforeDeadline.setTime(24_999);
    expect(beforeDeadline.rooms.attach(beforeRoom.code, beforeSender.id, "sender").ok).toBe(true);

    const atDeadline = createServices();
    const expiredSender = atDeadline.visitors.createVisitor();
    const expiredRoom = createRoom(atDeadline, expiredSender.token);
    atDeadline.setTime(25_000);
    const expired = atDeadline.rooms.attach(expiredRoom.code, expiredSender.id, "sender");
    expect(expired).toMatchObject({
      ok: false,
      error: { code: "ROOM_MEMBERSHIP_REQUIRED" },
      transitions: [{
        type: "participant:left",
        roomCode: expiredRoom.code,
        visitorId: expiredSender.id,
      }],
    });
    expect(atDeadline.rooms.getRoom(expiredRoom.code)).toMatchObject({
      ok: false,
      error: { code: "ROOM_NOT_FOUND" },
    });
  });

  test("marks attached members connecting and resumes only inside a fresh window", () => {
    const services = createServices();
    const sender = services.visitors.createVisitor();
    const room = createRoom(services, sender.token);
    expect(services.rooms.attach(room.code, sender.id, "sender").ok).toBe(true);

    services.setTime(20_000);
    expect(services.rooms.markConnecting(sender.id, [room.code, room.code, "missing"])).toMatchObject([{
      type: "room:participants",
      room: {
        code: room.code,
        participants: [{ status: "connecting" }],
      },
    }]);
    expect(services.rooms.markConnecting(sender.id, [room.code])).toEqual([]);
    services.setTime(34_999);
    expect(services.rooms.attach(room.code, sender.id, "sender").ok).toBe(true);

    services.setTime(40_000);
    services.rooms.markConnecting(sender.id, [room.code]);
    services.setTime(55_000);
    expect(services.rooms.cleanupExpiredState()).toEqual([{
      type: "participant:left",
      roomCode: room.code,
      visitorId: sender.id,
    }]);
    expect(services.rooms.cleanupExpiredState()).toEqual([]);
  });
});

describe("room removal and cleanup transitions", () => {
  test("explicit receiver leave emits once and preserves the sender room", () => {
    const services = createServices();
    const sender = services.visitors.createVisitor();
    const receiver = services.visitors.createVisitor();
    const room = createRoom(services, sender.token);
    const joined = services.rooms.joinRoom(room.code, receiver.token);
    if (!joined.ok) throw new Error("expected receiver");

    expect(services.rooms.leave(room.code, receiver.id)).toMatchObject({
      ok: true,
      room: { senderId: sender.id, receivers: [] },
      transitions: [{
        type: "participant:left",
        roomCode: room.code,
        visitorId: receiver.id,
      }],
    });
    expect(services.rooms.leave(room.code, receiver.id)).toMatchObject({
      ok: false,
      error: { code: "ROOM_MEMBERSHIP_REQUIRED" },
      transitions: [],
    });
    expect(services.rooms.getRoom(room.code).ok).toBe(true);
  });

  test("any explicit sender leave closes the room for every member", () => {
    const services = createServices();
    const sender = services.visitors.createVisitor();
    const receiver = services.visitors.createVisitor();
    const room = createRoom(services, sender.token);
    services.rooms.joinRoom(room.code, receiver.token);

    expect(services.rooms.leave(room.code, sender.id)).toMatchObject({
      ok: true,
      transitions: [
        { type: "participant:left", roomCode: room.code, visitorId: sender.id },
        { type: "participant:left", roomCode: room.code, visitorId: receiver.id },
      ],
    });
    expect(services.rooms.getRoom(room.code)).toMatchObject({
      ok: false,
      error: { code: "ROOM_NOT_FOUND" },
    });
  });

  test("receiver attach timeout preserves a room but sender timeout closes it", () => {
    const receiverTimeout = createServices();
    const sender = receiverTimeout.visitors.createVisitor();
    const receiver = receiverTimeout.visitors.createVisitor();
    const room = createRoom(receiverTimeout, sender.token);
    receiverTimeout.rooms.attach(room.code, sender.id, "sender");
    receiverTimeout.rooms.joinRoom(room.code, receiver.token);
    receiverTimeout.setTime(25_000);

    expect(receiverTimeout.rooms.cleanupExpiredState()).toEqual([{
      type: "participant:left",
      roomCode: room.code,
      visitorId: receiver.id,
    }]);
    expect(receiverTimeout.rooms.getRoom(room.code)).toMatchObject({
      ok: true,
      room: { senderId: sender.id, receivers: [] },
    });

    const senderTimeout = createServices();
    const expiringSender = senderTimeout.visitors.createVisitor();
    const expiringReceiver = senderTimeout.visitors.createVisitor();
    const expiringRoom = createRoom(senderTimeout, expiringSender.token);
    senderTimeout.rooms.joinRoom(expiringRoom.code, expiringReceiver.token);
    senderTimeout.setTime(25_000);
    expect(senderTimeout.rooms.cleanupExpiredState()).toEqual([
      {
        type: "participant:left",
        roomCode: expiringRoom.code,
        visitorId: expiringSender.id,
      },
      {
        type: "participant:left",
        roomCode: expiringRoom.code,
        visitorId: expiringReceiver.id,
      },
    ]);
  });

  test("visitor removal cascades deterministically and receiver removal keeps other rooms", () => {
    const services = createServices();
    const senderOne = services.visitors.createVisitor();
    const senderTwo = services.visitors.createVisitor();
    const receiver = services.visitors.createVisitor();
    const roomOne = createRoom(services, senderOne.token);
    const roomTwo = createRoom(services, senderTwo.token);
    services.rooms.joinRoom(roomOne.code, receiver.token);
    services.rooms.joinRoom(roomTwo.code, receiver.token);

    expect(services.rooms.removeVisitor(receiver.id)).toEqual([
      { type: "participant:left", roomCode: roomOne.code, visitorId: receiver.id },
      { type: "participant:left", roomCode: roomTwo.code, visitorId: receiver.id },
    ]);
    expect(services.rooms.getRoom(roomOne.code).ok).toBe(true);
    expect(services.rooms.getRoom(roomTwo.code).ok).toBe(true);

    expect(services.rooms.removeVisitor(senderOne.id)).toEqual([{
      type: "participant:left",
      roomCode: roomOne.code,
      visitorId: senderOne.id,
    }]);
    expect(services.rooms.getRoom(roomOne.code).ok).toBe(false);
  });

  test("room expiry closes every member in stable order exactly once", () => {
    const services = createServices({ ttlMs: 1_000 });
    const sender = services.visitors.createVisitor();
    const receiver = services.visitors.createVisitor();
    const room = createRoom(services, sender.token);
    services.rooms.joinRoom(room.code, receiver.token);
    services.setTime(11_000);

    expect(services.rooms.cleanupExpiredState()).toEqual([
      { type: "participant:left", roomCode: room.code, visitorId: sender.id },
      { type: "participant:left", roomCode: room.code, visitorId: receiver.id },
    ]);
    expect(services.rooms.cleanupExpiredState()).toEqual([]);
    expect(services.rooms.getRoom(room.code)).toMatchObject({
      ok: false,
      error: { code: "ROOM_NOT_FOUND" },
    });
  });

  test("keeps legacy wrappers delegating through the prepared lifecycle", () => {
    const services = createServices({ ttlMs: 1_000 });
    const sender = services.visitors.createVisitor();
    const receiver = services.visitors.createVisitor();
    const created = services.rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");
    const joined = services.rooms.joinRoom(created.room.code, receiver.token);
    if (!joined.ok) throw new Error("expected join");
    expect(joined.room.participants.map(participant => participant.status)).toEqual([
      "connecting",
      "connecting",
    ]);

    expect(services.rooms.leaveRoom(created.room.code, receiver.id).ok).toBe(true);
    services.setTime(11_000);
    services.rooms.cleanupExpiredRooms();
    expect(services.rooms.getRoom(created.room.code).ok).toBe(false);
  });
});
