import { isIP } from "node:net";

export type ApiConfig = {
  port: number;
  databasePath?: string;
  realtimeTicketTtlMs?: number;
  realtimeTicketMaxPerVisitor?: number;
  realtimeMessagesPerSecond?: number;
  realtimeOutboundQueueMaxMessages?: number;
  realtimeOutboundQueueMaxBytes?: number;
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
const DEFAULT_DATABASE_PATH = ":memory:";
const DEFAULT_REALTIME_TICKET_TTL_SECONDS = 60;
const DEFAULT_REALTIME_TICKET_MAX_PER_VISITOR = 12;
const DEFAULT_REALTIME_MESSAGES_PER_SECOND = 30;
const DEFAULT_REALTIME_OUTBOUND_QUEUE_MAX_MESSAGES = 128;
const DEFAULT_REALTIME_OUTBOUND_QUEUE_MAX_BYTES = 1_048_576;
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

const parsePositiveInteger = (
  value: string | undefined,
  key: string,
  defaultValue: number,
  maximum = Number.MAX_SAFE_INTEGER,
) => {
  const raw = value?.trim() ?? String(defaultValue);
  if (!/^\d+$/u.test(raw)) throw new Error(`${key} must be a positive whole number`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${key} is outside the safe range`);
  }
  return parsed;
};

const parseDatabasePath = (value: string | undefined) => {
  const path = value?.trim() || DEFAULT_DATABASE_PATH;
  if (path.length > 512) throw new Error("DATABASE_PATH is too long");
  return path;
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
    databasePath: parseDatabasePath(environment.DATABASE_PATH),
    realtimeTicketTtlMs: parsePositiveInteger(
      environment.REALTIME_TICKET_TTL_SECONDS,
      "REALTIME_TICKET_TTL_SECONDS",
      DEFAULT_REALTIME_TICKET_TTL_SECONDS,
      3_600,
    ) * 1_000,
    realtimeTicketMaxPerVisitor: parsePositiveInteger(
      environment.REALTIME_TICKET_MAX_PER_VISITOR,
      "REALTIME_TICKET_MAX_PER_VISITOR",
      DEFAULT_REALTIME_TICKET_MAX_PER_VISITOR,
      1_000,
    ),
    realtimeMessagesPerSecond: parsePositiveInteger(
      environment.REALTIME_MESSAGES_PER_SECOND,
      "REALTIME_MESSAGES_PER_SECOND",
      DEFAULT_REALTIME_MESSAGES_PER_SECOND,
      10_000,
    ),
    realtimeOutboundQueueMaxMessages: parsePositiveInteger(
      environment.REALTIME_OUTBOUND_QUEUE_MAX_MESSAGES,
      "REALTIME_OUTBOUND_QUEUE_MAX_MESSAGES",
      DEFAULT_REALTIME_OUTBOUND_QUEUE_MAX_MESSAGES,
      10_000,
    ),
    realtimeOutboundQueueMaxBytes: parsePositiveInteger(
      environment.REALTIME_OUTBOUND_QUEUE_MAX_BYTES,
      "REALTIME_OUTBOUND_QUEUE_MAX_BYTES",
      DEFAULT_REALTIME_OUTBOUND_QUEUE_MAX_BYTES,
      64 * 1_024 * 1_024,
    ),
    stunUrls,
    ...(turn ? { turn } : {}),
    corsAllowedOrigins: parseCorsOrigins(environment.CORS_ALLOWED_ORIGINS),
    trustProxy,
    trustedProxyIps,
  };
};
