import type {
  ParticipantRole,
  ParticipantStatus,
  PublicRoom,
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
};

export type Room = {
  code: string;
  senderId: string | null;
  receivers: Set<string>;
  participants: Map<string, Participant>;
  createdAt: number;
  expiresAt: number;
};

export type RoomErrorCode =
  | "VISITOR_NOT_FOUND"
  | "ROOM_NOT_FOUND"
  | "ROOM_SENDER_EXISTS";

export type RoomError = {
  code: RoomErrorCode;
  message: string;
};

export type RoomResult = { ok: true; room: PublicRoom } | { ok: false; error: RoomError };
