import { isIP } from "node:net";
import type { CoturnConfigInput } from "./model";

const assertSafeConfigValue = (value: string, label: string) => {
  if (
    !value
    || value.length > 2_048
    || value.includes("\r")
    || value.includes("\n")
    || value.includes("\0")
  ) {
    throw new RangeError(`${label} is invalid`);
  }
};

const assertPort = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new RangeError(`${label} must be a valid port`);
  }
};

const deniedPeerRanges = [
  "0.0.0.0-0.255.255.255",
  "10.0.0.0-10.255.255.255",
  "100.64.0.0-100.127.255.255",
  "127.0.0.0-127.255.255.255",
  "169.254.0.0-169.254.255.255",
  "172.16.0.0-172.31.255.255",
  "192.0.0.0-192.0.0.255",
  "192.0.2.0-192.0.2.255",
  "192.88.99.0-192.88.99.255",
  "192.168.0.0-192.168.255.255",
  "198.18.0.0-198.19.255.255",
  "198.51.100.0-198.51.100.255",
  "203.0.113.0-203.0.113.255",
  "224.0.0.0-255.255.255.255",
  "::-::ffff:ffff:ffff:ffff",
  "100::-100::ffff:ffff:ffff:ffff",
  "2001:db8::-2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
  "2002::-2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "ff00::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
];

export const renderCoturnConfig = ({
  sharedSecret,
  realm,
  externalIp,
  certificatePath,
  privateKeyPath,
  listeningPort = 3_478,
  tlsListeningPort = 5_349,
  relayPortMin = 49_160,
  relayPortMax = 49_259,
}: CoturnConfigInput) => {
  assertSafeConfigValue(sharedSecret, "TURN shared secret");
  if (new TextEncoder().encode(sharedSecret).byteLength < 32) {
    throw new RangeError("TURN shared secret must be at least 32 bytes");
  }
  assertSafeConfigValue(realm, "TURN realm");
  if (!/^[A-Za-z0-9.-]+$/u.test(realm)) throw new RangeError("TURN realm is invalid");
  assertSafeConfigValue(externalIp, "TURN external IP");
  const externalAddresses = externalIp.split("/");
  if (externalAddresses.length > 2 || externalAddresses.some(address => isIP(address) === 0)) {
    throw new RangeError("TURN external IP is invalid");
  }
  assertSafeConfigValue(certificatePath, "TURN certificate path");
  assertSafeConfigValue(privateKeyPath, "TURN private-key path");
  if (!certificatePath.startsWith("/") || !privateKeyPath.startsWith("/")) {
    throw new RangeError("TURN TLS paths must be absolute container paths");
  }
  assertPort(listeningPort, "TURN listening port");
  assertPort(tlsListeningPort, "TURN TLS listening port");
  assertPort(relayPortMin, "TURN relay minimum port");
  assertPort(relayPortMax, "TURN relay maximum port");
  if (relayPortMin > relayPortMax) throw new RangeError("TURN relay port range is invalid");

  return [
    "use-auth-secret",
    `static-auth-secret=${sharedSecret}`,
    `realm=${realm}`,
    `external-ip=${externalIp}`,
    `listening-port=${String(listeningPort)}`,
    `tls-listening-port=${String(tlsListeningPort)}`,
    `min-port=${String(relayPortMin)}`,
    `max-port=${String(relayPortMax)}`,
    "fingerprint",
    "user-quota=64",
    "total-quota=100",
    "max-bps=12500000",
    "bps-capacity=125000000",
    "no-cli",
    "no-loopback-peers",
    "no-multicast-peers",
    "no-tlsv1",
    "no-tlsv1_1",
    `cert=${certificatePath}`,
    `pkey=${privateKeyPath}`,
    ...deniedPeerRanges.map(range => `denied-peer-ip=${range}`),
    "",
  ].join("\n");
};
