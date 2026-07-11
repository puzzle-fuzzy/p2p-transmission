import { createHmac } from "node:crypto";
import type { ApiConfig } from "../../config";
import type { TurnCredentialResult } from "./model";

export type TurnServiceOptions = {
  now?: () => number;
};

export type TurnService = {
  issue(visitorId: string, roomExpiresAt: number): TurnCredentialResult;
};

const turnNotConfigured = {
  code: "TURN_NOT_CONFIGURED" as const,
  message: "TURN 中继服务尚未配置",
};

const roomExpired = {
  code: "ROOM_EXPIRED" as const,
  message: "房间已过期",
};

export const createTurnService = (
  config: Pick<ApiConfig, "stunUrls" | "turn">,
  { now = Date.now }: TurnServiceOptions = {},
): TurnService => ({
  issue(visitorId, roomExpiresAt) {
    if (!config.turn) return { ok: false, error: turnNotConfigured };
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(visitorId)) {
      throw new RangeError("Visitor ID is invalid for TURN credentials");
    }
    if (!Number.isSafeInteger(roomExpiresAt) || roomExpiresAt <= 0) {
      throw new RangeError("Room expiry must use epoch milliseconds");
    }
    if (roomExpiresAt <= now()) return { ok: false, error: roomExpired };

    const credentialExpiresAt = roomExpiresAt + config.turn.credentialGraceMs;
    if (!Number.isSafeInteger(credentialExpiresAt)) {
      throw new RangeError("TURN credential expiry exceeds the safe integer range");
    }
    const username = `${String(Math.floor(credentialExpiresAt / 1_000))}:${visitorId}`;
    const credential = createHmac("sha1", config.turn.sharedSecret)
      .update(username)
      .digest("base64");
    const iceServers = [
      ...(config.stunUrls.length > 0 ? [{ urls: [...config.stunUrls] }] : []),
      {
        urls: [...config.turn.urls],
        username,
        credential,
        credentialType: "password" as const,
      },
    ];

    return {
      ok: true,
      credential: {
        rtcConfiguration: { iceServers },
        credentialExpiresAt,
      },
    };
  },
});
