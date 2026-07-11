import type { AppContext } from "../../context";
import type {
  ClientRealtimeMessage,
  RealtimeConnectionResult,
  ServerRealtimeMessage,
  SignalClientMessage,
} from "./model";

export type RealtimeSocket = {
  id: string;
  send(message: ServerRealtimeMessage): void;
  close(): void;
};

type Connection = {
  socket: RealtimeSocket;
  visitorId: string;
  visitorToken: string;
  rooms: Set<string>;
};

type RealtimeError = {
  code: "SIGNAL_NOT_ALLOWED" | "SIGNAL_TARGET_NOT_IN_ROOM";
  message: string;
};

type SignalAuthorization =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

export type RealtimeHub = {
  connect(socket: RealtimeSocket, token: string): RealtimeConnectionResult;
  handleMessage(socketId: string, message: ClientRealtimeMessage): void;
  disconnect(socketId: string): void;
};

const visitorNotFound = {
  code: "VISITOR_NOT_FOUND",
  message: "访客不存在或已过期",
};

const signalNotAllowed: RealtimeError = {
  code: "SIGNAL_NOT_ALLOWED",
  message: "当前连接无权发送该信令",
};

const signalTargetNotInRoom: RealtimeError = {
  code: "SIGNAL_TARGET_NOT_IN_ROOM",
  message: "信令目标不在当前房间",
};

const sendError = (socket: RealtimeSocket, error: { code: string; message: string }) => {
  socket.send({
    type: "error",
    code: error.code,
    message: error.message,
  });
};

export const createRealtimeHub = (context: AppContext): RealtimeHub => {
  const connectionsBySocket = new Map<string, Connection>();
  const socketIdsByVisitor = new Map<string, string>();

  const sendToVisitor = (visitorId: string, message: ServerRealtimeMessage) => {
    const socketId = socketIdsByVisitor.get(visitorId);
    if (!socketId) return;

    connectionsBySocket.get(socketId)?.socket.send(message);
  };

  const broadcastRoom = (roomCode: string, message: ServerRealtimeMessage) => {
    const result = context.rooms.getRoom(roomCode);
    if (!result.ok) return;

    for (const participant of result.room.participants) {
      sendToVisitor(participant.visitor.id, message);
    }
  };

  const broadcastParticipants = (roomCode: string) => {
    const result = context.rooms.getRoom(roomCode);
    if (!result.ok) return;

    broadcastRoom(roomCode, {
      type: "room:participants",
      room: result.room,
    });
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
    if (!source) return { ok: false, error: signalNotAllowed };

    const target = roomResult.room.participants.find(
      participant => participant.visitor.id === message.to,
    );
    if (!target) return { ok: false, error: signalTargetNotInRoom };
    if (target.visitor.id === source.visitor.id) {
      return { ok: false, error: signalNotAllowed };
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
      ? { ok: true }
      : { ok: false, error: signalNotAllowed };
  };

  const forwardSignal = (connection: Connection, message: SignalClientMessage) => {
    const authorization = authorizeSignal(connection, message);
    if (!authorization.ok) {
      sendError(connection.socket, authorization.error);
      return;
    }

    if (message.type === "signal:offer") {
      sendToVisitor(message.to, {
        type: "signal:offer",
        roomCode: message.roomCode,
        from: connection.visitorId,
        peerSessionId: message.peerSessionId,
        description: message.description,
      });
      return;
    }

    if (message.type === "signal:answer") {
      sendToVisitor(message.to, {
        type: "signal:answer",
        roomCode: message.roomCode,
        from: connection.visitorId,
        peerSessionId: message.peerSessionId,
        description: message.description,
      });
      return;
    }

    sendToVisitor(message.to, {
      type: "signal:ice",
      roomCode: message.roomCode,
      from: connection.visitorId,
      peerSessionId: message.peerSessionId,
      candidate: message.candidate,
    });
  };

  return {
    connect(socket, token) {
      const visitor = context.visitors.getByToken(token);

      if (!visitor) {
        sendError(socket, visitorNotFound);
        socket.close();

        return { ok: false, error: visitorNotFound };
      }

      const previousSocketId = socketIdsByVisitor.get(visitor.id);
      const previousConnection = previousSocketId
        ? connectionsBySocket.get(previousSocketId)
        : undefined;
      const connection: Connection = {
        socket,
        visitorId: visitor.id,
        visitorToken: token,
        rooms: new Set(previousConnection?.rooms),
      };

      connectionsBySocket.set(socket.id, connection);
      socketIdsByVisitor.set(visitor.id, socket.id);

      if (previousSocketId && previousConnection && previousSocketId !== socket.id) {
        connectionsBySocket.delete(previousSocketId);
        previousConnection.socket.close();
      }

      const publicVisitor = context.visitors.toPublic(visitor);
      socket.send({
        type: "visitor:ready",
        visitor: publicVisitor,
      });

      return { ok: true, visitor: publicVisitor };
    },
    handleMessage(socketId, message) {
      const connection = connectionsBySocket.get(socketId);

      if (!connection) return;

      if (message.type === "room:join") {
        const result = context.rooms.joinRoom(
          message.roomCode,
          connection.visitorToken,
          message.role,
        );
        if (!result.ok) {
          sendError(connection.socket, result.error);
          return;
        }

        connection.rooms.add(message.roomCode);
        broadcastParticipants(message.roomCode);
        return;
      }

      if (message.type === "room:leave") {
        const result = context.rooms.leaveRoom(message.roomCode, connection.visitorId);
        connection.rooms.delete(message.roomCode);
        if (!result.ok) {
          sendError(connection.socket, result.error);
          return;
        }

        broadcastRoom(message.roomCode, {
          type: "participant:left",
          roomCode: message.roomCode,
          visitorId: connection.visitorId,
        });
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

      for (const roomCode of connection.rooms) {
        context.rooms.leaveRoom(roomCode, connection.visitorId);
        broadcastRoom(roomCode, {
          type: "participant:left",
          roomCode,
          visitorId: connection.visitorId,
        });
      }
    },
  };
};
