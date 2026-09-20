import type { Pool } from "pg";
import { ensureQueueSchema, grantQueueSchemaPrivileges, runWorker } from "@semprec/queue";
import {
  CORE_CRONTAB,
  assertTaskListMatchesAffinity,
  createActionRegistry,
  createApiCoreTaskList,
  mergeModuleTaskListForAffinity,
  resolveTaskAffinitySets,
  runHeartbeatFireQueueSplitMigration,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";

export interface ApiQueueRuntimeOptions {
  /** Overrides `CORE_CRONTAB` — tests use a faster cadence to observe a sweep without waiting on the real one. */
  crontab?: string;
}

export interface ApiQueueRuntime {
  /** Idempotent: awaits `runner.stop()` exactly once. Never closes `pool` — the caller (`serve.ts`) owns that. */
  stop(): Promise<void>;
}

/**
 * Issue #91's `api` composition root: the one long-lived graphile-worker runner that installs
 * `CORE_CRONTAB` and hosts every `queueAffinity: 'api'` handler — core/data tasks plus active
 * modules' api-affinity tasks. The only one of #91's two composition roots that installs a
 * crontab; `semprec-agents`' (`services/semprec-agents/src/queueRuntime.ts`) never does, so two
 * consumers share this queue with exactly one scheduler between them.
 *
 * Real adapters (an external library-metadata fetcher, a mail sync transport, push senders, a
 * generic-operation approval replay) stay on `createApiCoreTaskList`'s own no-op defaults here —
 * wiring one in is each adapter's own composition-root concern once it exists, not new business
 * logic this issue adds.
 */
export async function createApiQueueRuntime(
  pool: Pool,
  moduleRegistry: ModuleRegistry,
  options: ApiQueueRuntimeOptions = {},
): Promise<ApiQueueRuntime> {
  await ensureQueueSchema(pool);
  await grantQueueSchemaPrivileges(pool);
  // Issue #222's one-time cutover for any job still queued under the legacy `heartbeatFire`
  // name — runs exactly once, here, at API install; the agents runtime never runs it.
  await runHeartbeatFireQueueSplitMigration(pool);

  const actionRegistry = createActionRegistry();
  const coreTaskList = createApiCoreTaskList(
    pool,
    actionRegistry,
    undefined, // libraryMetadataFetcher
    undefined, // mailSyncAdapters
    undefined, // mailModuleIds
    undefined, // mailBlobStorage
    undefined, // legacyRawMimeFetcher
    moduleRegistry,
  );
  const taskList = await mergeModuleTaskListForAffinity(coreTaskList, moduleRegistry, "api");

  // Before this runner reports readiness (returns from `run()` below), prove its registered
  // handler set matches exactly what the shared affinity resolution says the API runtime owns —
  // an actionable error here, not a silently incomplete or cross-affinity runner.
  const affinitySets = await resolveTaskAffinitySets(moduleRegistry);
  assertTaskListMatchesAffinity(taskList, affinitySets.api, "api");

  const runner = await runWorker({
    pgPool: pool,
    taskList,
    crontab: options.crontab ?? CORE_CRONTAB,
    noHandleSignals: true,
  });

  let stopped: Promise<void> | null = null;
  return {
    stop(): Promise<void> {
      stopped ??= runner.stop();
      return stopped;
    },
  };
}
