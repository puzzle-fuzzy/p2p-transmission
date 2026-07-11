import { describe, expect, test } from "bun:test";
import { renderCoturnConfig } from "./coturn-config";

const input = () => ({
  sharedSecret: "0123456789abcdef0123456789abcdef",
  realm: "turn.example.com",
  externalIp: "203.0.113.10/10.0.0.10",
  certificatePath: "/run/coturn/tls/fullchain.pem",
  privateKeyPath: "/run/coturn/tls/privkey.pem",
});

describe("coturn configuration renderer", () => {
  test("renders authenticated listeners, bounded relay ports, and quotas", () => {
    const rendered = renderCoturnConfig(input());

    for (const line of [
      "use-auth-secret",
      "static-auth-secret=0123456789abcdef0123456789abcdef",
      "realm=turn.example.com",
      "external-ip=203.0.113.10/10.0.0.10",
      "listening-port=3478",
      "tls-listening-port=5349",
      "min-port=49160",
      "max-port=49259",
      "user-quota=64",
      "total-quota=100",
      "max-bps=12500000",
      "bps-capacity=125000000",
      "no-cli",
      "no-loopback-peers",
      "no-multicast-peers",
      "cert=/run/coturn/tls/fullchain.pem",
      "pkey=/run/coturn/tls/privkey.pem",
    ]) {
      expect(rendered).toContain(`${line}\n`);
    }
  });

  test("denies private, loopback, link-local, carrier, multicast, and IPv6 ranges", () => {
    const rendered = renderCoturnConfig(input());
    for (const marker of [
      "10.0.0.0-10.255.255.255",
      "100.64.0.0-100.127.255.255",
      "127.0.0.0-127.255.255.255",
      "169.254.0.0-169.254.255.255",
      "172.16.0.0-172.31.255.255",
      "192.168.0.0-192.168.255.255",
      "224.0.0.0-255.255.255.255",
      "fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "ff00::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    ]) {
      expect(rendered).toContain(`denied-peer-ip=${marker}`);
    }
  });

  test("rejects missing, injectable, weak, and invalid deployment values", () => {
    expect(() => renderCoturnConfig({ ...input(), sharedSecret: "short" }))
      .toThrow(RangeError);
    expect(() => renderCoturnConfig({ ...input(), realm: "good\nno-cli" }))
      .toThrow(RangeError);
    expect(() => renderCoturnConfig({ ...input(), externalIp: "example.com" }))
      .toThrow(RangeError);
    expect(() => renderCoturnConfig({ ...input(), certificatePath: "relative.pem" }))
      .toThrow(RangeError);
    expect(() => renderCoturnConfig({ ...input(), relayPortMin: 50_000, relayPortMax: 49_000 }))
      .toThrow(RangeError);
  });
});
