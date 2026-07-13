import type {
  ReceiverJoinBody,
  RoomIceMode,
  RoomJoinRequestReceipt,
  RoomOwnerBootstrap,
  RoomSessionBootstrap,
} from "@p2p/contracts";
import type { MaintenanceService } from "../maintenance/model";
import type { RateLimitCheck, RateLimitError } from "../rate-limit/model";
import type { RateLimitService } from "../rate-limit/service";
import type { RoomAccessError } from "../room-access/model";
import type { RoomAccessService } from "../room-access/service";
import type { TurnCredential, TurnError } from "../turn/model";
import type { TurnService } from "../turn/service";
import type { Visitor } from "../visitor/model";
import type { VisitorService } from "../visitor/service";
import type { RoomError, RoomMutationPlan } from "./model";
import type { RoomService } from "./service";

export type RoomBootstrapError =
  | RoomError
  | RoomAccessError
  | RateLimitError
  | TurnError;

export type RoomBootstrapResult =
  | { ok: true; bootstrap: RoomSessionBootstrap }
  | { ok: false; error: RoomBootstrapError };

export type RoomOwnerBootstrapResult =
  | { ok: true; bootstrap: RoomOwnerBootstrap }
  | { ok: false; error: RoomBootstrapError };

export type RoomAccessOperationResult =
  | { ok: true; receipt: RoomJoinRequestReceipt }
  | { ok: false; error: RoomAccessError | RateLimitError };

export type RoomBootstrapService = {
  createRoom(input: {
    visitorToken: string;
    clientIp: string;
    iceMode: RoomIceMode;
  }): RoomOwnerBootstrapResult;
  joinRoom(input: {
    code: string;
    visitorToken: string;
    clientIp: string;
    iceMode: RoomIceMode;
    admission: ReceiverJoinBody["admission"];
  }): RoomBootstrapResult;
  createJoinRequest(input: {
    code: string;
    visitorToken: string;
    clientIp: string;
  }): RoomAccessOperationResult;
  readJoinRequest(input: {
    code: string;
    requestId: string;
    visitorToken: string;
    clientIp: string;
  }): RoomAccessOperationResult;
  decideJoinRequest(input: {
    code: string;
    requestId: string;
    visitorToken: string;
    clientIp: string;
    decision: "approve" | "reject";
  }): RoomAccessOperationResult;
  finalizeJoinRequest(input: {
    code: string;
    requestId: string;
    visitorToken: string;
    clientIp: string;
    iceMode: RoomIceMode;
  }): RoomBootstrapResult;
  cancelJoinRequest(input: {
    code: string;
    requestId: string;
    visitorToken: string;
    clientIp: string;
  }): RoomAccessOperationResult;
};

export type RoomBootstrapServiceOptions = {
  maintenance: Pick<MaintenanceService, "sweepForAdmission">;
  visitors: Pick<VisitorService, "touch">;
  rooms: Pick<
    RoomService,
    | "prepareCreate"
    | "prepareInviteJoin"
    | "prepareReceiverRecovery"
    | "prepareApprovedReceiverJoin"
    | "commit"
  >;
  roomAccess: Pick<
    RoomAccessService,
    | "inspectCreateOrGetPending"
    | "createOrGetPending"
    | "readReceipt"
    | "decide"
    | "cancel"
    | "prepareFinalize"
    | "commitFinalize"
  >;
  rateLimits: Pick<RateLimitService, "consumeMany">;
  turn: Pick<TurnService, "issue">;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const visitorNotFound = {
  code: "VISITOR_NOT_FOUND" as const,
  message: "访客不存在或已过期",
};

const createChecks = (
  clientIp: string,
  visitorId: string,
): RateLimitCheck[] => [
  { key: `room:create:ip:${clientIp}`, limit: 30, windowMs: HOUR_MS },
  { key: `room:create:visitor:${visitorId}`, limit: 10, windowMs: HOUR_MS },
];

const joinIpChecks = (clientIp: string): RateLimitCheck[] => [
  { key: `room:join:ip:${clientIp}`, limit: 60, windowMs: MINUTE_MS },
];

const joinVisitorChecks = (visitorId: string): RateLimitCheck[] => [
  { key: `room:join:visitor:${visitorId}`, limit: 20, windowMs: MINUTE_MS },
];

const requestEntranceChecks = (clientIp: string): RateLimitCheck[] => [
  { key: "room:join-request:instance", limit: 300, windowMs: MINUTE_MS },
  { key: `room:join-request:ip:${clientIp}`, limit: 10, windowMs: MINUTE_MS },
];

const requestVisitorChecks = (visitorId: string): RateLimitCheck[] => [
  { key: `room:join-request:visitor:${visitorId}`, limit: 3, windowMs: MINUTE_MS },
];

const requestRoomChecks = (roomCode: string): RateLimitCheck[] => [
  { key: `room:join-request:room:${roomCode}`, limit: 10, windowMs: MINUTE_MS },
];

const requestStatusIpChecks = (clientIp: string): RateLimitCheck[] => [
  { key: `room:join-request-status:ip:${clientIp}`, limit: 240, windowMs: MINUTE_MS },
];

const requestStatusVisitorChecks = (visitorId: string): RateLimitCheck[] => [
  { key: `room:join-request-status:visitor:${visitorId}`, limit: 60, windowMs: MINUTE_MS },
];

const requestDecisionIpChecks = (clientIp: string): RateLimitCheck[] => [
  { key: `room:join-request-decision:ip:${clientIp}`, limit: 60, windowMs: MINUTE_MS },
];

const requestDecisionSenderChecks = (senderId: string): RateLimitCheck[] => [
  { key: `room:join-request-decision:sender:${senderId}`, limit: 30, windowMs: MINUTE_MS },
];

const requestCancelIpChecks = (clientIp: string): RateLimitCheck[] => [
  { key: `room:join-request-cancel:ip:${clientIp}`, limit: 60, windowMs: MINUTE_MS },
];

const requestCancelVisitorChecks = (visitorId: string): RateLimitCheck[] => [
  { key: `room:join-request-cancel:visitor:${visitorId}`, limit: 20, windowMs: MINUTE_MS },
];

const credentialChecks = (
  clientIp: string,
  visitorId: string,
  roomCode: string,
): RateLimitCheck[] => [
  { key: "turn:credential:instance", limit: 300, windowMs: MINUTE_MS },
  { key: `turn:credential:ip:${clientIp}`, limit: 20, windowMs: MINUTE_MS },
  { key: `turn:credential:visitor:${visitorId}`, limit: 5, windowMs: MINUTE_MS },
  { key: `turn:credential:room:${roomCode}`, limit: 30, windowMs: MINUTE_MS },
];

type AuthenticatedVisitorResult =
  | { ok: true; visitor: Visitor }
  | { ok: false; error: RoomBootstrapError };

type OptionalCredentialResult =
  | { ok: true; credential?: TurnCredential }
  | { ok: false; error: RateLimitError | TurnError };

const toBootstrap = (
  room: RoomSessionBootstrap["room"],
  credential?: TurnCredential,
): RoomSessionBootstrap => ({
  room,
  ...credential,
});

export const createRoomBootstrapService = ({
  maintenance,
  visitors,
  rooms,
  roomAccess,
  rateLimits,
  turn,
}: RoomBootstrapServiceOptions): RoomBootstrapService => {
  const consume = (checks: RateLimitCheck[]) => rateLimits.consumeMany(checks);

  const authenticateReceiver = (
    visitorToken: string,
    clientIp: string,
  ): AuthenticatedVisitorResult => {
    const ipLimited = consume(joinIpChecks(clientIp));
    if (!ipLimited.ok) return ipLimited;
    const visitor = visitors.touch(visitorToken);
    if (!visitor) return { ok: false, error: visitorNotFound };
    const visitorLimited = consume(joinVisitorChecks(visitor.id));
    if (!visitorLimited.ok) return visitorLimited;
    return { ok: true, visitor };
  };

  const issueCredential = (
    iceMode: RoomIceMode,
    clientIp: string,
    visitorId: string,
    roomPlan: RoomMutationPlan,
  ): OptionalCredentialResult => {
    if (iceMode === "off") return { ok: true };
    const limited = consume(credentialChecks(
      clientIp,
      visitorId,
      roomPlan.room.code,
    ));
    if (!limited.ok) return limited;
    const issued = turn.issue(visitorId, roomPlan.room.expiresAt);
    if (!issued.ok) return issued;
    return { ok: true, credential: issued.credential };
  };

  const createRoom = (
    input: Parameters<RoomBootstrapService["createRoom"]>[0],
  ): RoomOwnerBootstrapResult => {
    maintenance.sweepForAdmission();
    const visitor = visitors.touch(input.visitorToken);
    if (!visitor) return { ok: false, error: visitorNotFound };
    const limited = consume(createChecks(input.clientIp, visitor.id));
    if (!limited.ok) return limited;
    const prepared = rooms.prepareCreate(input.visitorToken);
    if (!prepared.ok) return prepared;
    const credential = issueCredential(
      input.iceMode,
      input.clientIp,
      visitor.id,
      prepared.plan,
    );
    if (!credential.ok) return credential;
    const committed = rooms.commit(prepared.plan);
    if (!committed.ok) return committed;
    return {
      ok: true,
      bootstrap: {
        ...toBootstrap(committed.room, credential.credential),
        invite: prepared.invite,
      },
    };
  };

  const joinRoom = (
    input: Parameters<RoomBootstrapService["joinRoom"]>[0],
  ): RoomBootstrapResult => {
    maintenance.sweepForAdmission();
    const authenticated = authenticateReceiver(input.visitorToken, input.clientIp);
    if (!authenticated.ok) return authenticated;
    const prepared = input.admission.kind === "invite"
      ? rooms.prepareInviteJoin(
          input.code,
          input.visitorToken,
          input.admission.inviteToken,
        )
      : rooms.prepareReceiverRecovery(input.code, input.visitorToken);
    if (!prepared.ok) return prepared;
    const credential = issueCredential(
      input.iceMode,
      input.clientIp,
      authenticated.visitor.id,
      prepared.plan,
    );
    if (!credential.ok) return credential;
    const committed = rooms.commit(prepared.plan);
    if (!committed.ok) return committed;
    return {
      ok: true,
      bootstrap: toBootstrap(committed.room, credential.credential),
    };
  };

  const createJoinRequest = (
    input: Parameters<RoomBootstrapService["createJoinRequest"]>[0],
  ): RoomAccessOperationResult => {
    maintenance.sweepForAdmission();
    const entranceLimited = consume(requestEntranceChecks(input.clientIp));
    if (!entranceLimited.ok) return entranceLimited;
    const visitor = visitors.touch(input.visitorToken);
    if (!visitor) return { ok: false, error: visitorNotFound };
    const visitorLimited = consume(requestVisitorChecks(visitor.id));
    if (!visitorLimited.ok) return visitorLimited;

    const inspection = roomAccess.inspectCreateOrGetPending(
      input.code,
      input.visitorToken,
    );
    if (!inspection.ok) return inspection;
    const roomLimited = consume(requestRoomChecks(input.code));
    if (!roomLimited.ok) return roomLimited;
    if (inspection.mode === "existing") {
      return { ok: true, receipt: inspection.receipt };
    }
    return roomAccess.createOrGetPending(input.code, input.visitorToken);
  };

  const readJoinRequest = (
    input: Parameters<RoomBootstrapService["readJoinRequest"]>[0],
  ): RoomAccessOperationResult => {
    maintenance.sweepForAdmission();
    const ipLimited = consume(requestStatusIpChecks(input.clientIp));
    if (!ipLimited.ok) return ipLimited;
    const visitor = visitors.touch(input.visitorToken);
    if (!visitor) return { ok: false, error: visitorNotFound };
    const visitorLimited = consume(requestStatusVisitorChecks(visitor.id));
    if (!visitorLimited.ok) return visitorLimited;
    return roomAccess.readReceipt(input.code, input.requestId, input.visitorToken);
  };

  const decideJoinRequest = (
    input: Parameters<RoomBootstrapService["decideJoinRequest"]>[0],
  ): RoomAccessOperationResult => {
    maintenance.sweepForAdmission();
    const ipLimited = consume(requestDecisionIpChecks(input.clientIp));
    if (!ipLimited.ok) return ipLimited;
    const sender = visitors.touch(input.visitorToken);
    if (!sender) return { ok: false, error: visitorNotFound };
    const senderLimited = consume(requestDecisionSenderChecks(sender.id));
    if (!senderLimited.ok) return senderLimited;
    return roomAccess.decide(
      input.code,
      input.requestId,
      input.visitorToken,
      input.decision,
    );
  };

  const finalizeJoinRequest = (
    input: Parameters<RoomBootstrapService["finalizeJoinRequest"]>[0],
  ): RoomBootstrapResult => {
    maintenance.sweepForAdmission();
    const authenticated = authenticateReceiver(input.visitorToken, input.clientIp);
    if (!authenticated.ok) return authenticated;
    const accessPrepared = roomAccess.prepareFinalize(
      input.code,
      input.requestId,
      input.visitorToken,
    );
    if (!accessPrepared.ok) return accessPrepared;
    const roomPrepared = accessPrepared.mode === "commit"
      ? rooms.prepareApprovedReceiverJoin(input.code, input.visitorToken)
      : rooms.prepareReceiverRecovery(input.code, input.visitorToken);
    if (!roomPrepared.ok) return roomPrepared;
    const credential = issueCredential(
      input.iceMode,
      input.clientIp,
      authenticated.visitor.id,
      roomPrepared.plan,
    );
    if (!credential.ok) return credential;

    if (accessPrepared.mode === "recovery") {
      const committed = rooms.commit(roomPrepared.plan);
      if (!committed.ok) return committed;
      return {
        ok: true,
        bootstrap: toBootstrap(committed.room, credential.credential),
      };
    }

    const finalized = roomAccess.commitFinalize(
      accessPrepared.plan,
      () => rooms.commit(roomPrepared.plan),
    );
    if (!finalized.ok) return finalized;
    return {
      ok: true,
      bootstrap: toBootstrap(finalized.room, credential.credential),
    };
  };

  const cancelJoinRequest = (
    input: Parameters<RoomBootstrapService["cancelJoinRequest"]>[0],
  ): RoomAccessOperationResult => {
    maintenance.sweepForAdmission();
    const ipLimited = consume(requestCancelIpChecks(input.clientIp));
    if (!ipLimited.ok) return ipLimited;
    const visitor = visitors.touch(input.visitorToken);
    if (!visitor) return { ok: false, error: visitorNotFound };
    const visitorLimited = consume(requestCancelVisitorChecks(visitor.id));
    if (!visitorLimited.ok) return visitorLimited;
    return roomAccess.cancel(input.code, input.requestId, input.visitorToken);
  };

  return {
    createRoom,
    joinRoom,
    createJoinRequest,
    readJoinRequest,
    decideJoinRequest,
    finalizeJoinRequest,
    cancelJoinRequest,
  };
};
