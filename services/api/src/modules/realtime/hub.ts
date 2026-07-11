import type { ApiConfig } from "../../config";
import type { AppContext } from "../../context";
import type { MaintenanceEvent, MaintenanceService } from "../maintenance/model";
import type { RoomTransition } from "../room/model";
import type {
  ClientRealtimeMessage,
  RealtimeConnectionResult,
  ServerRealtimeMessage,
  SignalClientMessage,
} from "./model";

const DEFAULT_MAX_SOCKETS = 10_000;

export type RealtimeSocket = {
  id: string;
  origin: string | null;
  send(message: ServerRealtimeMessage): void;
  close(): void;
};

type RealtimeContext = {
  config: Pick<ApiConfig, "corsAllowedOrigins">;
  visitors: AppContext["visitors"];
  rooms: AppContext["rooms"];
  maintenance: Pick<MaintenanceService, "sweepForAdmission" | "subscribe">;
};

type Connection = {
  socket: RealtimeSocket;
  visitorId: string;
  visitorToken: string;
  rooms: Set<string>;
};

type RealtimeError = {
  code: string;
  message: string;
};

type SignalAuthorization =
  | { ok: true; target: Connection }
  | { ok: false; error: RealtimeError };

export type RealtimeHubOptions = {
  maxSockets?: number;
};

export type RealtimeHub = {
  connect(socket: RealtimeSocket, token: string): RealtimeConnectionResult;
  handleMessage(socketId: string, message: ClientRealtimeMessage): void;
  disconnect(socketId: string): void;
};

const visitorNotFound = {
  code: "VISITOR_NOT_FOUND" as const,
  message: "访客不存在或已过期",
};

const capacityExceeded = {
  code: "CAPACITY_EXCEEDED" as const,
  message: "实时连接容量已满",
};

const originNotAllowed = {
  code: "ORIGIN_NOT_ALLOWED" as const,
  message: "实时连接来源不受信任",
};

const signalNotAllowed = {
  code: "SIGNAL_NOT_ALLOWED",
  message: "当前连接无权发送该信令",
};

const signalTargetNotInRoom = {
  code: "SIGNAL_TARGET_NOT_IN_ROOM",
  message: "信令目标不在当前房间",
};

const safeSend = (socket: RealtimeSocket, message: ServerRealtimeMessage) => {
  try {
    socket.send(message);
    return true;
  } catch {
    return false;
  }
};

const safeClose = (socket: RealtimeSocket) => {
  try {
    socket.close();
  } catch {
    // A broken socket must not interrupt cleanup for the remaining peers.
  }
};

const sendError = (socket: RealtimeSocket, error: RealtimeError) => {
  safeSend(socket, {
    type: "error",
    code: error.code,
    message: error.message,
  });
};

const assertPositiveSafeInteger = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
};

export const createRealtimeHub = (
  context: RealtimeContext,
  options: RealtimeHubOptions = {},
): RealtimeHub => {
  const maxSockets = options.maxSockets ?? DEFAULT_MAX_SOCKETS;
  assertPositiveSafeInteger(maxSockets, "Realtime socket capacity");
  const allowedOrigins = new Set(context.config.corsAllowedOrigins);
  const connectionsBySocket = new Map<string, Connection>();
  const socketIdsByVisitor = new Map<string, string>();

  const currentConnection = (visitorId: string) => {
    const socketId = socketIdsByVisitor.get(visitorId);
    return socketId ? connectionsBySocket.get(socketId) : undefined;
  };

  const sendToAttachedVisitor = (
    visitorId: string,
    roomCode: string,
    message: ServerRealtimeMessage,
  ) => {
    const connection = currentConnection(visitorId);
    if (!connection?.rooms.has(roomCode)) return false;
    return safeSend(connection.socket, message);
  };

  const transitionRoomCode = (transition: RoomTransition) =>
    transition.type === "room:participants"
      ? transition.room.code
      : transition.roomCode;

  const publishTransitions = (transitions: readonly RoomTransition[]) => {
    if (transitions.length === 0) return;

    // Snapshot every room before applying participant:left cleanup. A closed room no
    // longer exists in RoomService, and a multi-left batch must reach all old peers.
    const recipientsByRoom = new Map<string, Connection[]>();
    for (const transition of transitions) {
      const roomCode = transitionRoomCode(transition);
      if (recipientsByRoom.has(roomCode)) continue;
      recipientsByRoom.set(roomCode, Array.from(connectionsBySocket.values())
        .filter(connection => connection.rooms.has(roomCode)));
    }

    for (const transition of transitions) {
      const roomCode = transitionRoomCode(transition);
      const recipients = recipientsByRoom.get(roomCode) ?? [];
      if (transition.type === "room:participants") {
        const participantIds = new Set(
          transition.room.participants.map(participant => participant.visitor.id),
        );
        for (const connection of recipients) {
          if (!participantIds.has(connection.visitorId)) continue;
          safeSend(connection.socket, transition);
        }
        continue;
      }

      for (const connection of recipients) {
        if (connection.visitorId === transition.visitorId) continue;
        safeSend(connection.socket, transition);
      }
    }

    for (const transition of transitions) {
      if (transition.type !== "participant:left") continue;
      currentConnection(transition.visitorId)?.rooms.delete(transition.roomCode);
    }
  };

  const closeExpiredVisitor = (visitorId: string) => {
    const socketId = socketIdsByVisitor.get(visitorId);
    if (!socketId) return;
    const connection = connectionsBySocket.get(socketId);
    socketIdsByVisitor.delete(visitorId);
    connectionsBySocket.delete(socketId);
    if (connection) safeClose(connection.socket);
  };

  const consumeMaintenanceEvents = (events: readonly MaintenanceEvent[]) => {
    publishTransitions(events.filter(
      (event): event is RoomTransition => event.type !== "visitor:expired",
    ));
    for (const event of events) {
      if (event.type === "visitor:expired") closeExpiredVisitor(event.visitorId);
    }
  };

  const touch = (connection: Connection) => {
    context.visitors.touch(connection.visitorToken);
  };

  const authorizeSignal = (
    connection: Connection,
    message: SignalClientMessage,
  ): SignalAuthorization => {
    const roomResult = context.rooms.getRoom(message.roomCode);
    if (!roomResult.ok) return roomResult;
    if (!connection.rooms.has(message.roomCode)) {
      return { ok: false, error: signalNotAllowed };
    }

    const source = roomResult.room.participants.find(
      participant => participant.visitor.id === connection.visitorId,
    );
    if (!source || source.status !== "online") {
      return { ok: false, error: signalNotAllowed };
    }

    const target = roomResult.room.participants.find(
      participant => participant.visitor.id === message.to,
    );
    if (!target || target.status !== "online") {
      return { ok: false, error: signalTargetNotInRoom };
    }
    if (target.visitor.id === source.visitor.id) {
      return { ok: false, error: signalNotAllowed };
    }
    const targetConnection = currentConnection(target.visitor.id);
    if (!targetConnection?.rooms.has(message.roomCode)) {
      return { ok: false, error: signalTargetNotInRoom };
    }

    const sourceIsSender = source.role === "sender"
      && source.visitor.id === roomResult.room.senderId;
    const targetIsSender = target.role === "sender"
      && target.visitor.id === roomResult.room.senderId;
    const sourceIsReceiver = source.role === "receiver";
    const targetIsReceiver = target.role === "receiver";
    const isAllowed = message.type === "signal:offer"
      ? sourceIsSender && targetIsReceiver
      : message.type === "signal:answer"
        ? sourceIsReceiver && targetIsSender
        : (sourceIsSender && targetIsReceiver)
          || (sourceIsReceiver && targetIsSender);

    return isAllowed
      ? { ok: true, target: targetConnection }
      : { ok: false, error: signalNotAllowed };
  };

  const forwardSignal = (connection: Connection, message: SignalClientMessage) => {
    const authorization = authorizeSignal(connection, message);
    if (!authorization.ok) {
      sendError(connection.socket, authorization.error);
      return;
    }

    touch(connection);
    if (message.type === "signal:offer") {
      safeSend(authorization.target.socket, {
        type: "signal:offer",
        roomCode: message.roomCode,
        from: connection.visitorId,
        peerSessionId: message.peerSessionId,
        description: message.description,
      });
      return;
    }
    if (message.type === "signal:answer") {
      safeSend(authorization.target.socket, {
        type: "signal:answer",
        roomCode: message.roomCode,
        from: connection.visitorId,
        peerSessionId: message.peerSessionId,
        description: message.description,
      });
      return;
    }
    safeSend(authorization.target.socket, {
      type: "signal:ice",
      roomCode: message.roomCode,
      from: connection.visitorId,
      peerSessionId: message.peerSessionId,
      candidate: message.candidate,
    });
  };

  const attach = (
    connection: Connection,
    message: Extract<ClientRealtimeMessage, { type: "room:attach" }>,
  ) => {
    const result = context.rooms.attach(
      message.roomCode,
      connection.visitorId,
      message.role,
    );
    if (!result.ok) {
      connection.rooms.delete(message.roomCode);
      publishTransitions(result.transitions);
      sendError(connection.socket, result.error);
      return;
    }

    connection.rooms.add(message.roomCode);
    touch(connection);
    if (result.transitions.length > 0) {
      publishTransitions(result.transitions);
    } else {
      sendToAttachedVisitor(connection.visitorId, message.roomCode, {
        type: "room:participants",
        room: result.room,
      });
    }
  };

  context.maintenance.subscribe(events => consumeMaintenanceEvents(events));

  return {
    connect(socket, token) {
      // Admission cleanup owns stale room, visitor, and socket reclamation and
      // therefore runs before authentication, capacity, origin, or touch effects.
      context.maintenance.sweepForAdmission();
      const visitor = context.visitors.getByToken(token);
      if (!visitor) {
        sendError(socket, visitorNotFound);
        safeClose(socket);
        return { ok: false, error: visitorNotFound };
      }

      const previousSocketId = socketIdsByVisitor.get(visitor.id);
      const previousConnection = previousSocketId
        ? connectionsBySocket.get(previousSocketId)
        : undefined;
      const occupiedByAnother = connectionsBySocket.get(socket.id);
      const replacesLiveSocket = previousConnection !== undefined;
      const projectedSize = connectionsBySocket.size + 1 - (replacesLiveSocket ? 1 : 0);
      if (
        projectedSize > maxSockets
        || (occupiedByAnother !== undefined && occupiedByAnother !== previousConnection)
      ) {
        sendError(socket, capacityExceeded);
        safeClose(socket);
        return { ok: false, error: capacityExceeded };
      }

      if (!socket.origin || !allowedOrigins.has(socket.origin)) {
        sendError(socket, originNotAllowed);
        safeClose(socket);
        return { ok: false, error: originNotAllowed };
      }

      const touchedVisitor = context.visitors.touch(token);
      if (!touchedVisitor) {
        sendError(socket, visitorNotFound);
        safeClose(socket);
        return { ok: false, error: visitorNotFound };
      }

      if (previousConnection) {
        const previousRooms = Array.from(previousConnection.rooms);
        publishTransitions(context.rooms.markConnecting(visitor.id, previousRooms));
      }

      const connection: Connection = {
        socket,
        visitorId: visitor.id,
        visitorToken: token,
        rooms: new Set(),
      };
      if (previousSocketId) connectionsBySocket.delete(previousSocketId);
      connectionsBySocket.set(socket.id, connection);
      socketIdsByVisitor.set(visitor.id, socket.id);
      if (previousConnection && previousConnection.socket !== socket) {
        safeClose(previousConnection.socket);
      }

      const publicVisitor = context.visitors.toPublic(touchedVisitor);
      safeSend(socket, { type: "visitor:ready", visitor: publicVisitor });
      return { ok: true, visitor: publicVisitor };
    },
    handleMessage(socketId, message) {
      const connection = connectionsBySocket.get(socketId);
      if (!connection || socketIdsByVisitor.get(connection.visitorId) !== socketId) return;

      if (message.type === "room:attach") {
        attach(connection, message);
        return;
      }

      if (message.type === "room:leave") {
        const result = context.rooms.leave(message.roomCode, connection.visitorId);
        connection.rooms.delete(message.roomCode);
        publishTransitions(result.transitions);
        if (!result.ok) {
          sendError(connection.socket, result.error);
          return;
        }
        touch(connection);
        return;
      }

      forwardSignal(connection, message);
    },
    disconnect(socketId) {
      const connection = connectionsBySocket.get(socketId);
      if (!connection) return;
      connectionsBySocket.delete(socketId);
      if (socketIdsByVisitor.get(connection.visitorId) !== socketId) return;

      socketIdsByVisitor.delete(connection.visitorId);
      publishTransitions(context.rooms.markConnecting(
        connection.visitorId,
        Array.from(connection.rooms),
      ));
    },
  };
};
