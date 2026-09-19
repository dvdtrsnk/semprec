import { createPool, loadFullModuleRegistry, startProcessHeartbeat } from "@semprec/data";
import { installFatalHandlers } from "@semprec/shared";
import { createAgentsQueueRuntime } from "./queueRuntime.js";
import { createGracefulShutdown, registerShutdownSignals } from "./shutdown.js";
import { logger } from "./logger.js";

// Installed before anything else runs: an uncaught exception or unhandled rejection during
// startup (pool creation, module-registry load, queue-runtime startup validation) must still log
// fatally and exit non-zero rather than crash silently or hang.
installFatalHandlers(logger);

// SEMPREC_SIDE_DATABASE_URL is the shared key every `semprec_side`-role process authenticates
// with (issue #175's `/opt/semprec/shared/.env`; see
// docs/adr/2026-09-17-two-tier-runtime-database-roles.md) — this process is never
// `semprec_data`. `DATABASE_URL` remains the fallback for local development, where a developer
// runs this service alone against its own per-service `.env`.
const connectionString = process.env.SEMPREC_SIDE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("SEMPREC_SIDE_DATABASE_URL (or DATABASE_URL) is not set");

const pool = createPool(connectionString);

// Issue #168: this process's own `process_heartbeats` row, re-UPSERTed every 15 seconds for as
// long as this process is up.
startProcessHeartbeat(
  pool,
  { process: "agents", pid: process.pid, version: process.env.APP_VERSION ?? "0.0.0" },
  { onError: (err) => logger.error({ err }, "Failed to record this process's heartbeat") },
);

const moduleRegistry = await loadFullModuleRegistry();

// Issue #91: this process is the queue's second composition root — it hosts every
// `queueAffinity: 'agents'` task handler over this same pool, and installs no crontab of its own.
const queueRuntime = await createAgentsQueueRuntime(pool, moduleRegistry);

const shutdown = createGracefulShutdown({ queueRuntime, pool, logger });
registerShutdownSignals(shutdown);

logger.info({}, "semprec-agents queue runtime started");
