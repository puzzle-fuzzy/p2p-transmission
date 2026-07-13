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
  let inviteIndex = 0;
  const createdInviteTokens: string[] = [];
  const digestedInviteTokens: string[] = [];
  const comparedInviteDigests: Array<{
    left: Uint8Array;
    right: Uint8Array;
  }> = [];
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
    inviteCrypto: {
      createToken: () => {
        const token = `inv_${String(++inviteIndex).padStart(43, "A")}`;
        createdInviteTokens.push(token);
        return token;
      },
      digest: token => {
        digestedInviteTokens.push(token);
        return new TextEncoder().encode(`digest:${token}`);
      },
      equals: (left, right) => {
        comparedInviteDigests.push({
          left: new Uint8Array(left),
          right: new Uint8Array(right),
        });
        return left.byteLength === right.byteLength
          && left.every((value, index) => value === right[index]);
      },
    },
  });

  return {
    visitors,
    rooms,
    now: () => time,
    setTime: (value: number) => {
      time = value;
    },
    inviteCryptoCalls: {
      createdInviteTokens,
      digestedInviteTokens,
      comparedInviteDigests,
    },
  };
};

const createAuthorizedRoom = (
  services: ReturnType<typeof createServices>,
  senderToken: string,
) => {
  const prepared = services.rooms.prepareCreate(senderToken);
  if (!prepared.ok) throw new Error(`expected room plan: ${prepared.error.code}`);
  const committed = services.rooms.commit(prepared.plan);
  if (!committed.ok) throw new Error(`expected room: ${committed.error.code}`);
  return { room: committed.room, invite: prepared.invite };
};

const createRoom = (
  services: ReturnType<typeof createServices>,
  senderToken: string,
) => createAuthorizedRoom(services, senderToken).room;

const joinApprovedReceiver = (
  services: ReturnType<typeof createServices>,
  code: string,
  visitorToken: string,
) => {
  const prepared = services.rooms.prepareApprovedReceiverJoin(code, visitorToken);
  return prepared.ok ? services.rooms.commit(prepared.plan) : prepared;
};

describe("room service authorized prepared mutations", () => {
  test("creates one invitation capability while keeping secrets out of public state", () => {
    const services = createServices();
    const { visitors, rooms } = services;
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
    expect(prepared.invite).toEqual({
      token: services.inviteCryptoCalls.createdInviteTokens[0],
      expiresAt: prepared.plan.room.expiresAt,
    });
    expect(services.inviteCryptoCalls.createdInviteTokens).toEqual([
      prepared.invite.token,
    ]);
    expect(services.inviteCryptoCalls.digestedInviteTokens).toEqual([
      prepared.invite.token,
    ]);
    expect(prepared.plan.room.participants).toEqual([{
      visitor: visitors.toPublic(sender),
      role: "sender",
      joinedAt: 10_000,
      status: "connecting",
    }]);
    expect(JSON.stringify(prepared.plan)).not.toContain(prepared.invite.token);
    expect(Object.keys(prepared.plan.room).sort()).toEqual([
      "code",
      "createdAt",
      "expiresAt",
      "participants",
      "receivers",
      "senderId",
    ]);
    expect(rooms.getInternalRoomSnapshot(prepared.plan.room.code)).toMatchObject({
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

  test("keeps invitation, recovery, and internal approval admission separate", () => {
    const services = createServices();
    const sender = services.visitors.createVisitor();
    const otherSender = services.visitors.createVisitor();
    const receiver = services.visitors.createVisitor();
    const stranger = services.visitors.createVisitor();
    const first = createAuthorizedRoom(services, sender.token);
    const second = createAuthorizedRoom(services, otherSender.token);

    const invited = services.rooms.prepareInviteJoin(
      first.room.code,
      receiver.token,
      first.invite.token,
    );
    if (!invited.ok) throw new Error("expected invitation join plan");
    expect(invited.plan).toMatchObject({
      kind: "join",
      role: "receiver",
      visitorId: receiver.id,
      room: { receivers: [receiver.id] },
    });
    expect(Object.keys(invited.plan).sort()).toEqual([
      "id",
      "kind",
      "revision",
      "role",
      "room",
      "visitorId",
    ]);
    expect(JSON.stringify(invited.plan)).not.toContain(first.invite.token);
    expect(services.rooms.commit(invited.plan)).toMatchObject({
      ok: true,
      room: { receivers: [receiver.id] },
    });
    expect(services.rooms.prepareInviteJoin(
      first.room.code,
      receiver.token,
      second.invite.token,
    )).toEqual({
      ok: false,
      error: {
        code: "ROOM_ACCESS_DENIED",
        message: "房间链接无效或已过期",
      },
    });
    expect(services.rooms.prepareReceiverRecovery(
      first.room.code,
      receiver.token,
    ).ok).toBe(true);
    expect(services.rooms.prepareReceiverRecovery(
      first.room.code,
      sender.token,
    )).toMatchObject({ ok: false, error: { code: "ROOM_ACCESS_DENIED" } });
    expect(services.rooms.prepareReceiverRecovery(
      first.room.code,
      stranger.token,
    )).toMatchObject({ ok: false, error: { code: "ROOM_ACCESS_DENIED" } });

    const approved = services.rooms.prepareApprovedReceiverJoin(
      first.room.code,
      stranger.token,
    );
    if (!approved.ok) throw new Error("expected approved join plan");
    expect(services.rooms.commit(approved.plan)).toMatchObject({
      ok: true,
      room: { receivers: [receiver.id, stranger.id] },
    });
  });

  test("maps malformed, wrong, cross-room, missing, and expired invitations uniformly", () => {
    const services = createServices();
    const sender = services.visitors.createVisitor();
    const secondSender = services.visitors.createVisitor();
    const receiver = services.visitors.createVisitor();
    const first = createAuthorizedRoom(services, sender.token);
    const second = createAuthorizedRoom(services, secondSender.token);
    const expected = {
      ok: false as const,
      error: {
        code: "ROOM_ACCESS_DENIED" as const,
        message: "房间链接无效或已过期",
      },
    };

    expect(services.rooms.prepareInviteJoin(
      first.room.code,
      receiver.token,
      "inv_short",
    )).toEqual(expected);
    expect(services.rooms.prepareInviteJoin(
      first.room.code,
      receiver.token,
      second.invite.token,
    )).toEqual(expected);
    expect(services.rooms.prepareInviteJoin(
      second.room.code,
      receiver.token,
      first.invite.token,
    )).toEqual(expected);
    expect(services.rooms.prepareInviteJoin(
      "999999",
      receiver.token,
      first.invite.token,
    )).toEqual(expected);
    services.setTime(first.room.expiresAt);
    expect(services.rooms.prepareInviteJoin(
      first.room.code,
      receiver.token,
      first.invite.token,
    )).toEqual(expected);
    expect(services.rooms.prepareReceiverRecovery(
      first.room.code,
      receiver.token,
    )).toEqual(expected);
  });

  test("allows the same invitation to admit twenty receivers and rejects the twenty-first", () => {
    const services = createServices();
    const sender = services.visitors.createVisitor();
    const { room, invite } = createAuthorizedRoom(services, sender.token);

    for (let index = 0; index < 20; index += 1) {
      const receiver = services.visitors.createVisitor();
      const prepared = services.rooms.prepareInviteJoin(
        room.code,
        receiver.token,
        invite.token,
      );
      if (!prepared.ok) throw new Error("expected invitation join plan");
      expect(services.rooms.commit(prepared.plan).ok).toBe(true);
    }
    const overflow = services.visitors.createVisitor();
    expect(services.rooms.prepareInviteJoin(
      room.code,
      overflow.token,
      invite.token,
    )).toEqual({
      ok: false,
      error: {
        code: "CAPACITY_EXCEEDED",
        message: "房间接收者数量已达上限",
      },
    });
    const current = services.rooms.getInternalRoomSnapshot(room.code);
    expect(current.ok && current.room.receivers).toHaveLength(20);
  });

  test("consumes opaque plans once and rechecks mutation, identity, expiry, capacity, and revision", () => {
    const forgedServices = createServices();
    const forgedSender = forgedServices.visitors.createVisitor();
    const forgedReceiver = forgedServices.visitors.createVisitor();
    const forgedRoom = createAuthorizedRoom(forgedServices, forgedSender.token);
    const authentic = forgedServices.rooms.prepareApprovedReceiverJoin(
      forgedRoom.room.code,
      forgedReceiver.token,
    );
    if (!authentic.ok) throw new Error("expected join plan");
    expect(forgedServices.rooms.commit({ ...authentic.plan })).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE" },
    });
    authentic.plan.room.receivers.push("mutated");
    expect(forgedServices.rooms.commit(authentic.plan)).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE" },
    });
    authentic.plan.room.receivers.pop();
    expect(forgedServices.rooms.commit(authentic.plan)).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE" },
    });

    const identityServices = createServices();
    const identitySender = identityServices.visitors.createVisitor();
    const identityReceiver = identityServices.visitors.createVisitor();
    const identityRoom = createRoom(identityServices, identitySender.token);
    const identityPlan = identityServices.rooms.prepareApprovedReceiverJoin(
      identityRoom.code,
      identityReceiver.token,
    );
    if (!identityPlan.ok) throw new Error("expected identity plan");
    identityServices.visitors.remove(identityReceiver.id);
    expect(identityServices.rooms.commit(identityPlan.plan)).toMatchObject({
      ok: false,
      error: { code: "VISITOR_NOT_FOUND" },
    });

    const expiryServices = createServices({ ttlMs: 1_000 });
    const expirySender = expiryServices.visitors.createVisitor();
    const expiryReceiver = expiryServices.visitors.createVisitor();
    const expiryRoom = createRoom(expiryServices, expirySender.token);
    const expiryPlan = expiryServices.rooms.prepareApprovedReceiverJoin(
      expiryRoom.code,
      expiryReceiver.token,
    );
    if (!expiryPlan.ok) throw new Error("expected expiry plan");
    expiryServices.setTime(expiryRoom.expiresAt);
    expect(expiryServices.rooms.commit(expiryPlan.plan)).toMatchObject({
      ok: false,
      error: { code: "ROOM_EXPIRED" },
    });

    const concurrentServices = createServices({ maxReceivers: 1 });
    const concurrentSender = concurrentServices.visitors.createVisitor();
    const firstReceiver = concurrentServices.visitors.createVisitor();
    const secondReceiver = concurrentServices.visitors.createVisitor();
    const concurrentRoom = createRoom(concurrentServices, concurrentSender.token);
    const firstPlan = concurrentServices.rooms.prepareApprovedReceiverJoin(
      concurrentRoom.code,
      firstReceiver.token,
    );
    const stalePlan = concurrentServices.rooms.prepareApprovedReceiverJoin(
      concurrentRoom.code,
      secondReceiver.token,
    );
    if (!firstPlan.ok || !stalePlan.ok) throw new Error("expected concurrent plans");
    expect(concurrentServices.rooms.commit(firstPlan.plan).ok).toBe(true);
    expect(concurrentServices.rooms.commit(stalePlan.plan)).toMatchObject({
      ok: false,
      error: { code: "CAPACITY_EXCEEDED" },
    });

    const revisionServices = createServices();
    const revisionSender = revisionServices.visitors.createVisitor();
    const revisionFirst = revisionServices.visitors.createVisitor();
    const revisionSecond = revisionServices.visitors.createVisitor();
    const revisionRoom = createRoom(revisionServices, revisionSender.token);
    const revisionFirstPlan = revisionServices.rooms.prepareApprovedReceiverJoin(
      revisionRoom.code,
      revisionFirst.token,
    );
    const revisionStalePlan = revisionServices.rooms.prepareApprovedReceiverJoin(
      revisionRoom.code,
      revisionSecond.token,
    );
    if (!revisionFirstPlan.ok || !revisionStalePlan.ok) {
      throw new Error("expected revision plans");
    }
    expect(revisionServices.rooms.commit(revisionFirstPlan.plan).ok).toBe(true);
    expect(revisionServices.rooms.commit(revisionStalePlan.plan)).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE" },
    });
  });

  test("preserves the invitation digest through previews and destroys access on close", () => {
    const services = createServices();
    const sender = services.visitors.createVisitor();
    const firstReceiver = services.visitors.createVisitor();
    const secondReceiver = services.visitors.createVisitor();
    const { room, invite } = createAuthorizedRoom(services, sender.token);

    expect(services.rooms.prepareInviteJoin(
      room.code,
      firstReceiver.token,
      invite.token,
    ).ok).toBe(true);
    const secondPreview = services.rooms.prepareInviteJoin(
      room.code,
      secondReceiver.token,
      invite.token,
    );
    expect(secondPreview.ok).toBe(true);
    expect(services.inviteCryptoCalls.comparedInviteDigests).toHaveLength(2);
    expect(services.rooms.leave(room.code, sender.id).ok).toBe(true);
    expect(services.rooms.prepareInviteJoin(
      room.code,
      secondReceiver.token,
      invite.token,
    )).toMatchObject({
      ok: false,
      error: { code: "ROOM_ACCESS_DENIED" },
    });
  });

  test("allows exactly two thousand live rooms and rejects the next prepare", () => {
    const services = createServices();
    for (let index = 0; index < 2_000; index += 1) {
      const sender = services.visitors.createVisitor();
      createRoom(services, sender.token);
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
    expect(atDeadline.rooms.getInternalRoomSnapshot(expiredRoom.code)).toMatchObject({
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
    const joined = joinApprovedReceiver(services, room.code, receiver.token);
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
    expect(services.rooms.getInternalRoomSnapshot(room.code).ok).toBe(true);
  });

  test("any explicit sender leave closes the room for every member", () => {
    const services = createServices();
    const sender = services.visitors.createVisitor();
    const receiver = services.visitors.createVisitor();
    const room = createRoom(services, sender.token);
    joinApprovedReceiver(services, room.code, receiver.token);

    expect(services.rooms.leave(room.code, sender.id)).toMatchObject({
      ok: true,
      transitions: [
        { type: "participant:left", roomCode: room.code, visitorId: sender.id },
        { type: "participant:left", roomCode: room.code, visitorId: receiver.id },
      ],
    });
    expect(services.rooms.getInternalRoomSnapshot(room.code)).toMatchObject({
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
    joinApprovedReceiver(receiverTimeout, room.code, receiver.token);
    receiverTimeout.setTime(25_000);

    expect(receiverTimeout.rooms.cleanupExpiredState()).toEqual([{
      type: "participant:left",
      roomCode: room.code,
      visitorId: receiver.id,
    }]);
    expect(receiverTimeout.rooms.getInternalRoomSnapshot(room.code)).toMatchObject({
      ok: true,
      room: { senderId: sender.id, receivers: [] },
    });

    const senderTimeout = createServices();
    const expiringSender = senderTimeout.visitors.createVisitor();
    const expiringReceiver = senderTimeout.visitors.createVisitor();
    const expiringRoom = createRoom(senderTimeout, expiringSender.token);
    joinApprovedReceiver(senderTimeout, expiringRoom.code, expiringReceiver.token);
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
    joinApprovedReceiver(services, roomOne.code, receiver.token);
    joinApprovedReceiver(services, roomTwo.code, receiver.token);

    expect(services.rooms.removeVisitor(receiver.id)).toEqual([
      { type: "participant:left", roomCode: roomOne.code, visitorId: receiver.id },
      { type: "participant:left", roomCode: roomTwo.code, visitorId: receiver.id },
    ]);
    expect(services.rooms.getInternalRoomSnapshot(roomOne.code).ok).toBe(true);
    expect(services.rooms.getInternalRoomSnapshot(roomTwo.code).ok).toBe(true);

    expect(services.rooms.removeVisitor(senderOne.id)).toEqual([{
      type: "participant:left",
      roomCode: roomOne.code,
      visitorId: senderOne.id,
    }]);
    expect(services.rooms.getInternalRoomSnapshot(roomOne.code).ok).toBe(false);
  });

  test("room expiry closes every member in stable order exactly once", () => {
    const services = createServices({ ttlMs: 1_000 });
    const sender = services.visitors.createVisitor();
    const receiver = services.visitors.createVisitor();
    const room = createRoom(services, sender.token);
    joinApprovedReceiver(services, room.code, receiver.token);
    services.setTime(11_000);

    expect(services.rooms.cleanupExpiredState()).toEqual([
      { type: "participant:left", roomCode: room.code, visitorId: sender.id },
      { type: "participant:left", roomCode: room.code, visitorId: receiver.id },
    ]);
    expect(services.rooms.cleanupExpiredState()).toEqual([]);
    expect(services.rooms.getInternalRoomSnapshot(room.code)).toMatchObject({
      ok: false,
      error: { code: "ROOM_NOT_FOUND" },
    });
  });
});
