import { expect, test } from "bun:test";
import type { ApiConfig } from "./config";
import { startRuntime } from "./runtime";

const config: ApiConfig = {
  port: 0,
  stunUrls: [],
  corsAllowedOrigins: ["http://localhost:5713"],
  trustProxy: false,
  trustedProxyIps: new Set(),
};

test("runtime owns listening and idempotent shutdown", async () => {
  const runtime = startRuntime(config);
  const server = runtime.app.server;
  expect(server).toBeDefined();
  if (!server) throw new Error("runtime did not start a server");

  const response = await fetch(new URL("/health", server.url));
  expect(response.status).toBe(200);

  const firstStop = runtime.stop();
  const secondStop = runtime.stop();
  expect(secondStop).toBe(firstStop);
  await firstStop;
});
