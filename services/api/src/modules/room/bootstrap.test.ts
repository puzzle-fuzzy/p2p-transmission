import { describe, expect, test } from "bun:test";
import type {
  PublicRoom,
  RtcConfigurationDto,
  RoomInviteCapability,
  RoomJoinRequestReceipt,
} from "@p2p/contracts";
import type { RoomAccessFinalizePlan } from "../room-access/model";
import type { Visitor } from "../visitor/model";
import type { RoomMutationPlan } from "./model";
import {
  createRoomBootstrapService,
  type RoomBootstrapServiceOptions,
} from "./bootstrap";

const sender: Visitor = {
  id: "vis_sender",
  token: "tok_sender",
  avatarSeed: "avatar_sender",
  displayName: "发送者",
  createdAt: 1_000,
  lastSeenAt: 1_000,
};

const receiver: Visitor = {
  id: "vis_receiver",
  token: "tok_receiver",
  avatarSeed: "avatar_receiver",
  displayName: "接收者",
  createdAt: 1_000,
  lastSeenAt: 1_000,
};

const room: PublicRoom = {
  code: "123456",
  senderId: sender.id,
  receivers: [],
  participants: [{
    visitor: {
      id: sender.id,
      avatarSeed: sender.avatarSeed,
      displayName: sender.displayName,
      createdAt: sender.createdAt,
      lastSeenAt: sender.lastSeenAt,
    },
    role: "sender",
    joinedAt: 1_000,
    status: "online",
  }],
  createdAt: 1_000,
  expiresAt: 61_000,
};

const ownerPlan: RoomMutationPlan = {
  id: "plan_create",
  revision: 0,
  kind: "create",
  visitorId: sender.id,
  role: "sender",
  room,
};

const receiverPlan: RoomMutationPlan = {
  id: "plan_join",
  revision: 0,
  kind: "join",
  visitorId: receiver.id,
  role: "receiver",
  room,
};

const invite: RoomInviteCapability = {
  token: `inv_${"A".repeat(43)}`,
  expiresAt: room.expiresAt,
};

const receipt = (
  state: RoomJoinRequestReceipt["state"] = "pending",
): RoomJoinRequestReceipt => ({
  requestId: "request_001",
  state,
  expiresAt: 91_000,
});

const rtcConfiguration: RtcConfigurationDto = {
  iceServers: [{
    urls: ["turn:turn.example.com:3478"],
    username: "361:vis_receiver",
    credential: "signed",
    credentialType: "password",
  }],
};

const createFixture = () => {
  const calls: string[] = [];
  const consumed: string[][] = [];
  const policies: Array<Array<{
    key: string;
    limit: number;
    windowMs: number;
  }>> = [];
  const accessPlan: RoomAccessFinalizePlan = {
    requestId: "request_001",
    roomCode: room.code,
    visitorId: receiver.id,
    revision: 1,
    expiresAt: 31_000,
  };

  const options: RoomBootstrapServiceOptions = {
    maintenance: {
      sweepForAdmission() {
        calls.push("sweep");
        return [];
      },
    },
    visitors: {
      touch(token) {
        calls.push(`touch:${token}`);
        if (token === sender.token) return sender;
        if (token === receiver.token) return receiver;
        return undefined;
      },
    },
    rooms: {
      prepareCreate(token) {
        calls.push(`prepare-create:${token}`);
        return { ok: true, plan: ownerPlan, invite };
      },
      prepareInviteJoin(code, token, inviteToken) {
        calls.push(`prepare-invite:${code}:${token}:${inviteToken}`);
        return { ok: true, plan: receiverPlan };
      },
      prepareReceiverRecovery(code, token) {
        calls.push(`prepare-recovery:${code}:${token}`);
        return { ok: true, plan: receiverPlan };
      },
      prepareApprovedReceiverJoin(code, token) {
        calls.push(`prepare-approved:${code}:${token}`);
        return { ok: true, plan: receiverPlan };
      },
      commit(plan) {
        calls.push(`commit:${plan.id}`);
        return { ok: true, room };
      },
    },
    roomAccess: {
      inspectCreateOrGetPending(code, token) {
        calls.push(`inspect-request:${code}:${token}`);
        return { ok: true, mode: "requestable" };
      },
      createOrGetPending(code, token) {
        calls.push(`request:${code}:${token}`);
        return { ok: true, receipt: receipt() };
      },
      readReceipt(code, requestId, token) {
        calls.push(`read:${code}:${requestId}:${token}`);
        return { ok: true, receipt: receipt() };
      },
      decide(code, requestId, token, decision) {
        calls.push(`decide:${code}:${requestId}:${token}:${decision}`);
        return { ok: true, receipt: receipt(decision === "approve" ? "approved" : "rejected") };
      },
      cancel(code, requestId, token) {
        calls.push(`cancel:${code}:${requestId}:${token}`);
        return { ok: true, receipt: receipt("cancelled") };
      },
      prepareFinalize(code, requestId, token) {
        calls.push(`access-prepare:${code}:${requestId}:${token}`);
        return { ok: true, mode: "commit", plan: accessPlan };
      },
      commitFinalize(plan, commitMembership) {
        calls.push(`access-commit:${plan.requestId}`);
        const committed = commitMembership();
        if (!committed.ok) return committed;
        return { ok: true, receipt: receipt("finalized"), room: committed.room };
      },
    },
    rateLimits: {
      consumeMany(checks) {
        const keys = checks.map(check => check.key);
        calls.push(`limits:${keys.join(",")}`);
        consumed.push(keys);
        policies.push(checks.map(check => ({ ...check })));
        return { ok: true };
      },
    },
    turn: {
      issue(visitorId, expiresAt) {
        calls.push(`turn:${visitorId}:${String(expiresAt)}`);
        return {
          ok: true,
          credential: {
            rtcConfiguration,
            credentialExpiresAt: 361_000,
          },
        };
      },
    },
  };

  return { accessPlan, calls, consumed, options, policies };
};

describe("room bootstrap orchestration", () => {
  test("creates an owner bootstrap after auth and entrance limits", () => {
    const { calls, consumed, options, policies } = createFixture();
    const service = createRoomBootstrapService(options);

    expect(service.createRoom({
      visitorToken: sender.token,
      clientIp: "203.0.113.10",
      iceMode: "api",
    })).toEqual({
      ok: true,
      bootstrap: {
        room,
        invite,
        rtcConfiguration,
        credentialExpiresAt: 361_000,
      },
    });
    expect(calls).toEqual([
      "sweep",
      "touch:tok_sender",
      "limits:room:create:ip:203.0.113.10,room:create:visitor:vis_sender",
      "prepare-create:tok_sender",
      "limits:turn:credential:instance,turn:credential:ip:203.0.113.10,turn:credential:visitor:vis_sender,turn:credential:room:123456",
      "turn:vis_sender:61000",
      "commit:plan_create",
    ]);
    expect(consumed).toEqual([
      [
        "room:create:ip:203.0.113.10",
        "room:create:visitor:vis_sender",
      ],
      [
        "turn:credential:instance",
        "turn:credential:ip:203.0.113.10",
        "turn:credential:visitor:vis_sender",
        "turn:credential:room:123456",
      ],
    ]);
    expect(policies).toEqual([
      [
        { key: "room:create:ip:203.0.113.10", limit: 30, windowMs: 3_600_000 },
        { key: "room:create:visitor:vis_sender", limit: 10, windowMs: 3_600_000 },
      ],
      [
        { key: "turn:credential:instance", limit: 300, windowMs: 60_000 },
        { key: "turn:credential:ip:203.0.113.10", limit: 20, windowMs: 60_000 },
        { key: "turn:credential:visitor:vis_sender", limit: 5, windowMs: 60_000 },
        { key: "turn:credential:room:123456", limit: 30, windowMs: 60_000 },
      ],
    ]);
  });

  test("authorizes invite and recovery before allocating TURN keys", () => {
    for (const admission of [
      { kind: "invite" as const, inviteToken: invite.token },
      { kind: "recovery" as const },
    ]) {
      const { calls, options } = createFixture();
      const service = createRoomBootstrapService(options);

      expect(service.joinRoom({
        code: room.code,
        visitorToken: receiver.token,
        clientIp: "198.51.100.4",
        iceMode: "api",
        admission,
      })).toMatchObject({ ok: true, bootstrap: { room } });
      expect(calls.slice(0, 5)).toEqual([
        "sweep",
        "limits:room:join:ip:198.51.100.4",
        "touch:tok_receiver",
        "limits:room:join:visitor:vis_receiver",
        admission.kind === "invite"
          ? `prepare-invite:123456:tok_receiver:${invite.token}`
          : "prepare-recovery:123456:tok_receiver",
      ]);
      expect(calls.slice(5)).toEqual([
        "limits:turn:credential:instance,turn:credential:ip:198.51.100.4,turn:credential:visitor:vis_receiver,turn:credential:room:123456",
        "turn:vis_receiver:61000",
        "commit:plan_join",
      ]);
    }
  });

  test("an authorization failure never issues TURN or commits membership", () => {
    for (const admission of [
      { kind: "invite" as const, inviteToken: "malformed" },
      { kind: "recovery" as const },
    ]) {
      const { calls, options } = createFixture();
      const denied = () => ({
        ok: false as const,
        error: { code: "ROOM_ACCESS_DENIED" as const, message: "denied" },
      });
      if (admission.kind === "invite") {
        options.rooms.prepareInviteJoin = denied;
      } else {
        options.rooms.prepareReceiverRecovery = denied;
      }
      const service = createRoomBootstrapService(options);

      expect(service.joinRoom({
        code: room.code,
        visitorToken: receiver.token,
        clientIp: "198.51.100.4",
        iceMode: "api",
        admission,
      })).toEqual({
        ok: false,
        error: { code: "ROOM_ACCESS_DENIED", message: "denied" },
      });
      expect(calls).toEqual([
        "sweep",
        "limits:room:join:ip:198.51.100.4",
        "touch:tok_receiver",
        "limits:room:join:visitor:vis_receiver",
      ]);
    }
  });

  test("applies exact request, polling, decision, and cancel policies", () => {
    const { calls, consumed, options, policies } = createFixture();
    const service = createRoomBootstrapService(options);

    expect(service.createJoinRequest({
      code: room.code,
      visitorToken: receiver.token,
      clientIp: "203.0.113.20",
    })).toEqual({ ok: true, receipt: receipt() });
    expect(service.readJoinRequest({
      code: room.code,
      requestId: "request_001",
      visitorToken: receiver.token,
      clientIp: "203.0.113.20",
    })).toEqual({ ok: true, receipt: receipt() });
    expect(service.decideJoinRequest({
      code: room.code,
      requestId: "request_001",
      visitorToken: sender.token,
      clientIp: "203.0.113.10",
      decision: "approve",
    })).toEqual({ ok: true, receipt: receipt("approved") });
    expect(service.cancelJoinRequest({
      code: room.code,
      requestId: "request_001",
      visitorToken: receiver.token,
      clientIp: "203.0.113.20",
    })).toEqual({ ok: true, receipt: receipt("cancelled") });

    expect(consumed).toEqual([
      ["room:join-request:instance", "room:join-request:ip:203.0.113.20"],
      ["room:join-request:visitor:vis_receiver"],
      ["room:join-request:room:123456"],
      ["room:join-request-status:ip:203.0.113.20"],
      ["room:join-request-status:visitor:vis_receiver"],
      ["room:join-request-decision:ip:203.0.113.10"],
      ["room:join-request-decision:sender:vis_sender"],
      ["room:join-request-cancel:ip:203.0.113.20"],
      ["room:join-request-cancel:visitor:vis_receiver"],
    ]);
    expect(calls.indexOf("inspect-request:123456:tok_receiver")).toBeLessThan(
      calls.indexOf("limits:room:join-request:room:123456"),
    );
    expect(calls.indexOf("limits:room:join-request:room:123456")).toBeLessThan(
      calls.indexOf("request:123456:tok_receiver"),
    );
    expect(policies).toEqual([
      [
        { key: "room:join-request:instance", limit: 300, windowMs: 60_000 },
        { key: "room:join-request:ip:203.0.113.20", limit: 10, windowMs: 60_000 },
      ],
      [{ key: "room:join-request:visitor:vis_receiver", limit: 3, windowMs: 60_000 }],
      [{ key: "room:join-request:room:123456", limit: 10, windowMs: 60_000 }],
      [{ key: "room:join-request-status:ip:203.0.113.20", limit: 240, windowMs: 60_000 }],
      [{ key: "room:join-request-status:visitor:vis_receiver", limit: 60, windowMs: 60_000 }],
      [{ key: "room:join-request-decision:ip:203.0.113.10", limit: 60, windowMs: 60_000 }],
      [{ key: "room:join-request-decision:sender:vis_sender", limit: 30, windowMs: 60_000 }],
      [{ key: "room:join-request-cancel:ip:203.0.113.20", limit: 60, windowMs: 60_000 }],
      [{ key: "room:join-request-cancel:visitor:vis_receiver", limit: 20, windowMs: 60_000 }],
    ]);
  });

  test("a lost 202 retry returns the authoritative request and still consumes every policy", () => {
    const { calls, consumed, options } = createFixture();
    let created = false;
    options.roomAccess.inspectCreateOrGetPending = (code, token) => {
      calls.push(`inspect-request:${code}:${token}`);
      return created
        ? { ok: true, mode: "existing", receipt: receipt("approved") }
        : { ok: true, mode: "requestable" };
    };
    options.roomAccess.createOrGetPending = (code, token) => {
      calls.push(`request:${code}:${token}`);
      created = true;
      return { ok: true, receipt: receipt() };
    };
    const service = createRoomBootstrapService(options);
    const input = {
      code: room.code,
      visitorToken: receiver.token,
      clientIp: "203.0.113.20",
    };

    expect(service.createJoinRequest(input)).toEqual({ ok: true, receipt: receipt() });
    expect(service.createJoinRequest(input)).toEqual({
      ok: true,
      receipt: receipt("approved"),
    });
    expect(consumed).toEqual([
      ["room:join-request:instance", "room:join-request:ip:203.0.113.20"],
      ["room:join-request:visitor:vis_receiver"],
      ["room:join-request:room:123456"],
      ["room:join-request:instance", "room:join-request:ip:203.0.113.20"],
      ["room:join-request:visitor:vis_receiver"],
      ["room:join-request:room:123456"],
    ]);
    expect(calls.filter(call =>
      call === "inspect-request:123456:tok_receiver"
    )).toHaveLength(2);
    expect(calls.filter(call => call === "request:123456:tok_receiver")).toHaveLength(1);
  });

  test("stops at the exact admission limit stage that rejects the request", () => {
    for (const blockedKey of [
      "room:join:ip:198.51.100.4",
      "room:join:visitor:vis_receiver",
      "turn:credential:instance",
    ]) {
      const { calls, options } = createFixture();
      options.rateLimits.consumeMany = checks => {
        const keys = checks.map(check => check.key);
        calls.push(`limits:${keys.join(",")}`);
        return keys.includes(blockedKey)
          ? {
              ok: false,
              error: { code: "RATE_LIMITED", message: "limited", retryAfterMs: 1_000 },
            }
          : { ok: true };
      };
      const service = createRoomBootstrapService(options);

      expect(service.joinRoom({
        code: room.code,
        visitorToken: receiver.token,
        clientIp: "198.51.100.4",
        iceMode: "api",
        admission: { kind: "invite", inviteToken: invite.token },
      })).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });

      if (blockedKey === "room:join:ip:198.51.100.4") {
        expect(calls).toEqual([
          "sweep",
          "limits:room:join:ip:198.51.100.4",
        ]);
      } else if (blockedKey === "room:join:visitor:vis_receiver") {
        expect(calls).toEqual([
          "sweep",
          "limits:room:join:ip:198.51.100.4",
          "touch:tok_receiver",
          "limits:room:join:visitor:vis_receiver",
        ]);
      } else {
        expect(calls).toEqual([
          "sweep",
          "limits:room:join:ip:198.51.100.4",
          "touch:tok_receiver",
          "limits:room:join:visitor:vis_receiver",
          `prepare-invite:123456:tok_receiver:${invite.token}`,
          "limits:turn:credential:instance,turn:credential:ip:198.51.100.4,turn:credential:visitor:vis_receiver,turn:credential:room:123456",
        ]);
      }
    }
  });

  test("an offline sender does not consume a room key or create a request", () => {
    const { calls, consumed, options } = createFixture();
    options.roomAccess.inspectCreateOrGetPending = (code, token) => {
      calls.push(`inspect-request:${code}:${token}`);
      return {
        ok: false,
        error: {
          code: "ROOM_REQUEST_UNAVAILABLE",
          message: "房间不存在或暂时无法接收申请",
        },
      };
    };
    const service = createRoomBootstrapService(options);

    expect(service.createJoinRequest({
      code: room.code,
      visitorToken: receiver.token,
      clientIp: "203.0.113.20",
    })).toEqual({
      ok: false,
      error: {
        code: "ROOM_REQUEST_UNAVAILABLE",
        message: "房间不存在或暂时无法接收申请",
      },
    });
    expect(consumed).toEqual([
      ["room:join-request:instance", "room:join-request:ip:203.0.113.20"],
      ["room:join-request:visitor:vis_receiver"],
    ]);
    expect(calls).toContain("inspect-request:123456:tok_receiver");
    expect(calls).not.toContain("limits:room:join-request:room:123456");
    expect(calls).not.toContain("request:123456:tok_receiver");
  });

  test("finalizes approved membership atomically after TURN succeeds", () => {
    const { calls, consumed, options, policies } = createFixture();
    const service = createRoomBootstrapService(options);

    expect(service.finalizeJoinRequest({
      code: room.code,
      requestId: "request_001",
      visitorToken: receiver.token,
      clientIp: "203.0.113.20",
      iceMode: "api",
    })).toMatchObject({ ok: true, bootstrap: { room } });
    expect(calls).toEqual([
      "sweep",
      "limits:room:join:ip:203.0.113.20",
      "touch:tok_receiver",
      "limits:room:join:visitor:vis_receiver",
      "access-prepare:123456:request_001:tok_receiver",
      "prepare-approved:123456:tok_receiver",
      "limits:turn:credential:instance,turn:credential:ip:203.0.113.20,turn:credential:visitor:vis_receiver,turn:credential:room:123456",
      "turn:vis_receiver:61000",
      "access-commit:request_001",
      "commit:plan_join",
    ]);
    expect(consumed[0]).toEqual(["room:join:ip:203.0.113.20"]);
    expect(consumed[1]).toEqual(["room:join:visitor:vis_receiver"]);
    expect(policies).toEqual([
      [{ key: "room:join:ip:203.0.113.20", limit: 60, windowMs: 60_000 }],
      [{ key: "room:join:visitor:vis_receiver", limit: 20, windowMs: 60_000 }],
      [
        { key: "turn:credential:instance", limit: 300, windowMs: 60_000 },
        { key: "turn:credential:ip:203.0.113.20", limit: 20, windowMs: 60_000 },
        { key: "turn:credential:visitor:vis_receiver", limit: 5, windowMs: 60_000 },
        { key: "turn:credential:room:123456", limit: 30, windowMs: 60_000 },
      ],
    ]);
  });

  test("a room change after approval leaves the request unfinalized", () => {
    const { calls, options } = createFixture();
    options.rooms.prepareApprovedReceiverJoin = (code, token) => {
      calls.push(`prepare-approved:${code}:${token}`);
      return {
        ok: false,
        error: { code: "ROOM_NOT_FOUND", message: "closed" },
      };
    };
    const service = createRoomBootstrapService(options);

    expect(service.finalizeJoinRequest({
      code: room.code,
      requestId: "request_001",
      visitorToken: receiver.token,
      clientIp: "203.0.113.20",
      iceMode: "api",
    })).toEqual({
      ok: false,
      error: { code: "ROOM_NOT_FOUND", message: "closed" },
    });
    expect(calls).not.toContain("access-commit:request_001");
    expect(calls.some(call => call.startsWith("turn:"))).toBe(false);
  });

  test("uses ordinary receiver recovery for an already finalized receipt", () => {
    const { calls, options } = createFixture();
    options.roomAccess.prepareFinalize = (code, requestId, token) => {
      calls.push(`access-prepare:${code}:${requestId}:${token}`);
      return { ok: true, mode: "recovery", receipt: receipt("finalized") };
    };
    const service = createRoomBootstrapService(options);

    expect(service.finalizeJoinRequest({
      code: room.code,
      requestId: "request_001",
      visitorToken: receiver.token,
      clientIp: "203.0.113.20",
      iceMode: "off",
    })).toMatchObject({ ok: true, bootstrap: { room } });
    expect(calls).toEqual([
      "sweep",
      "limits:room:join:ip:203.0.113.20",
      "touch:tok_receiver",
      "limits:room:join:visitor:vis_receiver",
      "access-prepare:123456:request_001:tok_receiver",
      "prepare-recovery:123456:tok_receiver",
      "commit:plan_join",
    ]);
  });

  test("TURN and room commit failures leave finalize uncommitted", () => {
    for (const failure of ["turn", "room"] as const) {
      const { calls, options } = createFixture();
      if (failure === "turn") {
        options.turn.issue = () => ({
          ok: false,
          error: { code: "TURN_NOT_CONFIGURED", message: "missing" },
        });
      } else {
        options.rooms.commit = plan => {
          calls.push(`commit:${plan.id}`);
          return {
            ok: false,
            error: { code: "INVALID_STATE", message: "changed" },
          };
        };
      }
      const service = createRoomBootstrapService(options);

      expect(service.finalizeJoinRequest({
        code: room.code,
        requestId: "request_001",
        visitorToken: receiver.token,
        clientIp: "203.0.113.20",
        iceMode: "api",
      })).toMatchObject({ ok: false });
      if (failure === "turn") {
        expect(calls).not.toContain("access-commit:request_001");
      } else {
        expect(calls).toContain("access-commit:request_001");
        expect(calls).toContain("commit:plan_join");
      }
    }
  });
});
