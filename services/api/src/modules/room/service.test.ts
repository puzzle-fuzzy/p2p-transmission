import { describe, expect, test } from "bun:test";
import { createVisitorService } from "../visitor/service";
import { createRoomService } from "./service";

const createServices = () => {
  let time = 10_000;
  let visitorIndex = 0;
  let roomIndex = 0;
  const visitors = createVisitorService({
    now: () => time,
    createId: () => `vis_${String(++visitorIndex).padStart(3, "0")}`,
    createToken: () => `tok_${String(visitorIndex).padStart(3, "0")}`,
    createAvatarSeed: () => `avatar_${String(visitorIndex).padStart(3, "0")}`,
  });
  const rooms = createRoomService({
    visitors,
    now: () => time,
    ttlMs: 1_000,
    createCode: () => String(100_000 + ++roomIndex),
  });

  return {
    visitors,
    rooms,
    setTime: (value: number) => {
      time = value;
    },
  };
};

describe("room service", () => {
  test("creates a room with creator as sender", () => {
    const { visitors, rooms } = createServices();
    const sender = visitors.createVisitor();

    const result = rooms.createRoom(sender.token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.room).toMatchObject({
      code: "100001",
      senderId: sender.id,
      createdAt: 10_000,
      expiresAt: 11_000,
    });
    expect(result.room.participants).toEqual([
      {
        visitor: visitors.toPublic(sender),
        role: "sender",
        joinedAt: 10_000,
        status: "online",
      },
    ]);
  });

  test("joins receivers to an existing room", () => {
    const { visitors, rooms } = createServices();
    const sender = visitors.createVisitor();
    const receiver = visitors.createVisitor();
    const created = rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");

    const joined = rooms.joinRoom(created.room.code, receiver.token);

    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.room.senderId).toBe(sender.id);
    expect(joined.room.receivers).toEqual([receiver.id]);
    expect(joined.room.participants.map(participant => participant.role)).toEqual([
      "sender",
      "receiver",
    ]);
  });

  test("prevents a second sender from joining the room", () => {
    const { visitors, rooms } = createServices();
    const sender = visitors.createVisitor();
    const secondSender = visitors.createVisitor();
    const created = rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");

    const result = rooms.joinRoom(created.room.code, secondSender.token, "sender");

    expect(result).toEqual({
      ok: false,
      error: {
        code: "ROOM_SENDER_EXISTS",
        message: "房间已经有发送者",
      },
    });
  });

  test("returns stable errors for missing rooms and bad visitor tokens", () => {
    const { visitors, rooms } = createServices();
    const visitor = visitors.createVisitor();

    expect(rooms.createRoom("bad_token")).toEqual({
      ok: false,
      error: {
        code: "VISITOR_NOT_FOUND",
        message: "访客不存在或已过期",
      },
    });
    expect(rooms.joinRoom("999999", visitor.token)).toEqual({
      ok: false,
      error: {
        code: "ROOM_NOT_FOUND",
        message: "房间不存在或已过期",
      },
    });
  });

  test("cleans expired rooms", () => {
    const { visitors, rooms, setTime } = createServices();
    const sender = visitors.createVisitor();
    const created = rooms.createRoom(sender.token);
    if (!created.ok) throw new Error("expected room");

    setTime(11_001);
    rooms.cleanupExpiredRooms();

    expect(rooms.getRoom(created.room.code)).toEqual({
      ok: false,
      error: {
        code: "ROOM_NOT_FOUND",
        message: "房间不存在或已过期",
      },
    });
  });
});
