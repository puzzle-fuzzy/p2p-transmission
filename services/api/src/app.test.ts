import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createRoomService } from "./modules/room/service";
import { createVisitorService } from "./modules/visitor/service";

const createTestApp = () => {
  let visitorIndex = 0;
  let roomIndex = 0;
  const visitors = createVisitorService({
    now: () => 1_000,
    createId: () => `vis_${String(++visitorIndex).padStart(3, "0")}`,
    createToken: () => `tok_${String(visitorIndex).padStart(3, "0")}`,
    createAvatarSeed: () => `avatar_${String(visitorIndex).padStart(3, "0")}`,
  });
  const rooms = createRoomService({
    visitors,
    now: () => 1_000,
    createCode: () => String(234_560 + ++roomIndex),
  });

  return createApp({ visitors, rooms });
};

const json = async <T>(response: Response) => response.json() as Promise<T>;

describe("app routes", () => {
  test("reports health", async () => {
    const app = createTestApp();

    const response = await app.handle(new Request("http://api.test/health"));
    const body = await json<{ ok: true }>(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  test("creates visitors with public identity and token", async () => {
    const app = createTestApp();

    const response = await app.handle(new Request("http://api.test/v1/visitors", {
      method: "POST",
    }));
    const body = await json<{
      visitor: {
        id: string;
        avatarSeed: string;
        displayName: string;
        createdAt: number;
        lastSeenAt: number;
      };
      token: string;
    }>(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      visitor: {
        id: "vis_001",
        avatarSeed: "avatar_001",
        displayName: "访客 0001",
        createdAt: 1_000,
        lastSeenAt: 1_000,
      },
      token: "tok_001",
    });
  });

  test("creates, joins, and reads rooms through bearer auth", async () => {
    const app = createTestApp();
    const senderResponse = await app.handle(new Request("http://api.test/v1/visitors", { method: "POST" }));
    const receiverResponse = await app.handle(new Request("http://api.test/v1/visitors", { method: "POST" }));
    const sender = await json<{ token: string }>(senderResponse);
    const receiver = await json<{ token: string }>(receiverResponse);

    const createResponse = await app.handle(new Request("http://api.test/v1/rooms", {
      method: "POST",
      headers: { authorization: `Bearer ${sender.token}` },
    }));
    const created = await json<{ room: { code: string; senderId: string } }>(createResponse);

    const joinResponse = await app.handle(new Request(`http://api.test/v1/rooms/${created.room.code}/join`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${receiver.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ role: "receiver" }),
    }));
    const joined = await json<{ room: { senderId: string; receivers: string[] } }>(joinResponse);

    const getResponse = await app.handle(new Request(`http://api.test/v1/rooms/${created.room.code}`));
    const found = await json<{ room: { participants: unknown[] } }>(getResponse);

    expect(createResponse.status).toBe(200);
    expect(joinResponse.status).toBe(200);
    expect(getResponse.status).toBe(200);
    expect(created.room).toMatchObject({ code: "234561", senderId: "vis_001" });
    expect(joined.room).toMatchObject({ senderId: "vis_001", receivers: ["vis_002"] });
    expect(found.room.participants).toHaveLength(2);
  });

  test("returns stable HTTP errors", async () => {
    const app = createTestApp();

    const unauthorized = await app.handle(new Request("http://api.test/v1/rooms", { method: "POST" }));
    const missingRoom = await app.handle(new Request("http://api.test/v1/rooms/000000"));
    const unauthorizedBody = await json<{ error: { code: string; message: string } }>(unauthorized);
    const missingRoomBody = await json<{ error: { code: string; message: string } }>(missingRoom);

    expect(unauthorized.status).toBe(401);
    expect(unauthorizedBody).toEqual({
      error: {
        code: "VISITOR_NOT_FOUND",
        message: "访客不存在或已过期",
      },
    });
    expect(missingRoom.status).toBe(404);
    expect(missingRoomBody).toEqual({
      error: {
        code: "ROOM_NOT_FOUND",
        message: "房间不存在或已过期",
      },
    });
  });
});
