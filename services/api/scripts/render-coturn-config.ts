import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { CoturnConfigInput } from "../src/modules/turn/model";
import { renderCoturnConfig } from "../src/modules/turn/coturn-config";

type CoturnConfigEnvironment = Readonly<Record<string, string | undefined>>;

export type GenerateCoturnConfigOptions = {
  environment?: CoturnConfigEnvironment;
  outputPath?: string;
};

const defaultOutputPath = resolve(
  import.meta.dir,
  "../../../deploy/coturn/.local/turnserver.conf",
);

const requiredValue = (
  environment: CoturnConfigEnvironment,
  key: string,
) => {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
};

const requiredSecret = (environment: CoturnConfigEnvironment) => {
  const secret = environment.TURN_SHARED_SECRET;
  if (!secret) throw new Error("TURN_SHARED_SECRET is required");
  return secret;
};

const optionalPort = (
  environment: CoturnConfigEnvironment,
  key: string,
) => {
  const value = environment[key]?.trim();
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/u.test(value)) throw new Error(`${key} must be a whole number`);

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${key} must be between 1 and 65535`);
  }
  return port;
};

const readConfigInput = (
  environment: CoturnConfigEnvironment,
): CoturnConfigInput => ({
  sharedSecret: requiredSecret(environment),
  realm: requiredValue(environment, "TURN_REALM"),
  externalIp: requiredValue(environment, "TURN_EXTERNAL_IP"),
  certificatePath: requiredValue(environment, "TURN_TLS_CERT_PATH"),
  privateKeyPath: requiredValue(environment, "TURN_TLS_PRIVATE_KEY_PATH"),
  listeningPort: optionalPort(environment, "TURN_LISTENING_PORT"),
  tlsListeningPort: optionalPort(environment, "TURN_TLS_LISTENING_PORT"),
  relayPortMin: optionalPort(environment, "TURN_RELAY_PORT_MIN"),
  relayPortMax: optionalPort(environment, "TURN_RELAY_PORT_MAX"),
});

const writeAtomicPrivateFile = async (outputPath: string, content: string) => {
  const outputDirectory = dirname(outputPath);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);

  const temporaryPath = resolve(
    outputDirectory,
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;

    await rename(temporaryPath, outputPath);
    await chmod(outputPath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const generateCoturnConfig = async ({
  environment = Bun.env,
  outputPath = defaultOutputPath,
}: GenerateCoturnConfigOptions = {}) => {
  const rendered = renderCoturnConfig(readConfigInput(environment));
  await writeAtomicPrivateFile(outputPath, rendered);
};

if (import.meta.main) {
  try {
    await generateCoturnConfig();
  } catch {
    // Do not include environment values or renderer output in CLI diagnostics.
    console.error("Unable to generate coturn configuration; check the required TURN environment variables.");
    process.exitCode = 1;
  }
}
