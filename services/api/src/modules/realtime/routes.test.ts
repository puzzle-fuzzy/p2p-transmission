import { expect, test } from "bun:test";
import { MAX_REALTIME_PAYLOAD_BYTES } from "../../app";
import type { ApiConfig } from "../../config";
import { startRuntime } from "../../runtime";

const config: ApiConfig = {
  port: 0,
  stunUrls: [],
  corsAllowedOrigins: ["http://localhost:5713"],
  trustProxy: false,
  trustedProxyIps: new Set(),
};

const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label}`)),
      2_000,
    );
    void promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const connectRealtime = async (serverUrl: URL) => {
  const created = await fetch(new URL("/v1/visitors", serverUrl), {
    method: "POST",
  });
  expect(created.status).toBe(200);
  const { token } = await created.json() as { token: string };
  const ticketResponse = await fetch(new URL("/v1/realtime/tickets", serverUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(ticketResponse.status).toBe(200);
  const { ticket } = await ticketResponse.json() as { ticket: string };
  const url = new URL("/v1/realtime", serverUrl);
  url.protocol = "ws:";
  url.searchParams.set("ticket", ticket);

  const queued: string[] = [];
  const waiting: Array<(message: string) => void> = [];
  const socket = new WebSocket(url, {
    // Bun accepts upgrade headers here; the DOM declaration only exposes the
    // browser protocols overload used by production clients.
    // @ts-expect-error Bun-specific WebSocket client options.
    headers: { origin: "http://localhost:5713" },
  });
  socket.addEventListener("message", event => {
    const message = String(event.data);
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else queued.push(message);
  });

  await withTimeout(new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Realtime socket failed to open")),
      { once: true },
    );
  }), "realtime open");

  const nextMessage = () => withTimeout(new Promise<string>(resolve => {
    const message = queued.shift();
    if (message !== undefined) resolve(message);
    else waiting.push(resolve);
  }), "realtime message");

  expect(JSON.parse(await nextMessage())).toMatchObject({ type: "visitor:ready" });
  return { nextMessage, socket };
};

const closeSocket = async (socket: WebSocket) => {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>(resolve => {
    socket.addEventListener("close", () => resolve(), { once: true });
  });
  socket.close();
  await withTimeout(closed, "realtime close");
};

test("realtime validation never reflects malformed or secret-bearing frames", async () => {
  const runtime = startRuntime(config);
  const server = runtime.app.server;
  expect(server).toBeDefined();
  if (!server) throw new Error("runtime did not start a server");
  let socket: WebSocket | undefined;

  try {
    const connected = await connectRealtime(server.url);
    socket = connected.socket;
    const secret = "inv_DO_NOT_REFLECT_THIS_SECRET";
    const expected = {
      type: "error",
      code: "INVALID_REALTIME_MESSAGE",
      message: "实时消息格式无效",
    };

    socket.send(JSON.stringify({
      type: "room:attach",
      roomCode: "123456",
      role: "receiver",
      inviteToken: secret,
    }));
    const extraFieldResponse = await connected.nextMessage();
    expect(extraFieldResponse).not.toContain(secret);
    expect(JSON.parse(extraFieldResponse)).toEqual(expected);

    socket.send(
      `{"type":"room:attach","roomCode":"123456","inviteToken":"${secret}"`,
    );
    const malformedResponse = await connected.nextMessage();
    expect(malformedResponse).not.toContain(secret);
    expect(JSON.parse(malformedResponse)).toEqual(expected);
  } finally {
    if (socket) await closeSocket(socket);
    await runtime.stop();
  }
});

test("realtime signaling schemas reject oversized and invalid fields", async () => {
  const runtime = startRuntime(config);
  const server = runtime.app.server;
  expect(server).toBeDefined();
  if (!server) throw new Error("runtime did not start a server");
  let socket: WebSocket | undefined;

  try {
    const connected = await connectRealtime(server.url);
    socket = connected.socket;
    const invalidFrames = [
      { type: "room:attach", roomCode: "１２３４５６", role: "receiver" },
      {
        type: "signal:offer",
        roomCode: "123456",
        to: "visitor",
        peerSessionId: "peer",
        description: { type: "offer", sdp: "s".repeat(262_145) },
      },
      {
        type: "signal:offer",
        roomCode: "123456",
        to: "v".repeat(97),
        peerSessionId: "peer",
        description: { type: "offer", sdp: "sdp" },
      },
      {
        type: "signal:offer",
        roomCode: "123456",
        to: "visitor",
        peerSessionId: "p".repeat(97),
        description: { type: "offer", sdp: "sdp" },
      },
      {
        type: "signal:ice",
        roomCode: "123456",
        to: "visitor",
        peerSessionId: "peer",
        candidate: {
          candidate: "c".repeat(4_097),
          sdpMid: "0",
          sdpMLineIndex: 0,
          usernameFragment: null,
        },
      },
      {
        type: "signal:ice",
        roomCode: "123456",
        to: "visitor",
        peerSessionId: "peer",
        candidate: {
          candidate: "candidate",
          sdpMid: "m".repeat(257),
          sdpMLineIndex: 0,
          usernameFragment: null,
        },
      },
      {
        type: "signal:ice",
        roomCode: "123456",
        to: "visitor",
        peerSessionId: "peer",
        candidate: {
          candidate: "candidate",
          sdpMid: "0",
          sdpMLineIndex: 0,
          usernameFragment: "u".repeat(257),
        },
      },
      {
        type: "signal:ice",
        roomCode: "123456",
        to: "visitor",
        peerSessionId: "peer",
        candidate: {
          candidate: "candidate",
          sdpMid: "0",
          sdpMLineIndex: 0.5,
          usernameFragment: null,
        },
      },
    ];

    for (const frame of invalidFrames) {
      socket.send(JSON.stringify(frame));
      expect(JSON.parse(await connected.nextMessage())).toEqual({
        type: "error",
        code: "INVALID_REALTIME_MESSAGE",
        message: "实时消息格式无效",
      });
    }
  } finally {
    if (socket) await closeSocket(socket);
    await runtime.stop();
  }
});

test("runtime closes a realtime connection above the payload limit", async () => {
  const runtime = startRuntime(config);
  const server = runtime.app.server;
  expect(server).toBeDefined();
  if (!server) throw new Error("runtime did not start a server");
  let socket: WebSocket | undefined;

  try {
    const connected = await connectRealtime(server.url);
    socket = connected.socket;
    const closed = new Promise<void>(resolve => {
      socket?.addEventListener("close", () => resolve(), { once: true });
    });

    socket.send("x".repeat(MAX_REALTIME_PAYLOAD_BYTES + 1));
    await withTimeout(closed, "oversized realtime close");
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  } finally {
    if (socket) await closeSocket(socket);
    await runtime.stop();
  }
});
