import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSqliteState, createSqliteStateStore } from "./sqlite";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite state store", () => {
  test("round-trips visitors, rooms, participants, and join requests", () => {
    const directory = mkdtempSync(join(tmpdir(), "p2p-state-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "app.sqlite");
    const visitor = {
      id: "vis_1",
      avatarSeed: "avatar_1",
      displayName: "访客 0001",
      token: "token_1",
      createdAt: 1_000,
      lastSeenAt: 1_100,
    };
    const room = {
      code: "123456",
      senderId: visitor.id,
      receivers: new Set<string>(),
      participants: new Map([
        [visitor.id, {
          visitorId: visitor.id,
          role: "sender" as const,
          joinedAt: 1_000,
          status: "online" as const,
        }],
      ]),
      createdAt: 1_000,
      expiresAt: 2_000,
      revision: 1,
      inviteDigest: new Uint8Array([1, 2, 3]),
    };
    const store = createSqliteStateStore(databasePath, {
      visitors: { snapshot: () => [visitor] },
      rooms: { snapshot: () => [room] },
      roomAccess: {
        snapshot: () => [{
          requestId: "request_1",
          roomCode: room.code,
          visitorId: visitor.id,
          senderId: visitor.id,
          state: "pending" as const,
          createdAt: 1_100,
          expiresAt: 1_200,
          revision: 0,
        }],
      },
    });

    store.save();
    store.close();

    const restored = loadSqliteState(databasePath);
    expect(restored.visitors).toEqual([visitor]);
    expect(restored.rooms).toHaveLength(1);
    expect(restored.rooms[0]?.inviteDigest).toEqual(new Uint8Array([1, 2, 3]));
    expect(restored.rooms[0]?.participants.get(visitor.id)).toMatchObject({
      role: "sender",
      status: "online",
    });
    expect(restored.joinRequests).toEqual([{
      requestId: "request_1",
      roomCode: room.code,
      visitorId: visitor.id,
      senderId: visitor.id,
      state: "pending",
      createdAt: 1_100,
      expiresAt: 1_200,
      revision: 0,
    }]);
  });
});
