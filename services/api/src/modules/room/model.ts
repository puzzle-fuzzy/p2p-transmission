import type {
  ParticipantRole,
  ParticipantStatus,
  PublicRoom,
  RoomInviteCapability,
} from "@p2p/contracts";

export type {
  ParticipantRole,
  ParticipantStatus,
  PublicParticipant,
  PublicRoom,
} from "@p2p/contracts";

export type Participant = {
  visitorId: string;
  role: ParticipantRole;
  joinedAt: number;
  status: ParticipantStatus;
  attachDeadlineAt?: number;
};

export type Room = {
  code: string;
  senderId: string | null;
  receivers: Set<string>;
  participants: Map<string, Participant>;
  createdAt: number;
  expiresAt: number;
  /** Membership topology revision; presence/status-only changes do not invalidate admission. */
  revision: number;
  inviteDigest: Uint8Array;
};

export type RoomErrorCode =
  | "VISITOR_NOT_FOUND"
  | "ROOM_NOT_FOUND"
  | "ROOM_SENDER_EXISTS"
  | "ROOM_MEMBERSHIP_REQUIRED"
  | "ROOM_EXPIRED"
  | "ROOM_ACCESS_DENIED"
  | "INVALID_STATE"
  | "CAPACITY_EXCEEDED";

export type RoomError = {
  code: RoomErrorCode;
  message: string;
};

export type RoomResult = { ok: true; room: PublicRoom } | { ok: false; error: RoomError };

export type RoomMutationPlan = {
  id: string;
  revision: number;
  kind: "create" | "join";
  visitorId: string;
  role: ParticipantRole;
  room: PublicRoom;
};

export type RoomMutationPlanResult =
  | { ok: true; plan: RoomMutationPlan }
  | { ok: false; error: RoomError };

export type RoomCreateMutationPlanResult =
  | {
      ok: true;
      plan: RoomMutationPlan;
      invite: RoomInviteCapability;
    }
  | { ok: false; error: RoomError };

export type RoomTransition =
  | { type: "room:participants"; room: PublicRoom }
  | { type: "participant:left"; roomCode: string; visitorId: string };

export type RoomTransitionResult =
  | {
      ok: true;
      room: PublicRoom;
      transitions: RoomTransition[];
    }
  | {
      ok: false;
      error: RoomError;
      transitions: RoomTransition[];
    };
