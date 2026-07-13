import { describe, expect, test } from "bun:test";
import { createRoomService, type RoomService } from "../room/service";
import { createVisitorService, type VisitorService } from "../visitor/service";
import type { RoomResult } from "../room/model";
import type {
  RoomAccessFinalizePlan,
  RoomAccessTransition,
} from "./model";
import { createRoomAccessService, type RoomAccessService } from "./service";

type Harness = {
  access: RoomAccessService;
  rooms: RoomService;
  visitors: VisitorService;
  setTime(value: number): void;
  createOnlineRoom(): {
    code: string;
    sender: ReturnType<VisitorService["createVisitor"]>;
  };
};

const createHarness = (options: {
  requestIds?: string[];
  requestTtlMs?: number;
  approvedTtlMs?: number;
  tombstoneTtlMs?: number;
  maxPendingPerRoom?: number;
} = {}): Harness => {
  let timestamp = 1_000;
  let visitorSequence = 0;
  let roomSequence = 123_455;
  let requestSequence = 0;
  const requestIds = options.requestIds ?? [];
  const visitors = createVisitorService({
    now: () => timestamp,
    createId: () => `vis_${++visitorSequence}`,
    createToken: () => `tok_${visitorSequence}`,
    createAvatarSeed: () => `avatar_${visitorSequence}`,
  });
  const rooms = createRoomService({
    visitors,
    now: () => timestamp,
    createCode: () => String(++roomSequence),
    createPlanId: () => `room-plan-${roomSequence}-${requestSequence}`,
  });
  const access = createRoomAccessService({
    rooms,
    visitors,
    now: () => timestamp,
    createRequestId: () => {
      const requestId = requestIds[requestSequence]
        ?? `request-${String(requestSequence + 1).padStart(2, "0")}`;
      requestSequence += 1;
      return requestId;
    },
    requestTtlMs: options.requestTtlMs,
    approvedTtlMs: options.approvedTtlMs,
    tombstoneTtlMs: options.tombstoneTtlMs,
    maxPendingPerRoom: options.maxPendingPerRoom,
  });

  return {
    access,
    rooms,
    visitors,
    setTime(value) {
      timestamp = value;
    },
    createOnlineRoom() {
      const sender = visitors.createVisitor();
      const prepared = rooms.prepareCreate(sender.token);
      if (!prepared.ok) throw new Error("expected room preparation to succeed");
      const committed = rooms.commit(prepared.plan);
      if (!committed.ok) throw new Error("expected room commit to succeed");
      const attached = rooms.attach(committed.room.code, sender.id, "sender");
      if (!attached.ok) throw new Error("expected sender attach to succeed");
      return { code: committed.room.code, sender };
    },
  };
};

const expectReceipt = (
  result: ReturnType<RoomAccessService["readReceipt"]>,
) => {
  if (!result.ok) throw new Error(`expected receipt, received ${result.error.code}`);
  return result.receipt;
};

describe("room access service", () => {
  test("creates one idempotent request per retained room/visitor index", () => {
    const harness = createHarness();
    const { code } = harness.createOnlineRoom();
    const receiver = harness.visitors.createVisitor();
    const transitions: RoomAccessTransition[] = [];
    harness.access.subscribe(transition => transitions.push(transition));

    const first = harness.access.createOrGetPending(code, receiver.token);
    const replay = harness.access.createOrGetPending(code, receiver.token);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      ok: true,
      receipt: { requestId: "request-01", state: "pending", expiresAt: 91_000 },
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      type: "room:join-requested",
      request: { requestId: "request-01", roomCode: code },
    });
  });

  test("inspects without creating or publishing and keeps an existing receipt after sender leaves", () => {
    const harness = createHarness();
    const { code, sender } = harness.createOnlineRoom();
    const receiver = harness.visitors.createVisitor();
    const transitions: RoomAccessTransition[] = [];
    harness.access.subscribe(transition => transitions.push(transition));

    expect(harness.access.inspectCreateOrGetPending(code, receiver.token)).toEqual({
      ok: true,
      mode: "requestable",
    });
    expect(transitions).toEqual([]);
    const created = harness.access.createOrGetPending(code, receiver.token);
    if (!created.ok) throw new Error("expected request");
    expect(transitions).toHaveLength(1);

    expect(harness.rooms.leave(code, sender.id).ok).toBe(true);
    expect(harness.access.inspectCreateOrGetPending(code, receiver.token)).toEqual({
      ok: true,
      mode: "existing",
      receipt: created.receipt,
    });
    expect(transitions).toHaveLength(1);
  });

  test("retains the idempotency index through approval and terminal tombstones", () => {
    const harness = createHarness();
    const { code, sender } = harness.createOnlineRoom();
    const receiver = harness.visitors.createVisitor();
    const created = harness.access.createOrGetPending(code, receiver.token);
    if (!created.ok) throw new Error("expected request");

    expect(harness.access.decide(
      code,
      created.receipt.requestId,
      sender.token,
      "approve",
    )).toMatchObject({ ok: true, receipt: { state: "approved" } });
    expect(harness.access.createOrGetPending(code, receiver.token)).toMatchObject({
      ok: true,
      receipt: { requestId: created.receipt.requestId, state: "approved" },
    });
    expect(harness.access.cancel(
      code,
      created.receipt.requestId,
      receiver.token,
    )).toMatchObject({ ok: true, receipt: { state: "cancelled" } });
    expect(harness.access.createOrGetPending(code, receiver.token)).toMatchObject({
      ok: true,
      receipt: { requestId: created.receipt.requestId, state: "cancelled" },
    });

    harness.setTime(31_000);
    expect(harness.access.createOrGetPending(code, receiver.token)).toMatchObject({
      ok: true,
      receipt: { requestId: "request-02", state: "pending" },
    });
  });

  test("enforces five pending requests while allowing a new request after resolution", () => {
    const harness = createHarness();
    const { code, sender } = harness.createOnlineRoom();
    const requests = Array.from({ length: 6 }, () => {
      const receiver = harness.visitors.createVisitor();
      return { receiver, result: harness.access.createOrGetPending(code, receiver.token) };
    });

    expect(requests.slice(0, 5).every(({ result }) => result.ok)).toBe(true);
    expect(harness.access.inspectCreateOrGetPending(
      code,
      requests[5]!.receiver.token,
    )).toEqual({
      ok: false,
      error: {
        code: "ROOM_REQUEST_UNAVAILABLE",
        message: "房间不存在或暂时无法接收申请",
      },
    });
    expect(requests[5]?.result).toEqual({
      ok: false,
      error: {
        code: "ROOM_REQUEST_UNAVAILABLE",
        message: "房间不存在或暂时无法接收申请",
      },
    });

    const first = requests[0]?.result;
    if (!first?.ok) throw new Error("expected request");
    harness.access.decide(code, first.receipt.requestId, sender.token, "reject");
    expect(harness.access.createOrGetPending(
      code,
      requests[5]!.receiver.token,
    ).ok).toBe(true);
  });

  test("returns the same unavailable error for missing, closed, offline, and invalid applicant rooms", () => {
    const harness = createHarness();
    const receiver = harness.visitors.createVisitor();
    const unavailable = {
      ok: false,
      error: {
        code: "ROOM_REQUEST_UNAVAILABLE",
        message: "房间不存在或暂时无法接收申请",
      },
    } as const;

    expect(harness.access.createOrGetPending("999999", receiver.token)).toEqual(unavailable);

    const offlineSender = harness.visitors.createVisitor();
    const prepared = harness.rooms.prepareCreate(offlineSender.token);
    if (!prepared.ok) throw new Error("expected room");
    const offlineRoom = harness.rooms.commit(prepared.plan);
    if (!offlineRoom.ok) throw new Error("expected room");
    expect(harness.access.createOrGetPending(
      offlineRoom.room.code,
      receiver.token,
    )).toEqual(unavailable);

    const online = harness.createOnlineRoom();
    expect(harness.access.createOrGetPending(online.code, online.sender.token)).toEqual(unavailable);
    harness.rooms.leave(online.code, online.sender.id);
    expect(harness.access.createOrGetPending(online.code, receiver.token)).toEqual(unavailable);
  });

  test("rejects an unknown visitor before inspecting room availability", () => {
    const harness = createHarness();

    expect(harness.access.inspectCreateOrGetPending(
      "999999",
      "missing-token",
    )).toEqual({
      ok: false,
      error: { code: "VISITOR_NOT_FOUND", message: "访客不存在或已过期" },
    });
    expect(harness.access.createOrGetPending("999999", "missing-token")).toEqual({
      ok: false,
      error: { code: "VISITOR_NOT_FOUND", message: "访客不存在或已过期" },
    });
  });

  test("lists only pending requests in stable createdAt then requestId order", () => {
    const harness = createHarness({ requestIds: ["request-b", "request-a"] });
    const { code, sender } = harness.createOnlineRoom();
    const first = harness.visitors.createVisitor();
    const second = harness.visitors.createVisitor();
    harness.access.createOrGetPending(code, first.token);
    harness.access.createOrGetPending(code, second.token);

    expect(harness.access.listPendingForSender(code, sender.token)).toMatchObject({
      ok: true,
      requests: [
        { requestId: "request-a", visitor: { id: second.id } },
        { requestId: "request-b", visitor: { id: first.id } },
      ],
    });
  });

  test("hides receipts and decisions from actors not bound to the request", () => {
    const harness = createHarness();
    const { code, sender } = harness.createOnlineRoom();
    const receiver = harness.visitors.createVisitor();
    const outsider = harness.visitors.createVisitor();
    const created = harness.access.createOrGetPending(code, receiver.token);
    if (!created.ok) throw new Error("expected request");
    const hidden = {
      ok: false,
      error: {
        code: "ROOM_JOIN_REQUEST_NOT_FOUND",
        message: "加入申请不存在或已失效",
      },
    } as const;

    expect(harness.access.readReceipt(
      code,
      created.receipt.requestId,
      outsider.token,
    )).toEqual(hidden);
    expect(harness.access.cancel(
      code,
      created.receipt.requestId,
      outsider.token,
    )).toEqual(hidden);
    expect(harness.access.decide(
      code,
      created.receipt.requestId,
      outsider.token,
      "approve",
    )).toEqual(hidden);
    expect(harness.access.listPendingForSender(code, outsider.token)).toEqual(hidden);
    expect(harness.access.decide(
      code,
      created.receipt.requestId,
      sender.token,
      "approve",
    ).ok).toBe(true);
  });

  test("uses exact request and tombstone deadline boundaries", () => {
    const harness = createHarness();
    const { code } = harness.createOnlineRoom();
    const receiver = harness.visitors.createVisitor();
    const created = harness.access.createOrGetPending(code, receiver.token);
    if (!created.ok) throw new Error("expected request");

    harness.setTime(90_999);
    expect(expectReceipt(harness.access.readReceipt(
      code,
      created.receipt.requestId,
      receiver.token,
    )).state).toBe("pending");

    harness.setTime(91_000);
    expect(expectReceipt(harness.access.readReceipt(
      code,
      created.receipt.requestId,
      receiver.token,
    ))).toEqual({
      requestId: created.receipt.requestId,
      state: "expired",
      expiresAt: 121_000,
    });

    harness.setTime(120_999);
    expect(expectReceipt(harness.access.readReceipt(
      code,
      created.receipt.requestId,
      receiver.token,
    )).state).toBe("expired");

    harness.setTime(121_000);
    expect(harness.access.readReceipt(
      code,
      created.receipt.requestId,
      receiver.token,
    )).toMatchObject({ ok: false, error: { code: "ROOM_JOIN_REQUEST_NOT_FOUND" } });
  });

  test("approves for thirty seconds and keeps conflicting actions idempotent", () => {
    const harness = createHarness();
    const { code, sender } = harness.createOnlineRoom();
    const receiver = harness.visitors.createVisitor();
    const transitions: RoomAccessTransition[] = [];
    harness.access.subscribe(transition => transitions.push(transition));
    const created = harness.access.createOrGetPending(code, receiver.token);
    if (!created.ok) throw new Error("expected request");

    harness.setTime(5_000);
    expect(harness.access.decide(
      code,
      created.receipt.requestId,
      sender.token,
      "approve",
    )).toEqual({
      ok: true,
      receipt: {
        requestId: created.receipt.requestId,
        state: "approved",
        expiresAt: 35_000,
      },
    });
    expect(harness.access.decide(
      code,
      created.receipt.requestId,
      sender.token,
      "reject",
    )).toMatchObject({ ok: true, receipt: { state: "approved" } });

    expect(harness.access.cancel(
      code,
      created.receipt.requestId,
      receiver.token,
    )).toMatchObject({ ok: true, receipt: { state: "cancelled", expiresAt: 35_000 } });
    expect(harness.access.cancel(
      code,
      created.receipt.requestId,
      receiver.token,
    )).toMatchObject({ ok: true, receipt: { state: "cancelled" } });
    expect(transitions.map(transition => transition.type)).toEqual([
      "room:join-requested",
      "room:join-request-resolved",
      "room:join-request-resolved",
    ]);
  });

  test("maps every finalize state to its authoritative result", () => {
    const harness = createHarness();
    const { code, sender } = harness.createOnlineRoom();
    const pendingReceiver = harness.visitors.createVisitor();
    const rejectedReceiver = harness.visitors.createVisitor();
    const pending = harness.access.createOrGetPending(code, pendingReceiver.token);
    const rejected = harness.access.createOrGetPending(code, rejectedReceiver.token);
    if (!pending.ok || !rejected.ok) throw new Error("expected requests");

    expect(harness.access.prepareFinalize(
      code,
      pending.receipt.requestId,
      pendingReceiver.token,
    )).toMatchObject({
      ok: false,
      error: { code: "ROOM_JOIN_REQUEST_NOT_APPROVED" },
    });
    harness.access.decide(code, rejected.receipt.requestId, sender.token, "reject");
    expect(harness.access.prepareFinalize(
      code,
      rejected.receipt.requestId,
      rejectedReceiver.token,
    )).toMatchObject({
      ok: false,
      error: { code: "ROOM_JOIN_REQUEST_REJECTED" },
    });
    harness.access.cancel(code, pending.receipt.requestId, pendingReceiver.token);
    expect(harness.access.prepareFinalize(
      code,
      pending.receipt.requestId,
      pendingReceiver.token,
    )).toMatchObject({
      ok: false,
      error: { code: "ROOM_JOIN_REQUEST_CANCELLED" },
    });
  });

  test("expires approved requests exactly at the finalize deadline", () => {
    const harness = createHarness();
    const { code, sender } = harness.createOnlineRoom();
    const receiver = harness.visitors.createVisitor();
    const created = harness.access.createOrGetPending(code, receiver.token);
    if (!created.ok) throw new Error("expected request");
    harness.access.decide(code, created.receipt.requestId, sender.token, "approve");

    harness.setTime(30_999);
    expect(harness.access.prepareFinalize(
      code,
      created.receipt.requestId,
      receiver.token,
    )).toMatchObject({ ok: true, mode: "commit" });
    harness.setTime(31_000);
    expect(harness.access.prepareFinalize(
      code,
      created.receipt.requestId,
      receiver.token,
    )).toMatchObject({
      ok: false,
      error: { code: "ROOM_JOIN_REQUEST_EXPIRED" },
    });
  });

  test("accepts only an unchanged opaque finalize plan and invokes it once", () => {
    const harness = createHarness();
    const { code, sender } = harness.createOnlineRoom();
    const receiver = harness.visitors.createVisitor();
    const created = harness.access.createOrGetPending(code, receiver.token);
    if (!created.ok) throw new Error("expected request");
    harness.access.decide(code, created.receipt.requestId, sender.token, "approve");
    const prepared = harness.access.prepareFinalize(
      code,
      created.receipt.requestId,
      receiver.token,
    );
    if (!prepared.ok || prepared.mode !== "commit") throw new Error("expected plan");
    let calls = 0;
    const room = harness.rooms.getInternalRoomSnapshot(code);
    if (!room.ok) throw new Error("expected room");
    const commit = (): RoomResult => {
      calls += 1;
      return room;
    };
    const forged = { ...prepared.plan } satisfies RoomAccessFinalizePlan;

    expect(harness.access.commitFinalize(forged, commit)).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE" },
    });
    expect(calls).toBe(0);
    (prepared.plan as { revision: number }).revision += 1;
    expect(harness.access.commitFinalize(prepared.plan, commit)).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE" },
    });
    expect(calls).toBe(0);
    expect(harness.access.commitFinalize(prepared.plan, commit)).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE" },
    });
    expect(calls).toBe(0);
  });

  test("leaves approval intact after membership failure and consumes that plan", () => {
    const harness = createHarness();
    const { code, sender } = harness.createOnlineRoom();
    const receiver = harness.visitors.createVisitor();
    const created = harness.access.createOrGetPending(code, receiver.token);
    if (!created.ok) throw new Error("expected request");
    harness.access.decide(code, created.receipt.requestId, sender.token, "approve");
    const prepared = harness.access.prepareFinalize(
      code,
      created.receipt.requestId,
      receiver.token,
    );
    if (!prepared.ok || prepared.mode !== "commit") throw new Error("expected plan");
    const failure: RoomResult = {
      ok: false,
      error: { code: "ROOM_NOT_FOUND", message: "房间不存在或已过期" },
    };

    expect(harness.access.commitFinalize(prepared.plan, () => failure)).toEqual(failure);
    expect(expectReceipt(harness.access.readReceipt(
      code,
      created.receipt.requestId,
      receiver.token,
    )).state).toBe("approved");
    expect(harness.access.commitFinalize(prepared.plan, () => {
      throw new Error("must not run");
    })).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
  });

  test("marks finalized before safe publication and does not reread time afterward", () => {
    const harness = createHarness();
    const { code, sender } = harness.createOnlineRoom();
    const receiver = harness.visitors.createVisitor();
    const created = harness.access.createOrGetPending(code, receiver.token);
    if (!created.ok) throw new Error("expected request");
    harness.access.decide(code, created.receipt.requestId, sender.token, "approve");
    const prepared = harness.access.prepareFinalize(
      code,
      created.receipt.requestId,
      receiver.token,
    );
    if (!prepared.ok || prepared.mode !== "commit") throw new Error("expected plan");
    const observed: RoomAccessTransition[] = [];
    harness.access.subscribe(transition => {
      if (transition.type === "room:join-request-resolved" && transition.state === "finalized") {
        observed.push(transition);
      }
    });
    harness.access.subscribe(() => {
      throw new Error("subscriber failure");
    });
    const room = harness.rooms.getInternalRoomSnapshot(code);
    if (!room.ok) throw new Error("expected room");

    const result = harness.access.commitFinalize(prepared.plan, () => {
      harness.setTime(1_000_000);
      return room;
    });

    expect(result).toMatchObject({
      ok: true,
      receipt: { state: "finalized", expiresAt: 31_000 },
      room: { code },
    });
    expect(observed).toHaveLength(1);
    harness.setTime(1_000);
    expect(harness.access.prepareFinalize(
      code,
      created.receipt.requestId,
      receiver.token,
    )).toMatchObject({ ok: true, mode: "recovery" });
  });

  test("rejects plans invalidated by cancellation, expiry, or a winning finalize", () => {
    const harness = createHarness();
    const { code, sender } = harness.createOnlineRoom();
    const receiver = harness.visitors.createVisitor();
    const created = harness.access.createOrGetPending(code, receiver.token);
    if (!created.ok) throw new Error("expected request");
    harness.access.decide(code, created.receipt.requestId, sender.token, "approve");
    const first = harness.access.prepareFinalize(code, created.receipt.requestId, receiver.token);
    const second = harness.access.prepareFinalize(code, created.receipt.requestId, receiver.token);
    if (!first.ok || first.mode !== "commit" || !second.ok || second.mode !== "commit") {
      throw new Error("expected plans");
    }
    const room = harness.rooms.getInternalRoomSnapshot(code);
    if (!room.ok) throw new Error("expected room");

    let calls = 0;
    expect(harness.access.commitFinalize(first.plan, () => {
      expect(harness.access.cancel(
        code,
        created.receipt.requestId,
        receiver.token,
      )).toMatchObject({ ok: true, receipt: { state: "approved" } });
      expect(harness.access.commitFinalize(second.plan, () => {
        calls += 1;
        return room;
      })).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
      return room;
    }).ok).toBe(true);
    expect(calls).toBe(0);
  });

  test("cleans deadlines, missing rooms, and removed visitors without duplicate publication", () => {
    const harness = createHarness();
    const firstRoom = harness.createOnlineRoom();
    const firstReceiver = harness.visitors.createVisitor();
    const first = harness.access.createOrGetPending(firstRoom.code, firstReceiver.token);
    if (!first.ok) throw new Error("expected request");
    const secondRoom = harness.createOnlineRoom();
    const secondReceiver = harness.visitors.createVisitor();
    const second = harness.access.createOrGetPending(secondRoom.code, secondReceiver.token);
    if (!second.ok) throw new Error("expected request");
    const observed: RoomAccessTransition[] = [];
    harness.access.subscribe(transition => observed.push(transition));
    harness.access.subscribe(() => {
      throw new Error("ignored listener failure");
    });

    harness.rooms.leave(firstRoom.code, firstRoom.sender.id);
    harness.visitors.remove(secondReceiver.id);
    const transitions = harness.access.cleanupExpiredState();

    expect(transitions).toHaveLength(2);
    expect(transitions.every(transition =>
      transition.type === "room:join-request-resolved"
      && transition.state === "expired"
    )).toBe(true);
    expect(observed).toEqual(transitions);
    expect(harness.access.cleanupExpiredState()).toEqual([]);
  });

  test("removeVisitor expires every active request owned by a sender or receiver", () => {
    const harness = createHarness();
    const { code, sender } = harness.createOnlineRoom();
    const first = harness.visitors.createVisitor();
    const second = harness.visitors.createVisitor();
    harness.access.createOrGetPending(code, first.token);
    harness.access.createOrGetPending(code, second.token);

    const receiverTransitions = harness.access.removeVisitor(first.id);
    expect(receiverTransitions).toHaveLength(1);
    const senderTransitions = harness.access.removeVisitor(sender.id);
    expect(senderTransitions).toHaveLength(1);
    expect(harness.access.removeVisitor(sender.id)).toEqual([]);
  });

  test("validates lifecycle configuration", () => {
    const harness = createHarness();
    expect(() => createRoomAccessService({
      rooms: harness.rooms,
      visitors: harness.visitors,
      requestTtlMs: 0,
    })).toThrow("Request TTL must be a positive safe integer");
    expect(() => createRoomAccessService({
      rooms: harness.rooms,
      visitors: harness.visitors,
      maxPendingPerRoom: 1.5,
    })).toThrow("Pending request capacity must be a positive safe integer");
  });
});
