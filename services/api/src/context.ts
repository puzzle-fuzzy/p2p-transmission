import { loadApiConfig, type ApiConfig } from "./config";
import {
  createMaintenanceService,
} from "./modules/maintenance/service";
import type { MaintenanceService } from "./modules/maintenance/model";
import {
  createRateLimitService,
  type RateLimitService,
} from "./modules/rate-limit/service";
import {
  createRoomAccessService,
  type RoomAccessService,
} from "./modules/room-access/service";
import {
  createRoomBootstrapService,
  type RoomBootstrapService,
} from "./modules/room/bootstrap";
import { createRoomService, type RoomService } from "./modules/room/service";
import { createTurnService, type TurnService } from "./modules/turn/service";
import { createVisitorService, type VisitorService } from "./modules/visitor/service";
import {
  createClientIpResolver,
  type ClientIpResolver,
} from "./shared/client-ip";
import { createNodeRoomInviteCrypto } from "./shared/room-invite-crypto";
import {
  createRealtimeTicketService,
  type RealtimeTicketService,
} from "./modules/realtime/ticket-service";
import type { StateStore } from "./storage/model";
import { loadSqliteState, createSqliteStateStore } from "./storage/sqlite";

export type AppContext = {
  config: ApiConfig;
  visitors: VisitorService;
  rooms: RoomService;
  roomAccess: RoomAccessService;
  rateLimits: RateLimitService;
  turn: TurnService;
  maintenance: MaintenanceService;
  roomBootstrap: RoomBootstrapService;
  clientIp: ClientIpResolver;
  stateStore?: StateStore;
  realtimeTickets?: RealtimeTicketService;
};

export const createDefaultContext = (
  config: ApiConfig = loadApiConfig(),
): AppContext => {
  const databasePath = config.databasePath ?? ":memory:";
  const initialState = loadSqliteState(databasePath);
  const visitors = createVisitorService({ initialVisitors: initialState.visitors });
  const inviteCrypto = createNodeRoomInviteCrypto();
  const rooms = createRoomService({
    visitors,
    inviteCrypto,
    initialRooms: initialState.rooms,
  });
  const roomAccess = createRoomAccessService({
    rooms,
    visitors,
    initialRequests: initialState.joinRequests,
  });
  const rateLimits = createRateLimitService();
  const turn = createTurnService(config);
  const maintenance = createMaintenanceService({
    rooms,
    roomAccess,
    visitors,
    rateLimits,
  });
  const roomBootstrap = createRoomBootstrapService({
    maintenance,
    visitors,
    rooms,
    roomAccess,
    rateLimits,
    turn,
  });
  const clientIp = createClientIpResolver({
    trustProxy: config.trustProxy,
    trustedProxyIps: config.trustedProxyIps,
  });
  const stateStore = createSqliteStateStore(databasePath, {
    visitors,
    rooms,
    roomAccess,
  });
  const realtimeTickets = createRealtimeTicketService(visitors, {
    ttlMs: config.realtimeTicketTtlMs,
    maxPerVisitor: config.realtimeTicketMaxPerVisitor,
  });

  return {
    config,
    visitors,
    rooms,
    roomAccess,
    rateLimits,
    turn,
    maintenance,
    roomBootstrap,
    clientIp,
    stateStore,
    realtimeTickets,
  };
};
