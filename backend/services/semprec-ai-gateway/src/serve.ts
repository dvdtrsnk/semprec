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

const dispatch = createDispatcher(pool, config.handlerOptions, config.audioHandlerOptions);

const server = createServer(dispatch);

const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger });
registerShutdownSignals(shutdown);

// Issue #174: bound to loopback explicitly — this process is never a public entry point, only
// `semprec-api` reaches it, over `http://127.0.0.1:${AI_GATEWAY_PORT}/internal/complete`.
server.listen(config.port, "127.0.0.1", () => {
  logger.info({ port: config.port }, "semprec-ai-gateway listening");
});
