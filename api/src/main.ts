import { env, assertSafeBootConfig } from "./lib/env.ts";
import { buildApp } from "./app.ts";
import { closePool } from "./lib/db.ts";
import { SessionManager } from "./worker/sessionManager.ts";

assertSafeBootConfig();

const manager = env.runWorker ? new SessionManager() : undefined;
const app = await buildApp({ manager });

await app.listen({ port: env.port, host: env.host });
if (manager) {
  manager.start(app.log);
  app.log.info("worker started: holding WhatsApp sockets for every linked account");
} else {
  app.log.info("RUN_WORKER=false: serving the API only, no WhatsApp sockets");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (async () => {
      app.log.info(`${signal} received, shutting down`);
      await manager?.stopAll();
      await app.close();
      await closePool();
      process.exit(0);
    })();
  });
}
