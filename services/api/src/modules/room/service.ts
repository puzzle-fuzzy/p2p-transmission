import { createRoomCode as defaultCreateCode } from "../../shared/ids";
import { minutes, now as defaultNow } from "../../shared/time";
import type { VisitorService } from "../visitor/service";
import type { Participant, ParticipantRole, PublicRoom, Room, RoomResult } from "./model";

export type RoomServiceOptions = {
  visitors: VisitorService;
  now?: () => number;
  ttlMs?: number;
  createCode?: () => string;
};

export type RoomService = {
  createRoom(senderToken: string): RoomResult;
  joinRoom(code: string, visitorToken: string, role?: ParticipantRole): RoomResult;
  getRoom(code: string): RoomResult;
  leaveRoom(code: string, visitorId: string): RoomResult;
  cleanupExpiredRooms(): void;
};

const visitorNotFound = {
  code: "VISITOR_NOT_FOUND" as const,
  message: "访客不存在或已过期",
};

const roomNotFound = {
  code: "ROOM_NOT_FOUND" as const,
  message: "房间不存在或已过期",
};

const roomSenderExists = {
  code: "ROOM_SENDER_EXISTS" as const,
  message: "房间已经有发送者",
};

export const createRoomService = (options: RoomServiceOptions): RoomService => {
  const currentTime = options.now ?? defaultNow;
  const ttlMs = options.ttlMs ?? minutes(30);
  const createCode = options.createCode ?? defaultCreateCode;
  const rooms = new Map<string, Room>();

  const getActiveRoom = (code: string) => {
    const room = rooms.get(code);

    if (!room) return undefined;
    if (room.expiresAt <= currentTime()) {
      rooms.delete(code);
      return undefined;
    }

    return room;
  };

  const toPublicRoom = (room: Room): PublicRoom => ({
    code: room.code,
    senderId: room.senderId,
    receivers: Array.from(room.receivers),
    participants: Array.from(room.participants.values()).flatMap(participant => {
      const visitor = options.visitors.getById(participant.visitorId);

      if (!visitor) return [];

      return [{
        visitor: options.visitors.toPublic(visitor),
        role: participant.role,
        joinedAt: participant.joinedAt,
        status: participant.status,
      }];
    }),
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
  });

  const addParticipant = (room: Room, visitorId: string, role: ParticipantRole) => {
    const timestamp = currentTime();
    const participant: Participant = {
      visitorId,
      role,
      joinedAt: timestamp,
      status: "online",
    };

    room.participants.set(visitorId, participant);
    if (role === "sender") room.senderId = visitorId;
    if (role === "receiver") room.receivers.add(visitorId);
  };

  return {
    createRoom(senderToken) {
      const sender = options.visitors.getByToken(senderToken);

      if (!sender) return { ok: false, error: visitorNotFound };

      let code = createCode();
      while (rooms.has(code)) code = createCode();

      const timestamp = currentTime();
      const room: Room = {
        code,
        senderId: null,
        receivers: new Set(),
        participants: new Map(),
        createdAt: timestamp,
        expiresAt: timestamp + ttlMs,
      };

      addParticipant(room, sender.id, "sender");
      rooms.set(code, room);

      return { ok: true, room: toPublicRoom(room) };
    },
    joinRoom(code, visitorToken, role = "receiver") {
      const visitor = options.visitors.getByToken(visitorToken);

      if (!visitor) return { ok: false, error: visitorNotFound };

      const room = getActiveRoom(code);

      if (!room) return { ok: false, error: roomNotFound };
      if (role === "sender" && room.senderId && room.senderId !== visitor.id) {
        return { ok: false, error: roomSenderExists };
      }

      addParticipant(room, visitor.id, role);

      return { ok: true, room: toPublicRoom(room) };
    },
    getRoom(code) {
      const room = getActiveRoom(code);

      if (!room) return { ok: false, error: roomNotFound };

      return { ok: true, room: toPublicRoom(room) };
    },
    leaveRoom(code, visitorId) {
      const room = getActiveRoom(code);

      if (!room) return { ok: false, error: roomNotFound };

      const participant = room.participants.get(visitorId);
      if (participant) participant.status = "left";
      room.participants.delete(visitorId);
      room.receivers.delete(visitorId);
      if (room.senderId === visitorId) room.senderId = null;

      if (room.participants.size === 0) rooms.delete(code);

      return { ok: true, room: toPublicRoom(room) };
    },
    cleanupExpiredRooms() {
      for (const [code, room] of rooms) {
        if (room.expiresAt <= currentTime()) rooms.delete(code);
      }
    },
  };
};
