import type { ParticipantRole, PublicRoom } from "../room/model";
import type { PublicVisitor } from "../visitor/model";

export type SignalMessageType = "signal:offer" | "signal:answer" | "signal:ice";

export type ClientRealtimeMessage =
  | {
      type: "room:join";
      roomCode: string;
      role: ParticipantRole;
    }
  | {
      type: "room:leave";
      roomCode: string;
    }
  | {
      type: SignalMessageType;
      roomCode: string;
      to: string;
      sdp?: unknown;
      candidate?: unknown;
    }
  | {
      type: "transfer:prepare";
      roomCode: string;
      items: TransferItem[];
    }
  | {
      type: "transfer:state";
      roomCode: string;
      state: "ready" | "transferring" | "done" | "error";
    };

export type TransferItem = {
  id: string;
  kind: "text" | "file";
  name?: string;
  size?: number;
  mimeType?: string;
};

export type ServerRealtimeMessage =
  | {
      type: "visitor:ready";
      visitor: PublicVisitor;
    }
  | {
      type: "room:participants";
      room: PublicRoom;
    }
  | {
      type: "participant:left";
      roomCode: string;
      visitorId: string;
    }
  | {
      type: SignalMessageType;
      roomCode: string;
      from: string;
      sdp?: unknown;
      candidate?: unknown;
    }
  | {
      type: "transfer:prepare";
      roomCode: string;
      from: string;
      items: TransferItem[];
    }
  | {
      type: "transfer:state";
      roomCode: string;
      from: string;
      state: "ready" | "transferring" | "done" | "error";
    }
  | {
      type: "error";
      code: string;
      message: string;
    };

export type RealtimeConnectionResult =
  | { ok: true; visitor: PublicVisitor }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };
