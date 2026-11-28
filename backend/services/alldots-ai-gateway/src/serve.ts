import { assertRuntimeRole, createPool, startProcessHeartbeat } from "@alldots/data";
import { installFatalHandlers } from "@alldots/shared";
import { createGatewayServer } from "./gatewayServer.js";
import { resolveStartupConfig } from "./startupConfig.js";
import { createGracefulShutdown, registerShutdownSignals } from "./shutdown.js";
import { logger } from "./logger.js";

installFatalHandlers(logger);

const config = resolveStartupConfig(process.env);

const pool = createPool(config.databaseUrl);
await assertRuntimeRole(pool);

const heartbeat = startProcessHeartbeat(
  pool,
  { process: "ai-gateway", pid: process.pid, version: process.env.APP_VERSION ?? "0.0.0" },
  { onError: (err) => logger.error({ err }, "Failed to record this process's heartbeat") },
);

// Wires the realtime hooks over this pool before the server can accept a request (see createGatewayServer).
const { server, sttStreams } = createGatewayServer(pool, config);

const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger, closeStreams: () => sttStreams.closeAll() });
registerShutdownSignals(shutdown);

// Loopback only: this process is never a public entry point.
server.listen(config.port, "127.0.0.1", () => {
  logger.info({ port: config.port }, "alldots-ai-gateway listening");
});
