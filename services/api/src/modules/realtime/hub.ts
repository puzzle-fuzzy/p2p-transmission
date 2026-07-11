import type { AppContext } from "../../context";
import type { RoomError } from "../room/model";
import type {
  ClientRealtimeMessage,
  RealtimeConnectionResult,
  ServerRealtimeMessage,
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

export type RealtimeHub = {
  connect(socket: RealtimeSocket, token: string): RealtimeConnectionResult;
  handleMessage(socketId: string, message: ClientRealtimeMessage): void;
  disconnect(socketId: string): void;
};

const visitorNotFound = {
  code: "VISITOR_NOT_FOUND",
  message: "访客不存在或已过期",
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

  const forwardToRoom = (connection: Connection, message: Extract<ClientRealtimeMessage, { roomCode: string }>) => {
    const room = context.rooms.getRoom(message.roomCode);
    if (!room.ok) {
      sendError(connection.socket, room.error);
      return;
    }

    for (const participant of room.room.participants) {
      if (participant.visitor.id === connection.visitorId) continue;

      sendToVisitor(participant.visitor.id, {
        ...message,
        from: connection.visitorId,
      } as ServerRealtimeMessage);
    }
  };

  return {
    connect(socket, token) {
      const visitor = context.visitors.getByToken(token);

      if (!visitor) {
        sendError(socket, visitorNotFound);
        socket.close();

        return { ok: false, error: visitorNotFound };
      }

      const connection: Connection = {
        socket,
        visitorId: visitor.id,
        visitorToken: token,
        rooms: new Set(),
      };

      connectionsBySocket.set(socket.id, connection);
      socketIdsByVisitor.set(visitor.id, socket.id);
      socket.send({
        type: "visitor:ready",
        visitor: context.visitors.toPublic(visitor),
      });

      return { ok: true, visitor: context.visitors.toPublic(visitor) };
    },
    handleMessage(socketId, message) {
      const connection = connectionsBySocket.get(socketId);

      if (!connection) return;

      if (message.type === "room:join") {
        const result = context.rooms.joinRoom(message.roomCode, connection.visitorToken, message.role);
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

      if (message.type === "signal:offer" || message.type === "signal:answer" || message.type === "signal:ice") {
        sendToVisitor(message.to, {
          type: message.type,
          roomCode: message.roomCode,
          from: connection.visitorId,
          sdp: message.sdp,
          candidate: message.candidate,
        });
        return;
      }

      forwardToRoom(connection, message);
    },
    disconnect(socketId) {
      const connection = connectionsBySocket.get(socketId);

      if (!connection) return;

      connectionsBySocket.delete(socketId);
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

export const errorFromUnknown = (error: unknown): RoomError => {
  if (typeof error === "object" && error && "code" in error && "message" in error) {
    return error as RoomError;
  }

  return {
    code: "ROOM_NOT_FOUND",
    message: "房间不存在或已过期",
  };
};
