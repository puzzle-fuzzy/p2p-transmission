import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCoturnConfig } from "./render-coturn-config";

const temporaryDirectories: string[] = [];
const sharedSecret = "0123456789abcdef0123456789abcdef";

const environment = () => ({
  TURN_SHARED_SECRET: sharedSecret,
  TURN_REALM: "turn.example.com",
  TURN_EXTERNAL_IP: "203.0.113.10/10.0.0.10",
  TURN_TLS_CERT_PATH: "/run/coturn/tls/fullchain.pem",
  TURN_TLS_PRIVATE_KEY_PATH: "/run/coturn/tls/privkey.pem",
  TURN_LISTENING_PORT: "3478",
  TURN_TLS_LISTENING_PORT: "5349",
  TURN_RELAY_PORT_MIN: "49160",
  TURN_RELAY_PORT_MAX: "49259",
});

const createOutputPath = async () => {
  const root = await mkdtemp(join(tmpdir(), "p2p-coturn-config-"));
  temporaryDirectories.push(root);
  return join(root, ".local", "turnserver.conf");
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })),
  );
});

describe("coturn config generator", () => {
  test("renders into an injected temporary destination without leftover files", async () => {
    const outputPath = await createOutputPath();

    await generateCoturnConfig({ environment: environment(), outputPath });

    const rendered = await readFile(outputPath, "utf8");
    expect(rendered).toContain(`static-auth-secret=${sharedSecret}\n`);
    expect(rendered).toContain("realm=turn.example.com\n");
    expect(await readdir(join(outputPath, ".."))).toEqual(["turnserver.conf"]);

    await generateCoturnConfig({
      environment: { ...environment(), TURN_REALM: "relay.example.com" },
      outputPath,
    });
    expect(await readFile(outputPath, "utf8")).toContain("realm=relay.example.com\n");
    expect(await readdir(join(outputPath, ".."))).toEqual(["turnserver.conf"]);

    if (process.platform !== "win32") {
      expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("validates required values and port strings before writing", async () => {
    const outputPath = await createOutputPath();

    await expect(generateCoturnConfig({
      environment: { ...environment(), TURN_REALM: "" },
      outputPath,
    })).rejects.toThrow("TURN_REALM is required");
    await expect(generateCoturnConfig({
      environment: { ...environment(), TURN_LISTENING_PORT: "3478udp" },
      outputPath,
    })).rejects.toThrow("TURN_LISTENING_PORT must be a whole number");
    await expect(readFile(outputPath, "utf8")).rejects.toThrow();
  });
});
