import { createServer } from "node:http";
import { createPool, startProcessHeartbeat } from "@semprec/data";
import { installFatalHandlers } from "@semprec/shared";
import { createDispatcher } from "./app.js";
import { resolveStartupConfig } from "./startupConfig.js";
import { createGracefulShutdown, registerShutdownSignals } from "./shutdown.js";
import { logger } from "./logger.js";

installFatalHandlers(logger);

const config = resolveStartupConfig(process.env);

const pool = createPool(config.databaseUrl);

// Issue #168: this process's own `process_heartbeats` row, re-UPSERTed every 15 seconds for as
// long as this process is up.
const heartbeat = startProcessHeartbeat(
  pool,
  { process: "ai-gateway", pid: process.pid, version: process.env.APP_VERSION ?? "0.0.0" },
  { onError: (err) => logger.error({ err }, "Failed to record this process's heartbeat") },
);

const dispatch = createDispatcher(pool, config.handlerOptions);

const server = createServer(dispatch);

const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger });
registerShutdownSignals(shutdown);

server.listen(config.port, () => {
  logger.info({ port: config.port }, "semprec-ai-gateway listening");
});
