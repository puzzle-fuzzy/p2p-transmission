import type {
  ParticipantRole,
  RoomIceMode,
  RoomSessionBootstrap,
} from "@p2p/contracts";
import type { MaintenanceService } from "../maintenance/model";
import type { RateLimitCheck, RateLimitError } from "../rate-limit/model";
import type { RateLimitService } from "../rate-limit/service";
import type { TurnError } from "../turn/model";
import type { TurnService } from "../turn/service";
import type { VisitorService } from "../visitor/service";
import type { RoomError, RoomMutationPlanResult } from "./model";
import type { RoomService } from "./service";

export type RoomBootstrapError = RoomError | RateLimitError | TurnError;

export type RoomBootstrapResult =
  | { ok: true; bootstrap: RoomSessionBootstrap }
  | { ok: false; error: RoomBootstrapError };

export type RoomBootstrapService = {
  createRoom(input: {
    visitorToken: string;
    clientIp: string;
    iceMode: RoomIceMode;
  }): RoomBootstrapResult;
  joinRoom(input: {
    code: string;
    visitorToken: string;
    clientIp: string;
    role: ParticipantRole;
    iceMode: RoomIceMode;
  }): RoomBootstrapResult;
};

export type RoomBootstrapServiceOptions = {
  maintenance: Pick<MaintenanceService, "sweepForAdmission">;
  visitors: Pick<VisitorService, "touch">;
  rooms: Pick<RoomService, "prepareCreate" | "prepareJoin" | "commit">;
  rateLimits: Pick<RateLimitService, "consumeMany">;
  turn: Pick<TurnService, "issue">;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const visitorNotFound = {
  code: "VISITOR_NOT_FOUND" as const,
  message: "访客不存在或已过期",
};

const baseChecks = (
  operation: "create" | "join",
  clientIp: string,
  visitorId: string,
): RateLimitCheck[] => operation === "create"
  ? [
      { key: `room:create:ip:${clientIp}`, limit: 30, windowMs: HOUR_MS },
      { key: `room:create:visitor:${visitorId}`, limit: 10, windowMs: HOUR_MS },
    ]
  : [
      { key: `room:join:ip:${clientIp}`, limit: 60, windowMs: MINUTE_MS },
      { key: `room:join:visitor:${visitorId}`, limit: 20, windowMs: MINUTE_MS },
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

export const createRoomBootstrapService = ({
  maintenance,
  visitors,
  rooms,
  rateLimits,
  turn,
}: RoomBootstrapServiceOptions): RoomBootstrapService => {
  const run = (
    operation: "create" | "join",
    input: {
      visitorToken: string;
      clientIp: string;
      iceMode: RoomIceMode;
    },
    prepare: () => RoomMutationPlanResult,
  ): RoomBootstrapResult => {
    maintenance.sweepForAdmission();
    const visitor = visitors.touch(input.visitorToken);
    if (!visitor) return { ok: false, error: visitorNotFound };
    const prepared = prepare();
    if (!prepared.ok) return prepared;

    const checks = [
      ...baseChecks(operation, input.clientIp, visitor.id),
      ...(input.iceMode === "api"
        ? credentialChecks(input.clientIp, visitor.id, prepared.plan.room.code)
        : []),
    ];
    const limited = rateLimits.consumeMany(checks);
    if (!limited.ok) return limited;

    const credential = input.iceMode === "api"
      ? turn.issue(visitor.id, prepared.plan.room.expiresAt)
      : undefined;
    if (credential && !credential.ok) return credential;

    const committed = rooms.commit(prepared.plan);
    if (!committed.ok) return committed;
    return {
      ok: true,
      bootstrap: {
        room: committed.room,
        ...(credential?.ok ? credential.credential : {}),
      },
    };
  };

  return {
    createRoom(input) {
      return run(
        "create",
        input,
        () => rooms.prepareCreate(input.visitorToken),
      );
    },
    joinRoom(input) {
      return run(
        "join",
        input,
        () => rooms.prepareJoin(input.code, input.visitorToken, input.role),
      );
    },
  };
};
