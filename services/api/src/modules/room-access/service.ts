import type {
  PublicRoom,
  PublicVisitor,
  RoomJoinRequestReceipt,
  RoomJoinRequestState,
  RoomJoinRequestSummary,
} from "@p2p/contracts";
import { createRandomId } from "../../shared/ids";
import { now as defaultNow } from "../../shared/time";
import type { RoomService } from "../room/service";
import type { VisitorService } from "../visitor/service";
import type {
  CommitMembership,
  FinalizePlanResult,
  RoomAccessError,
  RoomAccessFinalizePlan,
  RoomAccessTransition,
  RoomFinalizeCommitResult,
  RoomJoinRequestInspectionResult,
  RoomJoinRequestListResult,
  RoomJoinRequestResult,
} from "./model";

export type RoomAccessRoomReader = Pick<RoomService, "getInternalRoomSnapshot">;

export type RoomAccessVisitorReader = Pick<
  VisitorService,
  "getById" | "getByToken" | "toPublic"
>;

export type RoomAccessServiceOptions = {
  rooms: RoomAccessRoomReader;
  visitors: RoomAccessVisitorReader;
  now?: () => number;
  createRequestId?: () => string;
  requestTtlMs?: number;
  approvedTtlMs?: number;
  tombstoneTtlMs?: number;
  maxPendingPerRoom?: number;
};

export type RoomAccessService = {
  inspectCreateOrGetPending(
    roomCode: string,
    visitorToken: string,
  ): RoomJoinRequestInspectionResult;
  createOrGetPending(
    roomCode: string,
    visitorToken: string,
  ): RoomJoinRequestResult;
  readReceipt(
    roomCode: string,
    requestId: string,
    visitorToken: string,
  ): RoomJoinRequestResult;
  listPendingForSender(
    roomCode: string,
    senderToken: string,
  ): RoomJoinRequestListResult;
  decide(
    roomCode: string,
    requestId: string,
    senderToken: string,
    decision: "approve" | "reject",
  ): RoomJoinRequestResult;
  cancel(
    roomCode: string,
    requestId: string,
    visitorToken: string,
  ): RoomJoinRequestResult;
  prepareFinalize(
    roomCode: string,
    requestId: string,
    visitorToken: string,
  ): FinalizePlanResult;
  commitFinalize(
    plan: RoomAccessFinalizePlan,
    commitMembership: CommitMembership,
  ): RoomFinalizeCommitResult;
  cleanupExpiredState(): RoomAccessTransition[];
  removeVisitor(visitorId: string): RoomAccessTransition[];
  subscribe(listener: (transition: RoomAccessTransition) => void): () => void;
};

type RoomJoinRequest = {
  requestId: string;
  roomCode: string;
  visitorId: string;
  senderId: string;
  visitor: PublicVisitor;
  state: RoomJoinRequestState;
  createdAt: number;
  expiresAt: number;
  revision: number;
};

type PreparedFinalize = {
  request: RoomJoinRequest;
  requestId: string;
  roomCode: string;
  visitorId: string;
  revision: number;
  expiresAt: number;
};

const REQUEST_TTL_MS = 90_000;
const APPROVED_TTL_MS = 30_000;
const TOMBSTONE_TTL_MS = 30_000;
const MAX_PENDING_PER_ROOM = 5;

const visitorNotFound: RoomAccessError = {
  code: "VISITOR_NOT_FOUND",
  message: "访客不存在或已过期",
};

const roomRequestUnavailable: RoomAccessError = {
  code: "ROOM_REQUEST_UNAVAILABLE",
  message: "房间不存在或暂时无法接收申请",
};

const joinRequestNotFound: RoomAccessError = {
  code: "ROOM_JOIN_REQUEST_NOT_FOUND",
  message: "加入申请不存在或已失效",
};

const joinRequestRejected: RoomAccessError = {
  code: "ROOM_JOIN_REQUEST_REJECTED",
  message: "加入申请已被拒绝",
};

const joinRequestNotApproved: RoomAccessError = {
  code: "ROOM_JOIN_REQUEST_NOT_APPROVED",
  message: "加入申请尚未获得允许",
};

const joinRequestCancelled: RoomAccessError = {
  code: "ROOM_JOIN_REQUEST_CANCELLED",
  message: "加入申请已取消",
};

const joinRequestExpired: RoomAccessError = {
  code: "ROOM_JOIN_REQUEST_EXPIRED",
  message: "加入申请已过期",
};

const invalidState: RoomAccessError = {
  code: "INVALID_STATE",
  message: "加入申请状态已变化，请重试",
};

const assertPositiveSafeInteger = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
};

const cloneVisitor = (visitor: PublicVisitor): PublicVisitor => ({ ...visitor });

const sortRequests = (left: RoomJoinRequest, right: RoomJoinRequest) =>
  left.createdAt - right.createdAt
  || (left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0);

const failure = (error: RoomAccessError): RoomJoinRequestResult => ({
  ok: false,
  error,
});

const listFailure = (error: RoomAccessError): RoomJoinRequestListResult => ({
  ok: false,
  error,
});

export const createRoomAccessService = (
  options: RoomAccessServiceOptions,
): RoomAccessService => {
  const currentTime = options.now ?? defaultNow;
  const createRequestId = options.createRequestId
    ?? (() => createRandomId("room-request"));
  const requestTtlMs = options.requestTtlMs ?? REQUEST_TTL_MS;
  const approvedTtlMs = options.approvedTtlMs ?? APPROVED_TTL_MS;
  const tombstoneTtlMs = options.tombstoneTtlMs ?? TOMBSTONE_TTL_MS;
  const maxPendingPerRoom = options.maxPendingPerRoom ?? MAX_PENDING_PER_ROOM;
  assertPositiveSafeInteger(requestTtlMs, "Request TTL");
  assertPositiveSafeInteger(approvedTtlMs, "Approved request TTL");
  assertPositiveSafeInteger(tombstoneTtlMs, "Request tombstone TTL");
  assertPositiveSafeInteger(maxPendingPerRoom, "Pending request capacity");

  const requests = new Map<string, RoomJoinRequest>();
  const requestsByRoomVisitor = new Map<string, string>();
  const finalizePlans = new WeakMap<RoomAccessFinalizePlan, PreparedFinalize>();
  const finalizingRequests = new Set<string>();
  const listeners = new Set<(transition: RoomAccessTransition) => void>();

  const roomVisitorKey = (roomCode: string, visitorId: string) =>
    `${roomCode}\u0000${visitorId}`;

  const toReceipt = (request: RoomJoinRequest): RoomJoinRequestReceipt => ({
    requestId: request.requestId,
    state: request.state,
    expiresAt: request.expiresAt,
  });

  const toSummary = (request: RoomJoinRequest): RoomJoinRequestSummary => ({
    requestId: request.requestId,
    roomCode: request.roomCode,
    visitor: cloneVisitor(request.visitor),
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  });

  const cloneTransition = (
    transition: RoomAccessTransition,
  ): RoomAccessTransition => transition.type === "room:join-requested"
    ? {
        ...transition,
        request: {
          ...transition.request,
          visitor: cloneVisitor(transition.request.visitor),
        },
      }
    : { ...transition };

  const safePublish = (transition: RoomAccessTransition) => {
    for (const listener of listeners) {
      try {
        listener(cloneTransition(transition));
      } catch {
        // Admission state is authoritative even when an external subscriber fails.
      }
    }
  };

  const requestedTransition = (
    request: RoomJoinRequest,
  ): RoomAccessTransition => ({
    type: "room:join-requested",
    senderId: request.senderId,
    request: toSummary(request),
  });

  const resolvedTransition = (
    request: RoomJoinRequest,
  ): RoomAccessTransition => {
    if (request.state === "pending") {
      throw new Error("A pending request cannot produce a resolved transition");
    }

    return {
      type: "room:join-request-resolved",
      senderId: request.senderId,
      roomCode: request.roomCode,
      requestId: request.requestId,
      state: request.state,
    };
  };

  const publishTransition = (transition: RoomAccessTransition) => {
    safePublish(transition);
    return transition;
  };

  const deleteRequest = (request: RoomJoinRequest) => {
    requests.delete(request.requestId);
    const key = roomVisitorKey(request.roomCode, request.visitorId);
    if (requestsByRoomVisitor.get(key) === request.requestId) {
      requestsByRoomVisitor.delete(key);
    }
  };

  const transitionTo = (
    request: RoomJoinRequest,
    state: Exclude<RoomJoinRequestState, "pending">,
    timestamp: number,
    ttlMs: number,
  ) => {
    request.state = state;
    request.revision += 1;
    request.expiresAt = timestamp + ttlMs;
    return publishTransition(resolvedTransition(request));
  };

  const reconcileDeadline = (
    request: RoomJoinRequest,
    timestamp: number,
  ): "retained" | "removed" => {
    if (finalizingRequests.has(request.requestId)) return "retained";
    if (request.expiresAt > timestamp) return "retained";
    if (request.state === "pending" || request.state === "approved") {
      transitionTo(request, "expired", timestamp, tombstoneTtlMs);
      return "retained";
    }
    deleteRequest(request);
    return "removed";
  };

  const findBoundRequest = (
    roomCode: string,
    requestId: string,
    visitorId: string,
  ) => {
    const request = requests.get(requestId);
    return request?.roomCode === roomCode && request.visitorId === visitorId
      ? request
      : undefined;
  };

  const isCurrentSender = (
    roomCode: string,
    senderId: string,
  ): { room: PublicRoom } | undefined => {
    const result = options.rooms.getInternalRoomSnapshot(roomCode);
    if (!result.ok || result.room.senderId !== senderId) return undefined;
    const sender = result.room.participants.find(participant =>
      participant.visitor.id === senderId && participant.role === "sender"
    );
    return sender ? { room: result.room } : undefined;
  };

  const isRequestableRoom = (
    roomCode: string,
    visitorId: string,
  ): { room: PublicRoom; senderId: string } | undefined => {
    const result = options.rooms.getInternalRoomSnapshot(roomCode);
    if (!result.ok || !result.room.senderId) return undefined;
    if (result.room.participants.some(participant =>
      participant.visitor.id === visitorId
    )) {
      return undefined;
    }
    const sender = result.room.participants.find(participant =>
      participant.visitor.id === result.room.senderId
      && participant.role === "sender"
      && participant.status === "online"
    );
    if (!sender || !options.visitors.getById(sender.visitor.id)) return undefined;
    return { room: result.room, senderId: sender.visitor.id };
  };

  const requestErrorForState = (state: RoomJoinRequestState): RoomAccessError => {
    switch (state) {
      case "pending":
        return joinRequestNotApproved;
      case "approved":
        return invalidState;
      case "rejected":
        return joinRequestRejected;
      case "cancelled":
        return joinRequestCancelled;
      case "expired":
        return joinRequestExpired;
      case "finalized":
        return invalidState;
    }
  };

  const inspectCreateOrGetPending = (
    roomCode: string,
    visitorToken: string,
  ): RoomJoinRequestInspectionResult => {
    const visitor = options.visitors.getByToken(visitorToken);
    if (!visitor) return { ok: false, error: visitorNotFound };
    const existingId = requestsByRoomVisitor.get(roomVisitorKey(roomCode, visitor.id));
    const existing = existingId ? requests.get(existingId) : undefined;
    if (existing) {
      return { ok: true, mode: "existing", receipt: toReceipt(existing) };
    }

    const requestable = isRequestableRoom(roomCode, visitor.id);
    if (!requestable) return { ok: false, error: roomRequestUnavailable };
    const pendingCount = Array.from(requests.values()).filter(request =>
      request.roomCode === roomCode && request.state === "pending"
    ).length;
    if (pendingCount >= maxPendingPerRoom) {
      return { ok: false, error: roomRequestUnavailable };
    }
    return { ok: true, mode: "requestable" };
  };

  const createOrGetPending = (
    roomCode: string,
    visitorToken: string,
  ): RoomJoinRequestResult => {
    const visitor = options.visitors.getByToken(visitorToken);
    if (!visitor) return failure(visitorNotFound);
    const key = roomVisitorKey(roomCode, visitor.id);
    const existingId = requestsByRoomVisitor.get(key);
    const existing = existingId ? requests.get(existingId) : undefined;
    if (existing) {
      if (reconcileDeadline(existing, currentTime()) === "retained") {
        return { ok: true, receipt: toReceipt(existing) };
      }
    } else if (existingId) {
      requestsByRoomVisitor.delete(key);
    }

    const requestable = isRequestableRoom(roomCode, visitor.id);
    if (!requestable) return failure(roomRequestUnavailable);
    const pendingCount = Array.from(requests.values()).filter(request =>
      request.roomCode === roomCode && request.state === "pending"
    ).length;
    if (pendingCount >= maxPendingPerRoom) return failure(roomRequestUnavailable);

    let requestId = createRequestId();
    while (requests.has(requestId)) requestId = createRequestId();
    const timestamp = currentTime();
    const request: RoomJoinRequest = {
      requestId,
      roomCode,
      visitorId: visitor.id,
      senderId: requestable.senderId,
      visitor: options.visitors.toPublic(visitor),
      state: "pending",
      createdAt: timestamp,
      expiresAt: timestamp + requestTtlMs,
      revision: 0,
    };
    requests.set(request.requestId, request);
    requestsByRoomVisitor.set(key, request.requestId);
    publishTransition(requestedTransition(request));
    return { ok: true, receipt: toReceipt(request) };
  };

  const readReceipt = (
    roomCode: string,
    requestId: string,
    visitorToken: string,
  ): RoomJoinRequestResult => {
    const visitor = options.visitors.getByToken(visitorToken);
    if (!visitor) return failure(visitorNotFound);
    const request = findBoundRequest(roomCode, requestId, visitor.id);
    if (!request) return failure(joinRequestNotFound);
    if (reconcileDeadline(request, currentTime()) === "removed") {
      return failure(joinRequestNotFound);
    }
    return { ok: true, receipt: toReceipt(request) };
  };

  const listPendingForSender = (
    roomCode: string,
    senderToken: string,
  ): RoomJoinRequestListResult => {
    const sender = options.visitors.getByToken(senderToken);
    if (!sender) return listFailure(visitorNotFound);
    if (!isCurrentSender(roomCode, sender.id)) return listFailure(joinRequestNotFound);
    const timestamp = currentTime();
    const roomRequests = Array.from(requests.values())
      .filter(request => request.roomCode === roomCode);
    for (const request of roomRequests) reconcileDeadline(request, timestamp);
    return {
      ok: true,
      requests: roomRequests
        .filter(request => requests.has(request.requestId) && request.state === "pending")
        .sort(sortRequests)
        .map(toSummary),
    };
  };

  const decide = (
    roomCode: string,
    requestId: string,
    senderToken: string,
    decision: "approve" | "reject",
  ): RoomJoinRequestResult => {
    const sender = options.visitors.getByToken(senderToken);
    if (!sender) return failure(visitorNotFound);
    const request = requests.get(requestId);
    if (
      !request
      || request.roomCode !== roomCode
      || request.senderId !== sender.id
      || !isCurrentSender(roomCode, sender.id)
    ) {
      return failure(joinRequestNotFound);
    }
    const timestamp = currentTime();
    if (reconcileDeadline(request, timestamp) === "removed") {
      return failure(joinRequestNotFound);
    }
    if (request.state !== "pending") {
      return { ok: true, receipt: toReceipt(request) };
    }
    transitionTo(
      request,
      decision === "approve" ? "approved" : "rejected",
      timestamp,
      decision === "approve" ? approvedTtlMs : tombstoneTtlMs,
    );
    return { ok: true, receipt: toReceipt(request) };
  };

  const cancel = (
    roomCode: string,
    requestId: string,
    visitorToken: string,
  ): RoomJoinRequestResult => {
    const visitor = options.visitors.getByToken(visitorToken);
    if (!visitor) return failure(visitorNotFound);
    const request = findBoundRequest(roomCode, requestId, visitor.id);
    if (!request) return failure(joinRequestNotFound);
    const timestamp = currentTime();
    if (reconcileDeadline(request, timestamp) === "removed") {
      return failure(joinRequestNotFound);
    }
    if (request.state !== "pending" && request.state !== "approved") {
      return { ok: true, receipt: toReceipt(request) };
    }
    if (finalizingRequests.has(request.requestId)) {
      return { ok: true, receipt: toReceipt(request) };
    }
    transitionTo(request, "cancelled", timestamp, tombstoneTtlMs);
    return { ok: true, receipt: toReceipt(request) };
  };

  const prepareFinalize = (
    roomCode: string,
    requestId: string,
    visitorToken: string,
  ): FinalizePlanResult => {
    const visitor = options.visitors.getByToken(visitorToken);
    if (!visitor) return { ok: false, error: visitorNotFound };
    const request = findBoundRequest(roomCode, requestId, visitor.id);
    if (!request) return { ok: false, error: joinRequestNotFound };
    if (reconcileDeadline(request, currentTime()) === "removed") {
      return { ok: false, error: joinRequestNotFound };
    }
    if (request.state === "finalized") {
      return { ok: true, mode: "recovery", receipt: toReceipt(request) };
    }
    if (request.state !== "approved") {
      return { ok: false, error: requestErrorForState(request.state) };
    }
    const plan: RoomAccessFinalizePlan = {
      requestId: request.requestId,
      roomCode: request.roomCode,
      visitorId: request.visitorId,
      revision: request.revision,
      expiresAt: request.expiresAt,
    };
    finalizePlans.set(plan, {
      request,
      requestId: plan.requestId,
      roomCode: plan.roomCode,
      visitorId: plan.visitorId,
      revision: plan.revision,
      expiresAt: plan.expiresAt,
    });
    return { ok: true, mode: "commit", plan };
  };

  const commitFinalize = (
    plan: RoomAccessFinalizePlan,
    commitMembership: CommitMembership,
  ): RoomFinalizeCommitResult => {
    const prepared = finalizePlans.get(plan);
    if (!prepared) return { ok: false, error: invalidState };
    finalizePlans.delete(plan);
    const request = requests.get(prepared.requestId);
    if (
      request !== prepared.request
      || plan.requestId !== prepared.requestId
      || plan.roomCode !== prepared.roomCode
      || plan.visitorId !== prepared.visitorId
      || plan.revision !== prepared.revision
      || plan.expiresAt !== prepared.expiresAt
      || request.roomCode !== prepared.roomCode
      || request.visitorId !== prepared.visitorId
      || request.revision !== prepared.revision
      || request.expiresAt !== prepared.expiresAt
      || finalizingRequests.has(request.requestId)
    ) {
      return { ok: false, error: invalidState };
    }
    const timestamp = currentTime();
    if (request.state !== "approved") {
      return { ok: false, error: requestErrorForState(request.state) };
    }
    if (request.expiresAt <= timestamp) {
      transitionTo(request, "expired", timestamp, tombstoneTtlMs);
      return { ok: false, error: joinRequestExpired };
    }
    if (!options.visitors.getById(request.visitorId)) {
      transitionTo(request, "expired", timestamp, tombstoneTtlMs);
      return { ok: false, error: invalidState };
    }

    let membership: ReturnType<CommitMembership>;
    finalizingRequests.add(request.requestId);
    try {
      membership = commitMembership();
    } catch {
      finalizingRequests.delete(request.requestId);
      return { ok: false, error: invalidState };
    }
    finalizingRequests.delete(request.requestId);
    if (!membership.ok) return membership;

    request.state = "finalized";
    request.revision += 1;
    request.expiresAt = timestamp + tombstoneTtlMs;
    const receipt = toReceipt(request);
    const transition = resolvedTransition(request);
    safePublish(transition);
    return { ok: true, receipt, room: membership.room };
  };

  const cleanupExpiredState = (): RoomAccessTransition[] => {
    const timestamp = currentTime();
    const transitions: RoomAccessTransition[] = [];
    for (const request of Array.from(requests.values()).sort(sortRequests)) {
      if (request.expiresAt <= timestamp) {
        const previousState = request.state;
        const result = reconcileDeadline(request, timestamp);
        if (
          result === "retained"
          && previousState !== "expired"
          && request.state === "expired"
        ) {
          transitions.push(resolvedTransition(request));
        }
        continue;
      }
      if (request.state !== "pending" && request.state !== "approved") continue;
      if (finalizingRequests.has(request.requestId)) continue;
      const room = options.rooms.getInternalRoomSnapshot(request.roomCode);
      const senderIsCurrent = room.ok && room.room.senderId === request.senderId;
      if (
        !senderIsCurrent
        || !options.visitors.getById(request.senderId)
        || !options.visitors.getById(request.visitorId)
      ) {
        transitions.push(transitionTo(
          request,
          "expired",
          timestamp,
          tombstoneTtlMs,
        ));
      }
    }
    return transitions;
  };

  const removeVisitor = (visitorId: string): RoomAccessTransition[] => {
    const timestamp = currentTime();
    const transitions: RoomAccessTransition[] = [];
    for (const request of Array.from(requests.values()).sort(sortRequests)) {
      if (
        (request.state === "pending" || request.state === "approved")
        && !finalizingRequests.has(request.requestId)
        && (request.visitorId === visitorId || request.senderId === visitorId)
      ) {
        transitions.push(transitionTo(
          request,
          "expired",
          timestamp,
          tombstoneTtlMs,
        ));
      }
    }
    return transitions;
  };

  return {
    inspectCreateOrGetPending,
    createOrGetPending,
    readReceipt,
    listPendingForSender,
    decide,
    cancel,
    prepareFinalize,
    commitFinalize,
    cleanupExpiredState,
    removeVisitor,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
