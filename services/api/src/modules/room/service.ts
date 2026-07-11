import {
  createRandomId,
  createRoomCode as defaultCreateCode,
} from "../../shared/ids";
import { minutes, now as defaultNow } from "../../shared/time";
import type { VisitorService } from "../visitor/service";
import type {
  Participant,
  ParticipantRole,
  PublicRoom,
  Room,
  RoomError,
  RoomMutationPlan,
  RoomMutationPlanResult,
  RoomResult,
  RoomTransition,
  RoomTransitionResult,
} from "./model";

export type RoomServiceOptions = {
  visitors: VisitorService;
  now?: () => number;
  ttlMs?: number;
  attachTimeoutMs?: number;
  maxRooms?: number;
  maxReceivers?: number;
  createCode?: () => string;
  createPlanId?: () => string;
};

export type RoomService = {
  prepareCreate(senderToken: string): RoomMutationPlanResult;
  prepareJoin(
    code: string,
    visitorToken: string,
    role?: ParticipantRole,
  ): RoomMutationPlanResult;
  commit(plan: RoomMutationPlan): RoomResult;
  attach(
    code: string,
    visitorId: string,
    role: ParticipantRole,
  ): RoomTransitionResult;
  markConnecting(visitorId: string, roomCodes: readonly string[]): RoomTransition[];
  leave(code: string, visitorId: string): RoomTransitionResult;
  removeVisitor(visitorId: string): RoomTransition[];
  cleanupExpiredState(): RoomTransition[];
  createRoom(senderToken: string): RoomResult;
  joinRoom(code: string, visitorToken: string, role?: ParticipantRole): RoomResult;
  getRoom(code: string): RoomResult;
  leaveRoom(code: string, visitorId: string): RoomResult;
  cleanupExpiredRooms(): void;
};

type PreparedMutation = {
  id: string;
  revision: number;
  kind: "create" | "join";
  visitorId: string;
  visitorToken: string;
  role: ParticipantRole;
  code: string;
  room?: Room;
};

const visitorNotFound = {
  code: "VISITOR_NOT_FOUND" as const,
  message: "访客不存在或已过期",
};

const roomNotFound = {
  code: "ROOM_NOT_FOUND" as const,
  message: "房间不存在或已过期",
};

const roomExpired = {
  code: "ROOM_EXPIRED" as const,
  message: "房间已过期",
};

const roomSenderExists = {
  code: "ROOM_SENDER_EXISTS" as const,
  message: "房间已经有发送者",
};

const membershipRequired = {
  code: "ROOM_MEMBERSHIP_REQUIRED" as const,
  message: "请先通过房间接口创建或加入房间",
};

const invalidState = {
  code: "INVALID_STATE" as const,
  message: "房间状态已变化，请重新操作",
};

const roomCapacityExceeded = {
  code: "CAPACITY_EXCEEDED" as const,
  message: "房间容量已满",
};

const receiverCapacityExceeded = {
  code: "CAPACITY_EXCEEDED" as const,
  message: "房间接收者数量已达上限",
};

const assertPositiveSafeInteger = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
};

const cloneParticipant = (participant: Participant): Participant => ({
  ...participant,
});

const cloneRoom = (room: Room): Room => ({
  ...room,
  receivers: new Set(room.receivers),
  participants: new Map(Array.from(room.participants, ([visitorId, participant]) => [
    visitorId,
    cloneParticipant(participant),
  ])),
});

export const createRoomService = (options: RoomServiceOptions): RoomService => {
  const currentTime = options.now ?? defaultNow;
  const ttlMs = options.ttlMs ?? minutes(30);
  const attachTimeoutMs = options.attachTimeoutMs ?? 15_000;
  const maxRooms = options.maxRooms ?? 2_000;
  const maxReceivers = options.maxReceivers ?? 20;
  const createCode = options.createCode ?? defaultCreateCode;
  const createPlanId = options.createPlanId ?? (() => createRandomId("room-plan"));
  assertPositiveSafeInteger(ttlMs, "Room TTL");
  assertPositiveSafeInteger(attachTimeoutMs, "Attach timeout");
  assertPositiveSafeInteger(maxRooms, "Room capacity");
  assertPositiveSafeInteger(maxReceivers, "Receiver capacity");

  const rooms = new Map<string, Room>();
  const preparedMutations = new WeakMap<RoomMutationPlan, PreparedMutation>();

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

  const publicRoomResult = (room: Room): RoomResult => ({
    ok: true,
    room: toPublicRoom(room),
  });

  const failure = (error: RoomError): RoomResult => ({ ok: false, error });

  const transitionFailure = (
    error: RoomError,
    transitions: RoomTransition[] = [],
  ): RoomTransitionResult => ({
    ok: false,
    error,
    transitions,
  });

  const createParticipant = (
    visitorId: string,
    role: ParticipantRole,
    timestamp: number,
  ): Participant => ({
    visitorId,
    role,
    joinedAt: timestamp,
    status: "connecting",
    attachDeadlineAt: timestamp + attachTimeoutMs,
  });

  const addParticipant = (
    room: Room,
    visitorId: string,
    role: ParticipantRole,
    timestamp: number,
  ) => {
    room.participants.set(visitorId, createParticipant(visitorId, role, timestamp));
    if (role === "sender") room.senderId = visitorId;
    else room.receivers.add(visitorId);
  };

  const validateJoin = (
    room: Room,
    visitorId: string,
    role: ParticipantRole,
  ): RoomError | undefined => {
    const existing = room.participants.get(visitorId);
    if (existing) return existing.role === role ? undefined : invalidState;
    if (role === "sender" && room.senderId && room.senderId !== visitorId) {
      return roomSenderExists;
    }
    if (role === "receiver" && room.receivers.size >= maxReceivers) {
      return receiverCapacityExceeded;
    }
    return undefined;
  };

  const makePlan = (
    mutation: PreparedMutation,
    room: PublicRoom,
  ): RoomMutationPlanResult => {
    const plan: RoomMutationPlan = {
      id: mutation.id,
      revision: mutation.revision,
      kind: mutation.kind,
      visitorId: mutation.visitorId,
      role: mutation.role,
      room,
    };
    preparedMutations.set(plan, mutation);
    return { ok: true, plan };
  };

  const isPlanUnchanged = (
    plan: RoomMutationPlan,
    mutation: PreparedMutation,
  ) => plan.id === mutation.id
    && plan.revision === mutation.revision
    && plan.kind === mutation.kind
    && plan.visitorId === mutation.visitorId
    && plan.role === mutation.role
    && plan.room.code === mutation.code;

  const leftTransition = (roomCode: string, visitorId: string): RoomTransition => ({
    type: "participant:left",
    roomCode,
    visitorId,
  });

  const participantsTransition = (room: Room): RoomTransition => ({
    type: "room:participants",
    room: toPublicRoom(room),
  });

  const closeRoom = (room: Room) => {
    const snapshot = toPublicRoom(room);
    const transitions = Array.from(room.participants.keys())
      .sort()
      .map(visitorId => leftTransition(room.code, visitorId));
    rooms.delete(room.code);
    return { snapshot, transitions };
  };

  const removeReceiver = (room: Room, visitorId: string) => {
    room.participants.delete(visitorId);
    room.receivers.delete(visitorId);
    room.revision += 1;
    return leftTransition(room.code, visitorId);
  };

  const prepareCreate = (senderToken: string): RoomMutationPlanResult => {
    const sender = options.visitors.getByToken(senderToken);
    if (!sender) return { ok: false, error: visitorNotFound };
    if (rooms.size >= maxRooms) return { ok: false, error: roomCapacityExceeded };

    let code = createCode();
    while (rooms.has(code)) code = createCode();
    const timestamp = currentTime();
    const room: Room = {
      code,
      senderId: sender.id,
      receivers: new Set(),
      participants: new Map(),
      createdAt: timestamp,
      expiresAt: timestamp + ttlMs,
      revision: 0,
    };
    addParticipant(room, sender.id, "sender", timestamp);

    return makePlan({
      id: createPlanId(),
      revision: 0,
      kind: "create",
      visitorId: sender.id,
      visitorToken: senderToken,
      role: "sender",
      code,
      room,
    }, toPublicRoom(room));
  };

  const prepareJoin = (
    code: string,
    visitorToken: string,
    role: ParticipantRole = "receiver",
  ): RoomMutationPlanResult => {
    const visitor = options.visitors.getByToken(visitorToken);
    if (!visitor) return { ok: false, error: visitorNotFound };
    const room = rooms.get(code);
    if (!room) return { ok: false, error: roomNotFound };
    if (room.expiresAt <= currentTime()) return { ok: false, error: roomExpired };
    const policyError = validateJoin(room, visitor.id, role);
    if (policyError) return { ok: false, error: policyError };

    const preview = cloneRoom(room);
    if (!preview.participants.has(visitor.id)) {
      addParticipant(preview, visitor.id, role, currentTime());
    }
    return makePlan({
      id: createPlanId(),
      revision: room.revision,
      kind: "join",
      visitorId: visitor.id,
      visitorToken,
      role,
      code,
    }, toPublicRoom(preview));
  };

  const commit = (plan: RoomMutationPlan): RoomResult => {
    const mutation = preparedMutations.get(plan);
    if (!mutation) return failure(invalidState);
    preparedMutations.delete(plan);
    if (!isPlanUnchanged(plan, mutation)) return failure(invalidState);
    const visitor = options.visitors.getByToken(mutation.visitorToken);
    if (!visitor || visitor.id !== mutation.visitorId) return failure(visitorNotFound);

    if (mutation.kind === "create") {
      if (rooms.size >= maxRooms) return failure(roomCapacityExceeded);
      if (rooms.has(mutation.code) || !mutation.room) return failure(invalidState);
      if (mutation.room.expiresAt <= currentTime()) return failure(roomExpired);
      const room = cloneRoom(mutation.room);
      const sender = room.participants.get(mutation.visitorId);
      if (!sender || sender.role !== "sender") return failure(invalidState);
      sender.attachDeadlineAt = currentTime() + attachTimeoutMs;
      room.revision = 1;
      rooms.set(room.code, room);
      return publicRoomResult(room);
    }

    const room = rooms.get(mutation.code);
    if (!room) return failure(roomNotFound);
    if (room.expiresAt <= currentTime()) return failure(roomExpired);
    if (room.revision !== mutation.revision) return failure(invalidState);
    const policyError = validateJoin(room, mutation.visitorId, mutation.role);
    if (policyError) return failure(policyError);
    const existing = room.participants.get(mutation.visitorId);
    if (!existing) {
      addParticipant(room, mutation.visitorId, mutation.role, currentTime());
      room.revision += 1;
    }
    return publicRoomResult(room);
  };

  const attach = (
    code: string,
    visitorId: string,
    role: ParticipantRole,
  ): RoomTransitionResult => {
    const room = rooms.get(code);
    if (!room) return transitionFailure(roomNotFound);
    if (room.expiresAt <= currentTime()) {
      const closed = closeRoom(room);
      return transitionFailure(roomExpired, closed.transitions);
    }
    const participant = room.participants.get(visitorId);
    if (!participant) return transitionFailure(membershipRequired);
    if (
      participant.status === "connecting"
      && participant.attachDeadlineAt !== undefined
      && participant.attachDeadlineAt <= currentTime()
    ) {
      const transitions = participant.role === "sender"
        ? closeRoom(room).transitions
        : [removeReceiver(room, visitorId)];
      return transitionFailure(membershipRequired, transitions);
    }
    if (participant.role !== role) return transitionFailure(invalidState);
    if (participant.status === "online") {
      return { ok: true, room: toPublicRoom(room), transitions: [] };
    }

    participant.status = "online";
    participant.attachDeadlineAt = undefined;
    room.revision += 1;
    const publicRoom = toPublicRoom(room);
    return {
      ok: true,
      room: publicRoom,
      transitions: [{ type: "room:participants", room: publicRoom }],
    };
  };

  const markConnecting = (
    visitorId: string,
    roomCodes: readonly string[],
  ): RoomTransition[] => {
    const transitions: RoomTransition[] = [];
    for (const code of Array.from(new Set(roomCodes)).sort()) {
      const room = rooms.get(code);
      if (!room) continue;
      if (room.expiresAt <= currentTime()) {
        transitions.push(...closeRoom(room).transitions);
        continue;
      }
      const participant = room.participants.get(visitorId);
      if (!participant || participant.status === "connecting") continue;
      participant.status = "connecting";
      participant.attachDeadlineAt = currentTime() + attachTimeoutMs;
      room.revision += 1;
      transitions.push(participantsTransition(room));
    }
    return transitions;
  };

  const leave = (code: string, visitorId: string): RoomTransitionResult => {
    const room = rooms.get(code);
    if (!room) return transitionFailure(roomNotFound);
    if (room.expiresAt <= currentTime()) {
      const closed = closeRoom(room);
      return transitionFailure(roomExpired, closed.transitions);
    }
    const participant = room.participants.get(visitorId);
    if (!participant) return transitionFailure(membershipRequired);
    if (participant.role === "sender") {
      const closed = closeRoom(room);
      return { ok: true, room: closed.snapshot, transitions: closed.transitions };
    }

    const transition = removeReceiver(room, visitorId);
    return {
      ok: true,
      room: toPublicRoom(room),
      transitions: [transition],
    };
  };

  const removeVisitor = (visitorId: string): RoomTransition[] => {
    const transitions: RoomTransition[] = [];
    for (const code of Array.from(rooms.keys()).sort()) {
      const room = rooms.get(code);
      if (!room) continue;
      const participant = room.participants.get(visitorId);
      if (!participant) continue;
      if (room.expiresAt <= currentTime() || participant.role === "sender") {
        transitions.push(...closeRoom(room).transitions);
      } else {
        transitions.push(removeReceiver(room, visitorId));
      }
    }
    return transitions;
  };

  const cleanupExpiredState = (): RoomTransition[] => {
    const transitions: RoomTransition[] = [];
    const timestamp = currentTime();
    for (const code of Array.from(rooms.keys()).sort()) {
      const room = rooms.get(code);
      if (!room) continue;
      if (room.expiresAt <= timestamp) {
        transitions.push(...closeRoom(room).transitions);
        continue;
      }
      const sender = room.senderId
        ? room.participants.get(room.senderId)
        : undefined;
      if (
        !sender
        || (sender.status === "connecting"
          && sender.attachDeadlineAt !== undefined
          && sender.attachDeadlineAt <= timestamp)
      ) {
        transitions.push(...closeRoom(room).transitions);
        continue;
      }

      const expiredReceivers = Array.from(room.receivers)
        .filter(visitorId => {
          const participant = room.participants.get(visitorId);
          return participant?.status === "connecting"
            && participant.attachDeadlineAt !== undefined
            && participant.attachDeadlineAt <= timestamp;
        })
        .sort();
      for (const visitorId of expiredReceivers) {
        transitions.push(removeReceiver(room, visitorId));
      }
    }
    return transitions;
  };

  return {
    prepareCreate,
    prepareJoin,
    commit,
    attach,
    markConnecting,
    leave,
    removeVisitor,
    cleanupExpiredState,
    createRoom(senderToken) {
      const prepared = prepareCreate(senderToken);
      return prepared.ok ? commit(prepared.plan) : prepared;
    },
    joinRoom(code, visitorToken, role = "receiver") {
      const prepared = prepareJoin(code, visitorToken, role);
      return prepared.ok ? commit(prepared.plan) : prepared;
    },
    getRoom(code) {
      const room = rooms.get(code);
      if (!room) return failure(roomNotFound);
      if (room.expiresAt <= currentTime()) return failure(roomExpired);
      return publicRoomResult(room);
    },
    leaveRoom(code, visitorId) {
      const result = leave(code, visitorId);
      return result.ok ? { ok: true, room: result.room } : failure(result.error);
    },
    cleanupExpiredRooms() {
      cleanupExpiredState();
    },
  };
};
