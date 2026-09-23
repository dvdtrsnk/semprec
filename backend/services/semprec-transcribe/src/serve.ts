import { createPool, loadFullModuleRegistry, startProcessHeartbeat } from "@semprec/data";
import { wireRealtimeHooks } from "@semprec/realtime";
import { installFatalHandlers } from "@semprec/shared";
import { logger } from "./logger.js";
import { createTranscribeQueueRuntime } from "./queueRuntime.js";
import { createGracefulShutdown, registerShutdownSignals } from "./shutdown.js";

installFatalHandlers(logger);
const connectionString = process.env.SEMPREC_API_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("SEMPREC_API_DATABASE_URL (or DATABASE_URL) is not set");
const pool = createPool(connectionString);
// This process writes Transcripts rows through the in-process choke point, so it publishes their
// invalidations itself: without this, the generic realtime channel would never hear of them.
wireRealtimeHooks(pool);
startProcessHeartbeat(
  pool,
  { process: "transcribe", pid: process.pid, version: process.env.APP_VERSION ?? "0.0.0" },
  { onError: (err) => logger.error({ err }, "Failed to record this process's heartbeat") },
);
const moduleRegistry = await loadFullModuleRegistry();
const queueRuntime = await createTranscribeQueueRuntime(pool, moduleRegistry);
registerShutdownSignals(createGracefulShutdown({ queueRuntime, pool, logger }));
logger.info({}, "semprec-transcribe queue runtime started");
