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
};

export const createDefaultContext = (
  config: ApiConfig = loadApiConfig(),
): AppContext => {
  const visitors = createVisitorService();
  const inviteCrypto = createNodeRoomInviteCrypto();
  const rooms = createRoomService({ visitors, inviteCrypto });
  const roomAccess = createRoomAccessService({ rooms, visitors });
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
  };
};
