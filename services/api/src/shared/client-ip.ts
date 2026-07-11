import { isIP } from "node:net";

export const UNKNOWN_CLIENT_IP = "unknown";

export type ClientIpHeaders =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export type ClientIpInput = {
  directAddress?: string | null;
  headers?: ClientIpHeaders;
};

export type ClientIpResolver = {
  resolve(input: ClientIpInput): string;
};

export type ClientIpResolverOptions = {
  trustProxy: boolean;
  trustedProxyIps: ReadonlySet<string>;
};

const normalizeIp = (value: string | null | undefined) => {
  if (!value) return undefined;
  const trimmed = value.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(trimmed)?.[1];
  if (mapped && isIP(mapped) === 4) return mapped;
  return isIP(trimmed) === 0 ? undefined : trimmed.toLowerCase();
};

const readForwardedFor = (headers: ClientIpHeaders | undefined) => {
  if (!headers) return undefined;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get("x-forwarded-for") ?? undefined;
  }

  const values = Object.entries(headers).flatMap(([key, value]) => {
    if (key.toLowerCase() !== "x-forwarded-for" || value === undefined) return [];
    return typeof value === "string" ? [value] : value;
  });
  return values.length > 0 ? values.join(",") : undefined;
};

const parseForwardedChain = (value: string | undefined) => {
  if (value === undefined || value.trim() === "") return undefined;
  const entries = value.split(",").map(entry => entry.trim());
  if (entries.some(entry => entry === "")) return undefined;

  const normalized = entries.map(entry => normalizeIp(entry));
  if (normalized.some(entry => entry === undefined)) return undefined;
  return normalized as string[];
};

export const createClientIpResolver = ({
  trustProxy,
  trustedProxyIps,
}: ClientIpResolverOptions): ClientIpResolver => {
  const trusted = new Set(
    Array.from(trustedProxyIps).flatMap(address => {
      const normalized = normalizeIp(address);
      return normalized ? [normalized] : [];
    }),
  );

  return {
    resolve({ directAddress, headers }) {
      const direct = normalizeIp(directAddress);
      if (!direct) return UNKNOWN_CLIENT_IP;
      if (!trustProxy || !trusted.has(direct)) return direct;

      const forwarded = parseForwardedChain(readForwardedFor(headers));
      if (!forwarded) return direct;

      const chain = [...forwarded, direct];
      let index = chain.length - 1;
      while (index >= 0 && trusted.has(chain[index]!)) index -= 1;
      return index >= 0 ? chain[index]! : direct;
    },
  };
};
