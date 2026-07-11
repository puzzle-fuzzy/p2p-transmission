import { startRuntime } from "./runtime";

const runtime = startRuntime();

console.log(
  `Elysia is running at ${runtime.app.server?.hostname}:${runtime.app.server?.port}`,
);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void runtime.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
