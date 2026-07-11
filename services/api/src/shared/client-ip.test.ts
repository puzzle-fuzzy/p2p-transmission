import { describe, expect, test } from "bun:test";
import {
  UNKNOWN_CLIENT_IP,
  createClientIpResolver,
} from "./client-ip";

const resolve = (
  resolver: ReturnType<typeof createClientIpResolver>,
  directAddress?: string,
  forwarded?: string,
) => resolver.resolve({
  directAddress,
  headers: forwarded === undefined
    ? {}
    : { "x-forwarded-for": forwarded },
});

describe("trusted client IP resolution", () => {
  test("uses the direct socket and ignores XFF when proxy trust is disabled", () => {
    const resolver = createClientIpResolver({
      trustProxy: false,
      trustedProxyIps: new Set(["10.0.0.10"]),
    });

    expect(resolve(resolver, "198.51.100.20", "203.0.113.8"))
      .toBe("198.51.100.20");
  });

  test("ignores every forwarded value from an untrusted direct peer", () => {
    const resolver = createClientIpResolver({
      trustProxy: true,
      trustedProxyIps: new Set(["10.0.0.10"]),
    });

    expect(resolve(
      resolver,
      "198.51.100.20",
      "192.0.2.99, 203.0.113.8",
    )).toBe("198.51.100.20");
  });

  test("selects the rightmost untrusted hop so a spoofed leftmost value cannot win", () => {
    const resolver = createClientIpResolver({
      trustProxy: true,
      trustedProxyIps: new Set(["10.0.0.10"]),
    });

    expect(resolve(
      resolver,
      "10.0.0.10",
      "192.0.2.99, 203.0.113.8",
    )).toBe("203.0.113.8");
  });

  test("strips only the trusted suffix across multiple proxies", () => {
    const resolver = createClientIpResolver({
      trustProxy: true,
      trustedProxyIps: new Set(["10.0.0.10", "10.0.0.11"]),
    });

    expect(resolve(
      resolver,
      "10.0.0.11",
      "192.0.2.99, 203.0.113.8, 10.0.0.10",
    )).toBe("203.0.113.8");
  });

  test("falls back to the direct socket for malformed, missing, or all-trusted chains", () => {
    const resolver = createClientIpResolver({
      trustProxy: true,
      trustedProxyIps: new Set(["10.0.0.10", "10.0.0.11"]),
    });

    expect(resolve(resolver, "10.0.0.11")).toBe("10.0.0.11");
    expect(resolve(resolver, "10.0.0.11", "not-an-ip, 203.0.113.8"))
      .toBe("10.0.0.11");
    expect(resolve(resolver, "10.0.0.11", "10.0.0.10"))
      .toBe("10.0.0.11");
  });

  test("returns stable unknown without a valid direct socket", () => {
    const resolver = createClientIpResolver({
      trustProxy: true,
      trustedProxyIps: new Set(["10.0.0.10"]),
    });

    expect(resolve(resolver, undefined, "203.0.113.8")).toBe(UNKNOWN_CLIENT_IP);
    expect(resolve(resolver, "invalid", "203.0.113.8")).toBe(UNKNOWN_CLIENT_IP);
    expect(UNKNOWN_CLIENT_IP).toBe("unknown");
  });

  test("supports Headers, case-insensitive record keys, and repeated field values", () => {
    const resolver = createClientIpResolver({
      trustProxy: true,
      trustedProxyIps: new Set(["10.0.0.10"]),
    });

    expect(resolver.resolve({
      directAddress: "10.0.0.10",
      headers: new Headers({ "X-Forwarded-For": "203.0.113.8" }),
    })).toBe("203.0.113.8");
    expect(resolver.resolve({
      directAddress: "10.0.0.10",
      headers: {
        "X-Forwarded-For": ["192.0.2.99", "203.0.113.8"],
      },
    })).toBe("203.0.113.8");
  });

  test("normalizes IPv4-mapped direct socket addresses before trust checks", () => {
    const resolver = createClientIpResolver({
      trustProxy: true,
      trustedProxyIps: new Set(["10.0.0.10"]),
    });

    expect(resolve(resolver, "::ffff:10.0.0.10", "203.0.113.8"))
      .toBe("203.0.113.8");
  });
});
