import { closeIdleThreadSessions, repairInterruptedRuns } from "@alldots/agent-runtime";
import {
  assertRuntimeRole,
  createPool,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  resolveBlobStorageDir,
  startProcessHeartbeat,
  startTenantDeactivationListener,
} from "@alldots/data";
import { wireRealtimeHooks } from "@alldots/realtime";
import { installFatalHandlers } from "@alldots/shared";
import { createAiGatewayClientForAgents } from "./actionRegistryComposition.js";
import { createAgentRunTask, createRunAgentForHeartbeats } from "./agentRunTasks.js";
import { createInFlightAgentRuns } from "./inFlightAgentRuns.js";
import { createGatewayModel } from "./modelComposition.js";
import { createAgentsQueueRuntime } from "./queueRuntime.js";
import { createGracefulShutdown, registerShutdownSignals } from "./shutdown.js";
import { createSempMessageTask } from "./sempMessageTask.js";
import { startSempTurnCancelWiring } from "./sempTurnCancelListener.js";
import { logger } from "./logger.js";

// Installed first, so a startup failure still logs fatally and exits non-zero.
installFatalHandlers(logger);

// Agent tools dispatch to the choke point in-process, so this process authenticates as
// `alldots_data` via ALLDOTS_API_DATABASE_URL; `DATABASE_URL` is the local-development fallback.
const connectionString = process.env.ALLDOTS_API_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("ALLDOTS_API_DATABASE_URL (or DATABASE_URL) is not set");

const pool = createPool(connectionString);
await assertRuntimeRole(pool);

// Wired before the queue can claim a job, so no write goes unpublished (the defaults are no-ops).
wireRealtimeHooks(pool);

startProcessHeartbeat(
  pool,
  { process: "agents", pid: process.pid, version: process.env.APP_VERSION ?? "0.0.0" },
  { onError: (err) => logger.error({ err }, "Failed to record this process's heartbeat") },
);

const moduleRegistry = await loadFullModuleRegistry();

// Every run still `running` was abandoned by the previous process; close them before the queue
// runner can claim a job that touches them. A failure here is fatal.
const { repairedRunIds } = await repairInterruptedRuns(pool);
logger.info({ repairedRunCount: repairedRunIds.length }, "Repaired interrupted agent runs");

// Hosts every `queueAffinity: 'agents'` task and no crontab. `createGatewayModel` throws on missing
// gateway configuration, so the process refuses to start without it.
const gateway = createGatewayModel(process.env);
const inFlightAgentRuns = createInFlightAgentRuns();
const queueRuntime = await createAgentsQueueRuntime(pool, moduleRegistry, {
  // For the answer-expected gate of the `newEmail` heartbeat.
  aiGateway: createAiGatewayClientForAgents(process.env),
  runAgent: createRunAgentForHeartbeats(pool, moduleRegistry, gateway, inFlightAgentRuns),
  agentRunTask: createAgentRunTask(pool, moduleRegistry, gateway, inFlightAgentRuns),
  delegatedAgentRunTask: createAgentRunTask(pool, moduleRegistry, gateway, inFlightAgentRuns),
  sempMessageTask: createSempMessageTask(pool, moduleRegistry, gateway, inFlightAgentRuns, {
    files: new LocalFsBlobStorageWriter(resolveBlobStorageDir("FILES_STORAGE_DIR")),
    mailAttachments: new LocalFsBlobStorageWriter(resolveBlobStorageDir("MAIL_ATTACHMENTS_DIR")),
  }),
});

// A run already executing when its tenant leaves `active` is aborted here and closes as `error`;
// the listener resyncs every deactivated tenant on connect, so a run starting in the gap is covered.
const tenantDeactivationListener = await startTenantDeactivationListener(pool, async (tenantId) => {
  const aborted = inFlightAgentRuns.abortTenant(tenantId);
  if (aborted > 0) logger.info({ tenantId, aborted }, "Aborted in-flight agent runs of a deactivated tenant");
});

// A voice stop command cancels one running turn: the request arrives as a notification (`requestSempTurnCancel`), and
// `abortTurn` ignores one for a turn this process does not run.
const sempTurnCancelListener = await startSempTurnCancelWiring(pool, inFlightAgentRuns);

const shutdown = createGracefulShutdown({
  queueRuntime,
  // Both listeners close inside the one bounded close of the shutdown sequence.
  tenantDeactivationListener: {
    close: async () => {
      await Promise.all([sempTurnCancelListener.close(), tenantDeactivationListener.close()]);
    },
  },
  pool,
  logger,
  closeIdleThreadSessions,
  abortSempTurns: () => {
    inFlightAgentRuns.abortSemp();
  },
  observeSempSettlement: () => inFlightAgentRuns.observeSempSettlement(),
});
registerShutdownSignals(shutdown);

logger.info({}, "alldots-agents queue runtime started");
