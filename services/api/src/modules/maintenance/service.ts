import type { RateLimitService } from "../rate-limit/service";
import type { RoomService } from "../room/service";
import type { VisitorService } from "../visitor/service";
import type { MaintenanceEvent, MaintenanceService } from "./model";

export type MaintenanceServiceOptions = {
  rooms: Pick<RoomService, "cleanupExpiredState" | "removeVisitor">;
  visitors: Pick<VisitorService, "listExpiredVisitorIds" | "remove">;
  rateLimits: Pick<RateLimitService, "sweep">;
};

export const createMaintenanceService = ({
  rooms,
  visitors,
  rateLimits,
}: MaintenanceServiceOptions): MaintenanceService => {
  const sweepVisitorsAndRateKeys = (): MaintenanceEvent[] => {
    const visitorIds = Array.from(new Set(visitors.listExpiredVisitorIds())).sort();
    const transitions = visitorIds.flatMap(visitorId => rooms.removeVisitor(visitorId));
    for (const visitorId of visitorIds) visitors.remove(visitorId);
    rateLimits.sweep();
    return [
      ...transitions,
      ...visitorIds.map(visitorId => ({
        type: "visitor:expired" as const,
        visitorId,
      })),
    ];
  };

  return {
    sweepForAdmission() {
      return [
        ...rooms.cleanupExpiredState(),
        ...sweepVisitorsAndRateKeys(),
      ];
    },
    sweepRooms() {
      return rooms.cleanupExpiredState();
    },
    sweepVisitorsAndRateKeys,
  };
};
