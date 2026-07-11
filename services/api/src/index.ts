import { createApp } from "./app";

const port = Number(Bun.env.PORT ?? 3000);
const app = createApp().listen(port);

console.log(
  `Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
