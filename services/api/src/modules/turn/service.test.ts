import { describe, expect, test } from "bun:test";
import type { ApiConfig } from "../../config";
import { createTurnService } from "./service";

const config = (overrides: Partial<ApiConfig> = {}): ApiConfig => ({
  port: 3000,
  stunUrls: ["stun:stun.example.com:3478"],
  turn: {
    urls: [
      "turn:turn.example.com:3478?transport=udp",
      "turns:turn.example.com:5349?transport=tcp",
    ],
    sharedSecret: "0123456789abcdef0123456789abcdef",
    credentialGraceMs: 300_000,
  },
  corsAllowedOrigins: ["http://localhost:5713"],
  trustProxy: false,
  trustedProxyIps: new Set(),
  ...overrides,
});

describe("TURN credential service", () => {
  test("issues the fixed coturn HMAC-SHA1 vector", () => {
    const service = createTurnService(config({
      stunUrls: [],
      turn: {
        urls: ["turn:turn.example.com:3478"],
        sharedSecret: "0123456789abcdef0123456789abcdef",
        credentialGraceMs: 300_000,
      },
    }), { now: () => 1_600_000_000_000 });
    const result = service.issue("vis_001", 1_699_999_700_000);

    expect(result).toEqual({
      ok: true,
      credential: {
        rtcConfiguration: {
          iceServers: [{
            urls: ["turn:turn.example.com:3478"],
            username: "1700000000:vis_001",
            credential: "3Xg6+vw7s5E5jMWlxbdpSgQfbr0=",
            credentialType: "password",
          }],
        },
        credentialExpiresAt: 1_700_000_000_000,
      },
    });
  });

  test("uses room expiry plus five-minute grace in milliseconds", () => {
    const roomExpiresAt = 1_700_000_000_123;
    const result = createTurnService(config(), {
      now: () => roomExpiresAt - 1,
    }).issue("vis_001", roomExpiresAt);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected credential");
    expect(result.credential.credentialExpiresAt).toBe(roomExpiresAt + 300_000);
    expect(result.credential.rtcConfiguration.iceServers).toEqual([
      { urls: ["stun:stun.example.com:3478"] },
      {
        urls: [
          "turn:turn.example.com:3478?transport=udp",
          "turns:turn.example.com:5349?transport=tcp",
        ],
        username: "1700000300:vis_001",
        credential: expect.any(String),
        credentialType: "password",
      },
    ]);
  });

  test("does not serialize the shared secret", () => {
    const result = createTurnService(config(), { now: () => 1 })
      .issue("vis_001", 2_000);

    expect(JSON.stringify(result)).not.toContain("0123456789abcdef0123456789abcdef");
  });

  test("fails closed when TURN is off and for an expired room", () => {
    expect(createTurnService(config({ turn: undefined }), { now: () => 1 })
      .issue("vis_001", 2)).toEqual({
      ok: false,
      error: { code: "TURN_NOT_CONFIGURED", message: "TURN 中继服务尚未配置" },
    });
    expect(createTurnService(config(), { now: () => 2 })
      .issue("vis_001", 2)).toEqual({
      ok: false,
      error: { code: "ROOM_EXPIRED", message: "房间已过期" },
    });
  });

  test("rejects invalid visitor IDs, epoch values, and grace overflow", () => {
    const service = createTurnService(config(), { now: () => 1 });
    expect(() => service.issue("", 2)).toThrow(RangeError);
    expect(() => service.issue("bad:id", 2)).toThrow(RangeError);
    expect(() => service.issue("vis_001", 2.5)).toThrow(RangeError);
    expect(() => createTurnService(config({
      turn: { ...config().turn!, credentialGraceMs: 0 },
    }), { now: () => 1 }).issue("vis_001", 2)).toThrow(RangeError);
    expect(() => createTurnService(config({
      turn: {
        ...config().turn!,
        credentialGraceMs: 10,
      },
    }), { now: () => 1 }).issue("vis_001", Number.MAX_SAFE_INTEGER - 1))
      .toThrow(RangeError);
  });
});
