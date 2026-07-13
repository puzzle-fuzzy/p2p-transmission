import type { RateLimitService } from "../rate-limit/service";
import type { RoomAccessService } from "../room-access/service";
import type { RoomService } from "../room/service";
import type { VisitorService } from "../visitor/service";
import type {
  MaintenanceEvent,
  MaintenanceListener,
  MaintenanceService,
} from "./model";

export type MaintenanceScheduler = {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
};

export type MaintenanceServiceOptions = {
  rooms: Pick<RoomService, "cleanupExpiredState" | "removeVisitor">;
  roomAccess: Pick<RoomAccessService, "cleanupExpiredState" | "removeVisitor">;
  visitors: Pick<VisitorService, "listExpiredVisitorIds" | "remove">;
  rateLimits: Pick<RateLimitService, "sweep">;
  scheduler?: MaintenanceScheduler;
};

const ROOM_SWEEP_INTERVAL_MS = 30_000;
const VISITOR_SWEEP_INTERVAL_MS = 60_000;

const defaultScheduler: MaintenanceScheduler = {
  setInterval(callback, intervalMs) {
    return globalThis.setInterval(callback, intervalMs);
  },
  clearInterval(handle) {
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
  },
};

export const createMaintenanceService = ({
  rooms,
  roomAccess,
  visitors,
  rateLimits,
  scheduler = defaultScheduler,
}: MaintenanceServiceOptions): MaintenanceService => {
  const listeners = new Set<MaintenanceListener>();
  let started = false;
  let roomTimer: unknown;
  let visitorTimer: unknown;

  const publish = (events: MaintenanceEvent[]) => {
    if (events.length === 0) return events;
    for (const listener of Array.from(listeners)) listener(events);
    return events;
  };

  const collectRooms = (): MaintenanceEvent[] => {
    const transitions = rooms.cleanupExpiredState();
    // RoomAccessService publishes its own targeted, non-secret transitions.
    roomAccess.cleanupExpiredState();
    return transitions;
  };

  const collectVisitorsAndRateKeys = (): MaintenanceEvent[] => {
    const visitorIds = Array.from(new Set(visitors.listExpiredVisitorIds())).sort();
    const transitions: MaintenanceEvent[] = [];
    for (const visitorId of visitorIds) {
      transitions.push(...rooms.removeVisitor(visitorId));
      // Access transitions are already published by RoomAccessService.
      roomAccess.removeVisitor(visitorId);
      visitors.remove(visitorId);
    }
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
      return publish([
        ...collectRooms(),
        ...collectVisitorsAndRateKeys(),
      ]);
    },
    sweepRooms() {
      return publish(collectRooms());
    },
    sweepVisitorsAndRateKeys() {
      return publish(collectVisitorsAndRateKeys());
    },
    subscribe(listener) {
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
    start() {
      if (started) return;
      started = true;
      try {
        roomTimer = scheduler.setInterval(() => {
          if (started) publish(collectRooms());
        }, ROOM_SWEEP_INTERVAL_MS);
        visitorTimer = scheduler.setInterval(() => {
          if (started) publish(collectVisitorsAndRateKeys());
        }, VISITOR_SWEEP_INTERVAL_MS);
      } catch (error) {
        started = false;
        if (roomTimer !== undefined) scheduler.clearInterval(roomTimer);
        roomTimer = undefined;
        visitorTimer = undefined;
        throw error;
      }
    },
    stop() {
      if (!started) return;
      started = false;
      if (roomTimer !== undefined) scheduler.clearInterval(roomTimer);
      if (visitorTimer !== undefined) scheduler.clearInterval(visitorTimer);
      roomTimer = undefined;
      visitorTimer = undefined;
    },
  };
};
