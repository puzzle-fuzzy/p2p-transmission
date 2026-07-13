import { createHash } from "node:crypto";
import type { VisitorService } from "../visitor/service";

export type RealtimeTicketServiceOptions = {
  now?: () => number;
  ttlMs?: number;
  maxPerVisitor?: number;
};

export type RealtimeTicketError = {
  code: "VISITOR_NOT_FOUND" | "CAPACITY_EXCEEDED" | "REALTIME_TICKET_INVALID";
  message: string;
};

export type RealtimeTicketService = {
  issue(visitorToken: string):
    | { ok: true; ticket: string; expiresAt: number }
    | { ok: false; error: RealtimeTicketError };
  consume(ticket: string):
    | { ok: true; visitorToken: string }
    | { ok: false; error: RealtimeTicketError };
  cleanup(): void;
};

type TicketRecord = {
  visitorId: string;
  visitorToken: string;
  expiresAt: number;
};

const visitorNotFound = {
  code: "VISITOR_NOT_FOUND" as const,
  message: "访客不存在或已过期",
};

const capacityExceeded = {
  code: "CAPACITY_EXCEEDED" as const,
  message: "实时连接票据容量已满",
};

const ticketInvalid = {
  code: "REALTIME_TICKET_INVALID" as const,
  message: "实时连接票据无效或已过期",
};

const hashTicket = (ticket: string) =>
  createHash("sha256").update(ticket).digest("hex");

const createTicket = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
};

export const createRealtimeTicketService = (
  visitors: Pick<VisitorService, "getByToken">,
  options: RealtimeTicketServiceOptions = {},
): RealtimeTicketService => {
  const currentTime = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 60_000;
  const maxPerVisitor = options.maxPerVisitor ?? 12;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new RangeError("Realtime ticket TTL must be positive");
  }
  if (!Number.isSafeInteger(maxPerVisitor) || maxPerVisitor < 1) {
    throw new RangeError("Realtime ticket capacity must be positive");
  }

  const tickets = new Map<string, TicketRecord>();

  const cleanup = () => {
    const timestamp = currentTime();
    for (const [digest, record] of tickets) {
      if (record.expiresAt <= timestamp) tickets.delete(digest);
    }
  };

  return {
    issue(visitorToken) {
      const visitor = visitors.getByToken(visitorToken);
      if (!visitor) return { ok: false, error: visitorNotFound };
      cleanup();
      const issuedForVisitor = Array.from(tickets.values())
        .filter(record => record.visitorId === visitor.id).length;
      if (issuedForVisitor >= maxPerVisitor) {
        return { ok: false, error: capacityExceeded };
      }
      const ticket = createTicket();
      const expiresAt = currentTime() + ttlMs;
      tickets.set(hashTicket(ticket), {
        visitorId: visitor.id,
        visitorToken,
        expiresAt,
      });
      return { ok: true, ticket, expiresAt };
    },
    consume(ticket) {
      if (!/^[A-Za-z0-9_-]{40,128}$/u.test(ticket)) {
        return { ok: false, error: ticketInvalid };
      }
      const digest = hashTicket(ticket);
      const record = tickets.get(digest);
      if (!record) return { ok: false, error: ticketInvalid };
      tickets.delete(digest);
      if (record.expiresAt <= currentTime()) {
        return { ok: false, error: ticketInvalid };
      }
      if (!visitors.getByToken(record.visitorToken)) {
        return { ok: false, error: visitorNotFound };
      }
      return { ok: true, visitorToken: record.visitorToken };
    },
    cleanup,
  };
};
