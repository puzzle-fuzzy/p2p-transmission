import { isRoomInviteToken } from "@p2p/contracts";
import {
  createRandomId,
  createRoomCode as defaultCreateCode,
} from "../../shared/ids";
import type { RoomInviteCrypto } from "../../shared/room-invite-crypto";
import { minutes, now as defaultNow } from "../../shared/time";
import type { VisitorService } from "../visitor/service";
import type {
  Participant,
  ParticipantRole,
  PublicRoom,
  Room,
  RoomCreateMutationPlanResult,
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
  inviteCrypto: RoomInviteCrypto;
};

export type RoomService = {
  prepareCreate(senderToken: string): RoomCreateMutationPlanResult;
  prepareInviteJoin(
    code: string,
    visitorToken: string,
    inviteToken: string,
  ): RoomMutationPlanResult;
  prepareReceiverRecovery(
    code: string,
    visitorToken: string,
  ): RoomMutationPlanResult;
  prepareApprovedReceiverJoin(
    code: string,
    visitorToken: string,
  ): RoomMutationPlanResult;
  getInternalRoomSnapshot(code: string): RoomResult;
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
  admission: "create" | "invite" | "recovery" | "approved";
};

type PreparedMutationRecord = {
  mutation: PreparedMutation;
  fingerprint: string;
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

const roomAccessDenied = {
  code: "ROOM_ACCESS_DENIED" as const,
  message: "房间链接无效或已过期",
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
  inviteDigest: new Uint8Array(room.inviteDigest),
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
  const inviteCrypto = options.inviteCrypto;
  assertPositiveSafeInteger(ttlMs, "Room TTL");
  assertPositiveSafeInteger(attachTimeoutMs, "Attach timeout");
  assertPositiveSafeInteger(maxRooms, "Room capacity");
  assertPositiveSafeInteger(maxReceivers, "Receiver capacity");

  const rooms = new Map<string, Room>();
  const preparedMutations = new WeakMap<RoomMutationPlan, PreparedMutationRecord>();

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
  ): RoomMutationPlan => {
    const plan: RoomMutationPlan = {
      id: mutation.id,
      revision: mutation.revision,
      kind: mutation.kind,
      visitorId: mutation.visitorId,
      role: mutation.role,
      room,
    };
    preparedMutations.set(plan, {
      mutation,
      fingerprint: JSON.stringify(plan),
    });
    return plan;
  };

  const isPlanUnchanged = (
    plan: RoomMutationPlan,
    record: PreparedMutationRecord,
  ) => {
    const { mutation } = record;
    try {
      return record.fingerprint === JSON.stringify(plan)
        && plan.id === mutation.id
        && plan.revision === mutation.revision
        && plan.kind === mutation.kind
        && plan.visitorId === mutation.visitorId
        && plan.role === mutation.role
        && plan.room.code === mutation.code;
    } catch {
      return false;
    }
  };

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

  const prepareCreate = (senderToken: string): RoomCreateMutationPlanResult => {
    const sender = options.visitors.getByToken(senderToken);
    if (!sender) return { ok: false, error: visitorNotFound };
    if (rooms.size >= maxRooms) return { ok: false, error: roomCapacityExceeded };

    let code = createCode();
    while (rooms.has(code)) code = createCode();
    const timestamp = currentTime();
    const inviteToken = inviteCrypto.createToken();
    if (!isRoomInviteToken(inviteToken)) {
      throw new Error("Room invite crypto returned an invalid token");
    }
    const room: Room = {
      code,
      senderId: sender.id,
      receivers: new Set(),
      participants: new Map(),
      createdAt: timestamp,
      expiresAt: timestamp + ttlMs,
      revision: 0,
      inviteDigest: new Uint8Array(inviteCrypto.digest(inviteToken)),
    };
    addParticipant(room, sender.id, "sender", timestamp);

    const plan = makePlan({
      id: createPlanId(),
      revision: 0,
      kind: "create",
      visitorId: sender.id,
      visitorToken: senderToken,
      role: "sender",
      code,
      room,
      admission: "create",
    }, toPublicRoom(room));
    return {
      ok: true,
      plan,
      invite: {
        token: inviteToken,
        expiresAt: room.expiresAt,
      },
    };
  };

  const prepareReceiverMutation = (
    room: Room,
    visitorToken: string,
    visitorId: string,
    admission: PreparedMutation["admission"],
  ): RoomMutationPlanResult => {
    const policyError = validateJoin(room, visitorId, "receiver");
    if (policyError) return { ok: false, error: policyError };

    const preview = cloneRoom(room);
    if (!preview.participants.has(visitorId)) {
      addParticipant(preview, visitorId, "receiver", currentTime());
    }
    const plan = makePlan({
      id: createPlanId(),
      revision: room.revision,
      kind: "join",
      visitorId,
      visitorToken,
      role: "receiver",
      code: room.code,
      admission,
    }, toPublicRoom(preview));
    return { ok: true, plan };
  };

  const prepareInviteJoin = (
    code: string,
    visitorToken: string,
    inviteToken: string,
  ): RoomMutationPlanResult => {
    const visitor = options.visitors.getByToken(visitorToken);
    if (!visitor) return { ok: false, error: visitorNotFound };
    const room = rooms.get(code);
    if (
      !room
      || room.expiresAt <= currentTime()
      || !isRoomInviteToken(inviteToken)
    ) {
      return { ok: false, error: roomAccessDenied };
    }
    const candidateDigest = inviteCrypto.digest(inviteToken);
    if (!inviteCrypto.equals(room.inviteDigest, candidateDigest)) {
      return { ok: false, error: roomAccessDenied };
    }
    return prepareReceiverMutation(room, visitorToken, visitor.id, "invite");
  };

  const prepareReceiverRecovery = (
    code: string,
    visitorToken: string,
  ): RoomMutationPlanResult => {
    const visitor = options.visitors.getByToken(visitorToken);
    if (!visitor) return { ok: false, error: visitorNotFound };
    const room = rooms.get(code);
    const participant = room?.participants.get(visitor.id);
    if (
      !room
      || room.expiresAt <= currentTime()
      || participant?.role !== "receiver"
    ) {
      return { ok: false, error: roomAccessDenied };
    }
    return prepareReceiverMutation(room, visitorToken, visitor.id, "recovery");
  };

  const prepareApprovedReceiverJoin = (
    code: string,
    visitorToken: string,
  ): RoomMutationPlanResult => {
    const visitor = options.visitors.getByToken(visitorToken);
    if (!visitor) return { ok: false, error: visitorNotFound };
    const room = rooms.get(code);
    if (!room) return { ok: false, error: roomNotFound };
    if (room.expiresAt <= currentTime()) return { ok: false, error: roomExpired };
    return prepareReceiverMutation(room, visitorToken, visitor.id, "approved");
  };

  const commit = (plan: RoomMutationPlan): RoomResult => {
    const record = preparedMutations.get(plan);
    if (!record) return failure(invalidState);
    preparedMutations.delete(plan);
    if (!isPlanUnchanged(plan, record)) return failure(invalidState);
    const { mutation } = record;
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
    if (mutation.admission === "recovery") {
      const participant = room.participants.get(mutation.visitorId);
      if (participant?.role !== "receiver") return failure(roomAccessDenied);
    }
    const policyError = validateJoin(room, mutation.visitorId, mutation.role);
    if (policyError) return failure(policyError);
    if (room.revision !== mutation.revision) return failure(invalidState);
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

  const getInternalRoomSnapshot = (code: string): RoomResult => {
    const room = rooms.get(code);
    if (!room) return failure(roomNotFound);
    if (room.expiresAt <= currentTime()) return failure(roomExpired);
    return publicRoomResult(room);
  };

  return {
    prepareCreate,
    prepareInviteJoin,
    prepareReceiverRecovery,
    prepareApprovedReceiverJoin,
    getInternalRoomSnapshot,
    commit,
    attach,
    markConnecting,
    leave,
    removeVisitor,
    cleanupExpiredState,
  };
};
