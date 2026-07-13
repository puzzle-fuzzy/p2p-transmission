import { Database } from "bun:sqlite";
import type { StateStore } from "./model";
import { applyMigrations } from "./migrations";
import type { PersistedState } from "./model";
import type { Room } from "../modules/room/model";
import type { RoomJoinRequestSnapshot } from "../modules/room-access/model";
import type { Visitor } from "../modules/visitor/model";

type StateSources = {
  visitors: Pick<{ snapshot(): Visitor[] }, "snapshot">;
  rooms: Pick<{ snapshot(): Room[] }, "snapshot">;
  roomAccess: Pick<{ snapshot(): RoomJoinRequestSnapshot[] }, "snapshot">;
};

type VisitorRow = {
  id: string;
  avatar_seed: string;
  display_name: string;
  token: string;
  created_at: number;
  last_seen_at: number;
};

type RoomRow = {
  code: string;
  sender_id: string | null;
  created_at: number;
  expires_at: number;
  revision: number;
  invite_digest: Uint8Array | ArrayBuffer;
};

type ParticipantRow = {
  room_code: string;
  visitor_id: string;
  role: "sender" | "receiver";
  joined_at: number;
  status: "connecting" | "online";
  attach_deadline_at: number | null;
};

type JoinRequestRow = {
  request_id: string;
  room_code: string;
  visitor_id: string;
  sender_id: string;
  state: RoomJoinRequestSnapshot["state"];
  created_at: number;
  expires_at: number;
  revision: number;
};

const asBytes = (value: Uint8Array | ArrayBuffer) =>
  value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);

const createDatabase = (path: string) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let database: Database | undefined;
    try {
      database = new Database(path);
      applyMigrations(database);
      return database;
    } catch (error) {
      lastError = error;
      try {
        database?.close();
      } catch {
        // Preserve the original initialization failure.
      }
    }
  }
  throw new Error("SQLite 初始化失败", { cause: lastError });
};

const loadState = (database: Database): PersistedState => {
  const visitors = database.query<VisitorRow, []>(
    "SELECT id, avatar_seed, display_name, token, created_at, last_seen_at FROM visitors",
  ).all().map(row => ({
    id: row.id,
    avatarSeed: row.avatar_seed,
    displayName: row.display_name,
    token: row.token,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  }));

  const roomsByCode = new Map<string, Room>();
  const roomRows = database.query<RoomRow, []>(
    "SELECT code, sender_id, created_at, expires_at, revision, invite_digest FROM rooms",
  ).all();
  for (const row of roomRows) {
    roomsByCode.set(row.code, {
      code: row.code,
      senderId: row.sender_id,
      receivers: new Set(),
      participants: new Map(),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revision: row.revision,
      inviteDigest: asBytes(row.invite_digest),
    });
  }

  const participants = database.query<ParticipantRow, []>(
    "SELECT room_code, visitor_id, role, joined_at, status, attach_deadline_at FROM room_participants",
  ).all();
  for (const row of participants) {
    const room = roomsByCode.get(row.room_code);
    if (!room) continue;
    const participant = {
      visitorId: row.visitor_id,
      role: row.role,
      joinedAt: row.joined_at,
      status: row.status,
      ...(row.attach_deadline_at === null
        ? {}
        : { attachDeadlineAt: row.attach_deadline_at }),
    } as Room["participants"] extends Map<string, infer P> ? P : never;
    room.participants.set(row.visitor_id, participant);
    if (row.role === "receiver") room.receivers.add(row.visitor_id);
  }

  const joinRequests = database.query<JoinRequestRow, []>(
    "SELECT request_id, room_code, visitor_id, sender_id, state, created_at, expires_at, revision FROM room_join_requests",
  ).all().filter(row => roomsByCode.has(row.room_code)).map(row => ({
    requestId: row.request_id,
    roomCode: row.room_code,
    visitorId: row.visitor_id,
    senderId: row.sender_id,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revision: row.revision,
  }));

  return {
    visitors,
    rooms: Array.from(roomsByCode.values()),
    joinRequests,
  };
};

export const loadSqliteState = (path: string): PersistedState => {
  const database = createDatabase(path);
  try {
    return loadState(database);
  } finally {
    database.close();
  }
};

export const createSqliteStateStore = (
  path: string,
  sources: StateSources,
): StateStore & { database: Database } => {
  const database = createDatabase(path);
  let closed = false;

  const save = () => {
    if (closed) throw new Error("SQLite 状态存储已关闭");
    const state = {
      visitors: sources.visitors.snapshot(),
      rooms: sources.rooms.snapshot(),
      joinRequests: sources.roomAccess.snapshot(),
    } satisfies PersistedState;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec("DELETE FROM room_join_requests; DELETE FROM room_participants; DELETE FROM rooms; DELETE FROM visitors;");
      const visitorInsert = database.query(
        "INSERT INTO visitors (id, avatar_seed, display_name, token, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const visitor of state.visitors) {
        visitorInsert.run(
          visitor.id,
          visitor.avatarSeed,
          visitor.displayName,
          visitor.token,
          visitor.createdAt,
          visitor.lastSeenAt,
        );
      }
      const roomInsert = database.query(
        "INSERT INTO rooms (code, sender_id, created_at, expires_at, revision, invite_digest) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const participantInsert = database.query(
        "INSERT INTO room_participants (room_code, visitor_id, role, joined_at, status, attach_deadline_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const room of state.rooms) {
        roomInsert.run(
          room.code,
          room.senderId,
          room.createdAt,
          room.expiresAt,
          room.revision,
          room.inviteDigest,
        );
        for (const participant of room.participants.values()) {
          participantInsert.run(
            room.code,
            participant.visitorId,
            participant.role,
            participant.joinedAt,
            participant.status,
            participant.attachDeadlineAt ?? null,
          );
        }
      }
      const requestInsert = database.query(
        "INSERT INTO room_join_requests (request_id, room_code, visitor_id, sender_id, state, created_at, expires_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const request of state.joinRequests) {
        requestInsert.run(
          request.requestId,
          request.roomCode,
          request.visitorId,
          request.senderId,
          request.state,
          request.createdAt,
          request.expiresAt,
          request.revision,
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    database,
    load: () => loadState(database),
    save,
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
};
