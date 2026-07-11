import type { RoomTransition } from "../room/model";

export type MaintenanceEvent =
  | RoomTransition
  | { type: "visitor:expired"; visitorId: string };

export type MaintenanceService = {
  sweepForAdmission(): MaintenanceEvent[];
  sweepRooms(): MaintenanceEvent[];
  sweepVisitorsAndRateKeys(): MaintenanceEvent[];
};
