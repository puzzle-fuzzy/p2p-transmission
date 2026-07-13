import type {
  PublicRoom,
  RoomJoinRequestReceipt,
  RoomJoinRequestState,
  RoomJoinRequestSummary,
} from "@p2p/contracts";
import type { RoomError, RoomResult } from "../room/model";

export type RoomAccessTransition =
  | {
      type: "room:join-requested";
      senderId: string;
      request: RoomJoinRequestSummary;
    }
  | {
      type: "room:join-request-resolved";
      senderId: string;
      roomCode: string;
      requestId: string;
      state: Exclude<RoomJoinRequestState, "pending">;
    };

export type RoomAccessError = {
  code:
    | "VISITOR_NOT_FOUND"
    | "ROOM_REQUEST_UNAVAILABLE"
    | "ROOM_JOIN_REQUEST_NOT_FOUND"
    | "ROOM_JOIN_REQUEST_REJECTED"
    | "ROOM_JOIN_REQUEST_NOT_APPROVED"
    | "ROOM_JOIN_REQUEST_CANCELLED"
    | "ROOM_JOIN_REQUEST_EXPIRED"
    | "INVALID_STATE";
  message: string;
};

export type RoomJoinRequestResult =
  | { ok: true; receipt: RoomJoinRequestReceipt }
  | { ok: false; error: RoomAccessError };

export type RoomJoinRequestListResult =
  | { ok: true; requests: RoomJoinRequestSummary[] }
  | { ok: false; error: RoomAccessError };

export type RoomAccessFinalizePlan = {
  readonly requestId: string;
  readonly roomCode: string;
  readonly visitorId: string;
  readonly revision: number;
  readonly expiresAt: number;
};

export type FinalizePlanResult =
  | { ok: true; mode: "commit"; plan: RoomAccessFinalizePlan }
  | { ok: true; mode: "recovery"; receipt: RoomJoinRequestReceipt }
  | { ok: false; error: RoomAccessError };

export type RoomFinalizeCommitResult =
  | { ok: true; receipt: RoomJoinRequestReceipt; room: PublicRoom }
  | { ok: false; error: RoomAccessError | RoomError };

export type CommitMembership = () => RoomResult;
