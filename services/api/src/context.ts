import { createRoomService, type RoomService } from "./modules/room/service";
import { createVisitorService, type VisitorService } from "./modules/visitor/service";

export type AppContext = {
  visitors: VisitorService;
  rooms: RoomService;
};

export const createDefaultContext = (): AppContext => {
  const visitors = createVisitorService();

  return {
    visitors,
    rooms: createRoomService({ visitors }),
  };
};
