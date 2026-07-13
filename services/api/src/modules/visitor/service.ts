import { createRandomId } from "../../shared/ids";
import { now as defaultNow } from "../../shared/time";
import type {
  PublicVisitor,
  Visitor,
  VisitorResult,
  VisitorServiceOptions,
} from "./model";

export type VisitorService = {
  createVisitor(): Visitor;
  tryCreateVisitor(): VisitorResult;
  getById(id: string): Visitor | undefined;
  getByToken(token: string): Visitor | undefined;
  touch(token: string): Visitor | undefined;
  remove(id: string): boolean;
  listExpiredVisitorIds(): string[];
  size(): number;
  snapshot(): Visitor[];
  toPublic(visitor: Visitor): PublicVisitor;
};

export class VisitorCapacityExceededError extends Error {
  readonly code = "CAPACITY_EXCEEDED";

  constructor(message = "访客容量已满") {
    super(message);
    this.name = "VisitorCapacityExceededError";
  }
}

const visitorNumber = (id: string) => {
  const digits = id.replace(/\D/g, "").slice(-4).padStart(4, "0");

  return digits || "0000";
};

export const createVisitorService = (options: VisitorServiceOptions = {}): VisitorService => {
  const currentTime = options.now ?? defaultNow;
  const createId = options.createId ?? (() => createRandomId("vis"));
  const createToken = options.createToken ?? (() => createRandomId("tok"));
  const createAvatarSeed = options.createAvatarSeed ?? (() => createRandomId("avatar"));
  const maxVisitors = options.maxVisitors ?? 10_000;
  const idleTtlMs = options.idleTtlMs ?? 2 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(maxVisitors) || maxVisitors < 1) {
    throw new RangeError("Visitor capacity must be a positive safe integer");
  }
  if (!Number.isSafeInteger(idleTtlMs) || idleTtlMs < 1) {
    throw new RangeError("Visitor idle TTL must be a positive safe integer");
  }
  const visitorsById = new Map<string, Visitor>();
  const visitorsByToken = new Map<string, Visitor>();

  for (const visitor of options.initialVisitors ?? []) {
    const restored = { ...visitor };
    if (visitorsById.has(restored.id) || visitorsByToken.has(restored.token)) {
      throw new Error("持久化访客标识冲突");
    }
    visitorsById.set(restored.id, restored);
    visitorsByToken.set(restored.token, restored);
  }

  const toPublic = (visitor: Visitor): PublicVisitor => ({
    id: visitor.id,
    avatarSeed: visitor.avatarSeed,
    displayName: visitor.displayName,
    createdAt: visitor.createdAt,
    lastSeenAt: visitor.lastSeenAt,
  });

  const isExpired = (visitor: Visitor) =>
    visitor.lastSeenAt + idleTtlMs <= currentTime();

  const tryCreateVisitor = (): VisitorResult => {
    if (visitorsById.size >= maxVisitors) {
      return {
        ok: false,
        error: {
          code: "CAPACITY_EXCEEDED",
          message: "访客容量已满",
        },
      };
    }

    const timestamp = currentTime();
    const id = createId();
    const token = createToken();
    if (visitorsById.has(id) || visitorsByToken.has(token)) {
      throw new Error("访客标识生成冲突");
    }
    const visitor: Visitor = {
      id,
      avatarSeed: createAvatarSeed(),
      displayName: `访客 ${visitorNumber(id)}`,
      token,
      createdAt: timestamp,
      lastSeenAt: timestamp,
    };

    visitorsById.set(visitor.id, visitor);
    visitorsByToken.set(visitor.token, visitor);

    return { ok: true, visitor };
  };

  return {
    createVisitor() {
      const result = tryCreateVisitor();
      if (!result.ok) throw new VisitorCapacityExceededError(result.error.message);
      return result.visitor;
    },
    tryCreateVisitor,
    getById(id) {
      return visitorsById.get(id);
    },
    getByToken(token) {
      const visitor = visitorsByToken.get(token);
      return visitor && !isExpired(visitor) ? visitor : undefined;
    },
    touch(token) {
      const visitor = visitorsByToken.get(token);

      if (!visitor || isExpired(visitor)) return undefined;

      visitor.lastSeenAt = currentTime();

      return visitor;
    },
    remove(id) {
      const visitor = visitorsById.get(id);
      if (!visitor) return false;
      visitorsById.delete(id);
      visitorsByToken.delete(visitor.token);
      return true;
    },
    listExpiredVisitorIds() {
      return Array.from(visitorsById.values())
        .filter(isExpired)
        .map(visitor => visitor.id)
        .sort();
    },
    size() {
      return visitorsById.size;
    },
    snapshot() {
      return Array.from(visitorsById.values(), visitor => ({ ...visitor }));
    },
    toPublic,
  };
};
