import { isIP } from "node:net";

export type ApiConfig = {
  port: number;
  stunUrls: string[];
  turn?: {
    urls: string[];
    sharedSecret: string;
    credentialGraceMs: number;
  };
  corsAllowedOrigins: string[];
  trustProxy: boolean;
  trustedProxyIps: Set<string>;
};

export type ApiEnvironment = Readonly<Record<string, string | undefined>>;

const DEFAULT_PORT = 3000;
const DEFAULT_TURN_CREDENTIAL_GRACE_SECONDS = 300;
const DEFAULT_CORS_ALLOWED_ORIGINS = ["http://localhost:5713"];

const parseCommaList = (value: string | undefined) => {
  if (value === undefined) return [];

  return Array.from(new Set(
    value.split(",").map(entry => entry.trim()).filter(Boolean),
  ));
};

const parsePort = (value: string | undefined) => {
  if (value === undefined) return DEFAULT_PORT;
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error("PORT must be a whole number between 1 and 65535");
  }

  const port = Number(trimmed);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a whole number between 1 and 65535");
  }
  return port;
};

const parseBoolean = (
  value: string | undefined,
  key: string,
  defaultValue: boolean,
) => {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${key} must be true or false`);
};

const validateIceUrls = (
  urls: readonly string[],
  key: "STUN_URLS" | "TURN_URLS",
) => {
  const pattern = key === "STUN_URLS"
    ? /^stun:[^\s]+$/u
    : /^turns?:[^\s]+$/u;

  for (const url of urls) {
    if (url.length > 2_048 || !pattern.test(url)) {
      throw new Error(`${key} contains an invalid ICE URL`);
    }
  }
};

const parseGraceMs = (value: string | undefined) => {
  const raw = value?.trim() ?? String(DEFAULT_TURN_CREDENTIAL_GRACE_SECONDS);
  if (!/^\d+$/u.test(raw)) {
    throw new Error("TURN_CREDENTIAL_GRACE_SECONDS must be a positive whole number");
  }

  const seconds = Number(raw);
  const milliseconds = seconds * 1_000;
  if (seconds < 1 || !Number.isSafeInteger(seconds) || !Number.isSafeInteger(milliseconds)) {
    throw new Error("TURN_CREDENTIAL_GRACE_SECONDS is outside the safe range");
  }
  return milliseconds;
};

const parseCorsOrigin = (value: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CORS_ALLOWED_ORIGINS contains an invalid origin");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("CORS_ALLOWED_ORIGINS must contain HTTP(S) origins without paths");
  }

  return url.origin;
};

const parseCorsOrigins = (value: string | undefined) => {
  if (value === undefined) return [...DEFAULT_CORS_ALLOWED_ORIGINS];
  const entries = parseCommaList(value);
  if (entries.length === 0) {
    throw new Error("CORS_ALLOWED_ORIGINS must contain at least one origin");
  }

  return Array.from(new Set(entries.map(parseCorsOrigin)));
};

const normalizeIp = (value: string) => {
  const trimmed = value.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(trimmed)?.[1];
  if (mapped && isIP(mapped) === 4) return mapped;
  return isIP(trimmed) === 0 ? undefined : trimmed.toLowerCase();
};

const parseTrustedProxyIps = (value: string | undefined) => {
  const addresses = parseCommaList(value);
  const normalized = addresses.map(address => {
    const ip = normalizeIp(address);
    if (!ip) throw new Error("TRUSTED_PROXY_IPS must contain only IP addresses");
    return ip;
  });
  return new Set(normalized);
};

export const loadApiConfig = (
  environment: ApiEnvironment = Bun.env,
): ApiConfig => {
  const stunUrls = parseCommaList(environment.STUN_URLS);
  validateIceUrls(stunUrls, "STUN_URLS");

  const turnUrls = parseCommaList(environment.TURN_URLS);
  const sharedSecret = environment.TURN_SHARED_SECRET;
  const hasTurnUrls = turnUrls.length > 0;
  const hasSharedSecret = sharedSecret !== undefined && sharedSecret.length > 0;
  const hasTurnSetting = environment.TURN_URLS !== undefined
    || environment.TURN_SHARED_SECRET !== undefined;
  if (hasTurnSetting && (!hasTurnUrls || !hasSharedSecret)) {
    throw new Error("TURN_URLS and TURN_SHARED_SECRET must be configured together");
  }

  const credentialGraceMs = parseGraceMs(environment.TURN_CREDENTIAL_GRACE_SECONDS);
  let turn: ApiConfig["turn"];
  if (hasTurnUrls && hasSharedSecret) {
    validateIceUrls(turnUrls, "TURN_URLS");
    if (new TextEncoder().encode(sharedSecret).byteLength < 32) {
      throw new Error("TURN_SHARED_SECRET must be at least 32 bytes");
    }
    turn = {
      urls: turnUrls,
      sharedSecret,
      credentialGraceMs,
    };
  }

  const trustProxy = parseBoolean(environment.TRUST_PROXY, "TRUST_PROXY", false);
  const trustedProxyIps = parseTrustedProxyIps(environment.TRUSTED_PROXY_IPS);
  if (trustProxy && trustedProxyIps.size === 0) {
    throw new Error("TRUSTED_PROXY_IPS is required when TRUST_PROXY is true");
  }

  return {
    port: parsePort(environment.PORT),
    stunUrls,
    ...(turn ? { turn } : {}),
    corsAllowedOrigins: parseCorsOrigins(environment.CORS_ALLOWED_ORIGINS),
    trustProxy,
    trustedProxyIps,
  };
};
