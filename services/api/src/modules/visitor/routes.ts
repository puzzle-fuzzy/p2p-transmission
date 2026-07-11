import { Elysia } from "elysia";
import type { AppContext } from "../../context";

export const visitorRoutes = (context: AppContext) =>
  new Elysia({ prefix: "/v1/visitors" })
    .post("/", () => {
      const visitor = context.visitors.createVisitor();

      return {
        visitor: context.visitors.toPublic(visitor),
        token: visitor.token,
      };
    });
