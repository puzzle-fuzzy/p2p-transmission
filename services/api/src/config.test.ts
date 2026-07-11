import { describe, expect, test } from "bun:test";
import { loadApiConfig } from "./config";

const secret32 = "0123456789abcdef0123456789abcdef";

describe("API configuration", () => {
  test("loads safe off-mode and local-development defaults", () => {
    const config = loadApiConfig({});

    expect(config).toEqual({
      port: 3000,
      stunUrls: [],
      corsAllowedOrigins: ["http://localhost:5713"],
      trustProxy: false,
      trustedProxyIps: new Set(),
    });
    expect(config.turn).toBeUndefined();
  });

  test("loads complete TURN REST configuration with trimmed deduplicated lists", () => {
    const config = loadApiConfig({
      PORT: " 4100 ",
      STUN_URLS: " stun:stun.example.com:3478,stun:backup.example.com:3478, stun:stun.example.com:3478 ",
      TURN_URLS: " turn:turn.example.com:3478?transport=udp, turns:turn.example.com:5349?transport=tcp,turn:turn.example.com:3478?transport=udp ",
      TURN_SHARED_SECRET: secret32,
      CORS_ALLOWED_ORIGINS: " https://app.example.com, http://localhost:5713/,https://app.example.com ",
      TRUST_PROXY: "true",
      TRUSTED_PROXY_IPS: " 10.0.0.10,10.0.0.11,10.0.0.10 ",
    });

    expect(config.port).toBe(4100);
    expect(config.stunUrls).toEqual([
      "stun:stun.example.com:3478",
      "stun:backup.example.com:3478",
    ]);
    expect(config.turn).toEqual({
      urls: [
        "turn:turn.example.com:3478?transport=udp",
        "turns:turn.example.com:5349?transport=tcp",
      ],
      sharedSecret: secret32,
      credentialGraceMs: 300_000,
    });
    expect(config.corsAllowedOrigins).toEqual([
      "https://app.example.com",
      "http://localhost:5713",
    ]);
    expect(config.trustProxy).toBe(true);
    expect(config.trustedProxyIps).toEqual(new Set(["10.0.0.10", "10.0.0.11"]));
  });

  test("measures TURN secret minimum in UTF-8 bytes and preserves the exact secret", () => {
    const utf8Secret = "é".repeat(16);
    const config = loadApiConfig({
      TURN_URLS: "turn:turn.example.com:3478",
      TURN_SHARED_SECRET: utf8Secret,
    });

    expect(config.turn?.sharedSecret).toBe(utf8Secret);
    expect(() => loadApiConfig({
      TURN_URLS: "turn:turn.example.com:3478",
      TURN_SHARED_SECRET: "x".repeat(31),
    })).toThrow(/TURN_SHARED_SECRET.*32 bytes/u);
  });

  test("fails closed for every partial TURN REST configuration", () => {
    expect(() => loadApiConfig({
      TURN_URLS: "turn:turn.example.com:3478",
    })).toThrow(/TURN_URLS.*TURN_SHARED_SECRET/u);

    expect(() => loadApiConfig({
      TURN_SHARED_SECRET: secret32,
    })).toThrow(/TURN_URLS.*TURN_SHARED_SECRET/u);

    expect(() => loadApiConfig({
      TURN_URLS: "   ",
      TURN_SHARED_SECRET: secret32,
    })).toThrow(/TURN_URLS.*TURN_SHARED_SECRET/u);

    expect(() => loadApiConfig({
      TURN_URLS: "",
      TURN_SHARED_SECRET: "",
    })).toThrow(/TURN_URLS.*TURN_SHARED_SECRET/u);
  });

  test("validates STUN and TURN URL schemes", () => {
    expect(() => loadApiConfig({
      STUN_URLS: "https://stun.example.com",
    })).toThrow(/STUN_URLS/u);
    expect(() => loadApiConfig({
      STUN_URLS: "turn:turn.example.com:3478",
    })).toThrow(/STUN_URLS/u);
    expect(() => loadApiConfig({
      TURN_URLS: "stun:stun.example.com:3478",
      TURN_SHARED_SECRET: secret32,
    })).toThrow(/TURN_URLS/u);
    expect(() => loadApiConfig({
      TURN_URLS: "https://turn.example.com",
      TURN_SHARED_SECRET: secret32,
    })).toThrow(/TURN_URLS/u);
  });

  test("uses 300 seconds grace by default and parses explicit whole seconds", () => {
    const defaultGrace = loadApiConfig({
      TURN_URLS: "turn:turn.example.com:3478",
      TURN_SHARED_SECRET: secret32,
    });
    const explicitGrace = loadApiConfig({
      TURN_URLS: "turn:turn.example.com:3478",
      TURN_SHARED_SECRET: secret32,
      TURN_CREDENTIAL_GRACE_SECONDS: "450",
    });

    expect(defaultGrace.turn?.credentialGraceMs).toBe(300_000);
    expect(explicitGrace.turn?.credentialGraceMs).toBe(450_000);
    for (const invalid of ["-1", "1.5", "NaN", "9007199254740991"]) {
      expect(() => loadApiConfig({
        TURN_URLS: "turn:turn.example.com:3478",
        TURN_SHARED_SECRET: secret32,
        TURN_CREDENTIAL_GRACE_SECONDS: invalid,
      })).toThrow(/TURN_CREDENTIAL_GRACE_SECONDS/u);
    }
    expect(() => loadApiConfig({
      TURN_CREDENTIAL_GRACE_SECONDS: "invalid-even-while-off",
    })).toThrow(/TURN_CREDENTIAL_GRACE_SECONDS/u);
  });

  test("validates configured CORS origins and rejects wildcard or paths", () => {
    expect(loadApiConfig({
      CORS_ALLOWED_ORIGINS: "https://one.example,https://two.example",
    }).corsAllowedOrigins).toEqual([
      "https://one.example",
      "https://two.example",
    ]);

    for (const invalid of ["", "*", "ftp://app.example.com", "https://app.example.com/path"]) {
      expect(() => loadApiConfig({ CORS_ALLOWED_ORIGINS: invalid }))
        .toThrow(/CORS_ALLOWED_ORIGINS/u);
    }
  });

  test("defaults TRUST_PROXY to false and requires valid trusted direct peers", () => {
    expect(loadApiConfig({ TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(() => loadApiConfig({ TRUST_PROXY: "true" }))
      .toThrow(/TRUSTED_PROXY_IPS/u);
    expect(() => loadApiConfig({
      TRUST_PROXY: "true",
      TRUSTED_PROXY_IPS: "proxy.internal",
    })).toThrow(/TRUSTED_PROXY_IPS/u);
    expect(() => loadApiConfig({ TRUST_PROXY: "yes" })).toThrow(/TRUST_PROXY/u);
  });

  test("validates the API port", () => {
    for (const invalid of ["0", "65536", "1.5", "not-a-port"]) {
      expect(() => loadApiConfig({ PORT: invalid })).toThrow(/PORT/u);
    }
  });

  test("never includes secret material in configuration errors", () => {
    const shortSecret = "do-not-print-this-secret";
    try {
      loadApiConfig({
        TURN_URLS: "turn:turn.example.com:3478",
        TURN_SHARED_SECRET: shortSecret,
      });
      throw new Error("expected configuration failure");
    } catch (error) {
      expect(String(error)).not.toContain(shortSecret);
    }
  });
});
