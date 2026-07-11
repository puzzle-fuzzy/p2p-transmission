import type { PublicVisitor } from "../visitor/model";

export type ParticipantRole = "sender" | "receiver";

export type ParticipantStatus = "online" | "connecting" | "transferring" | "left";

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

export type PublicParticipant = {
  visitor: PublicVisitor;
  role: ParticipantRole;
  joinedAt: number;
  status: ParticipantStatus;
};

export type PublicRoom = {
  code: string;
  senderId: string | null;
  receivers: string[];
  participants: PublicParticipant[];
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
