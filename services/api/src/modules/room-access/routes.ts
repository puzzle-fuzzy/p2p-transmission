import { Elysia, t } from "elysia";
import type { AppContext } from "../../context";
import {
  bootstrapResponse,
  iceModeSchema,
  roomAccessResponse,
  roomCodeParamsSchema,
  tokenFromHeaders,
} from "../room/routes";

const requestParamsSchema = t.Object({
  code: t.String({ pattern: "^[0-9]{6}$" }),
  requestId: t.String({ minLength: 1, maxLength: 96 }),
}, { additionalProperties: false });

const decisionBodySchema = t.Object({
  decision: t.Union([
    t.Literal("approve"),
    t.Literal("reject"),
  ]),
}, { additionalProperties: false });

const finalizeBodySchema = t.Object({
  iceMode: iceModeSchema,
}, { additionalProperties: false });

export const roomAccessRoutes = (context: AppContext) =>
  new Elysia({ prefix: "/v1/rooms" })
    .post("/:code/join-requests", ({ headers, params, request, server, set, status }) => {
      const result = context.roomBootstrap.createJoinRequest({
        code: params.code,
        visitorToken: tokenFromHeaders(headers),
        clientIp: context.clientIp.resolve({
          directAddress: server?.requestIP(request)?.address,
          headers,
        }),
      });
      return roomAccessResponse(result, set, status, 202);
    }, {
      params: roomCodeParamsSchema,
    })
    .get("/:code/join-requests/:requestId", (
      { headers, params, request, server, set, status },
    ) => {
      const result = context.roomBootstrap.readJoinRequest({
        code: params.code,
        requestId: params.requestId,
        visitorToken: tokenFromHeaders(headers),
        clientIp: context.clientIp.resolve({
          directAddress: server?.requestIP(request)?.address,
          headers,
        }),
      });
      return roomAccessResponse(result, set, status);
    }, {
      params: requestParamsSchema,
    })
    .post("/:code/join-requests/:requestId/decision", (
      { body, headers, params, request, server, set, status },
    ) => {
      const result = context.roomBootstrap.decideJoinRequest({
        code: params.code,
        requestId: params.requestId,
        visitorToken: tokenFromHeaders(headers),
        clientIp: context.clientIp.resolve({
          directAddress: server?.requestIP(request)?.address,
          headers,
        }),
        decision: body.decision,
      });
      return roomAccessResponse(result, set, status);
    }, {
      params: requestParamsSchema,
      body: decisionBodySchema,
    })
    .post("/:code/join-requests/:requestId/finalize", (
      { body, headers, params, request, server, set, status },
    ) => {
      const result = context.roomBootstrap.finalizeJoinRequest({
        code: params.code,
        requestId: params.requestId,
        visitorToken: tokenFromHeaders(headers),
        clientIp: context.clientIp.resolve({
          directAddress: server?.requestIP(request)?.address,
          headers,
        }),
        iceMode: body.iceMode,
      });
      return bootstrapResponse(result, set, status);
    }, {
      params: requestParamsSchema,
      body: finalizeBodySchema,
    })
    .post("/:code/join-requests/:requestId/cancel", (
      { headers, params, request, server, set, status },
    ) => {
      const result = context.roomBootstrap.cancelJoinRequest({
        code: params.code,
        requestId: params.requestId,
        visitorToken: tokenFromHeaders(headers),
        clientIp: context.clientIp.resolve({
          directAddress: server?.requestIP(request)?.address,
          headers,
        }),
      });
      return roomAccessResponse(result, set, status);
    }, {
      params: requestParamsSchema,
    });
