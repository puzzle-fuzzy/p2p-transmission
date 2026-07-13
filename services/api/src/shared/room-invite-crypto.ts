import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "inv_";

export type RoomInviteCrypto = {
  createToken(): string;
  digest(token: string): Uint8Array;
  equals(left: Uint8Array, right: Uint8Array): boolean;
};

export const createNodeRoomInviteCrypto = (): RoomInviteCrypto => ({
  createToken: () => `${PREFIX}${randomBytes(32).toString("base64url")}`,
  digest: token => createHash("sha256").update(token, "utf8").digest(),
  equals: (left, right) => left.byteLength === right.byteLength
    && timingSafeEqual(left, right),
});
