import { createApp } from "./app";
import { loadApiConfig, type ApiConfig } from "./config";
import { createDefaultContext } from "./context";

export const startRuntime = (config: ApiConfig = loadApiConfig()) => {
  const context = createDefaultContext(config);
  const app = createApp(context).listen(config.port);

  try {
    context.maintenance.start();
  } catch (error) {
    void app.stop(true);
    throw error;
  }

  let stopping: Promise<void> | undefined;

  return {
    app,
    stop() {
      if (stopping) return stopping;
      context.maintenance.stop();
      stopping = app.stop(true).then(() => undefined);
      return stopping;
    },
  };
};
