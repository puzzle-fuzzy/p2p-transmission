import type { Room } from "../modules/room/model";
import type { RoomJoinRequestSnapshot } from "../modules/room-access/model";
import type { Visitor } from "../modules/visitor/model";

export type PersistedState = {
  visitors: Visitor[];
  rooms: Room[];
  joinRequests: RoomJoinRequestSnapshot[];
};

export type StateStore = {
  load(): PersistedState;
  save(): void;
  close(): void;
};
