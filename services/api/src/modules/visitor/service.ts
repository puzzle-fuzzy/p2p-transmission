import { createRandomId } from "../../shared/ids";
import { now as defaultNow } from "../../shared/time";
import type { PublicVisitor, Visitor, VisitorServiceOptions } from "./model";

export type VisitorService = {
  createVisitor(): Visitor;
  getById(id: string): Visitor | undefined;
  getByToken(token: string): Visitor | undefined;
  touch(token: string): Visitor | undefined;
  toPublic(visitor: Visitor): PublicVisitor;
};

const visitorNumber = (id: string) => {
  const digits = id.replace(/\D/g, "").slice(-4).padStart(4, "0");

  return digits || "0000";
};

export const createVisitorService = (options: VisitorServiceOptions = {}): VisitorService => {
  const currentTime = options.now ?? defaultNow;
  const createId = options.createId ?? (() => createRandomId("vis"));
  const createToken = options.createToken ?? (() => createRandomId("tok"));
  const createAvatarSeed = options.createAvatarSeed ?? (() => createRandomId("avatar"));
  const visitorsById = new Map<string, Visitor>();
  const visitorsByToken = new Map<string, Visitor>();

  const toPublic = (visitor: Visitor): PublicVisitor => ({
    id: visitor.id,
    avatarSeed: visitor.avatarSeed,
    displayName: visitor.displayName,
    createdAt: visitor.createdAt,
    lastSeenAt: visitor.lastSeenAt,
  });

  return {
    createVisitor() {
      const timestamp = currentTime();
      const id = createId();
      const visitor: Visitor = {
        id,
        avatarSeed: createAvatarSeed(),
        displayName: `访客 ${visitorNumber(id)}`,
        token: createToken(),
        createdAt: timestamp,
        lastSeenAt: timestamp,
      };

      visitorsById.set(visitor.id, visitor);
      visitorsByToken.set(visitor.token, visitor);

      return visitor;
    },
    getById(id) {
      return visitorsById.get(id);
    },
    getByToken(token) {
      return visitorsByToken.get(token);
    },
    touch(token) {
      const visitor = visitorsByToken.get(token);

      if (!visitor) return undefined;

      visitor.lastSeenAt = currentTime();

      return visitor;
    },
    toPublic,
  };
};
