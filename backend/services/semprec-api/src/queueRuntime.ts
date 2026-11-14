import type { Pool } from "pg";
import { replayApprovedGenericOperation } from "@semprec/application";
import { ensureQueueSchema, grantQueueSchemaPrivileges, runWorker } from "@semprec/queue";
import {
  CORE_CRONTAB,
  createLibraryMetadataFetcher,
  assertTaskListMatchesAffinity,
  createApiCoreTaskList,
  createMailTransportFactory,
  mergeModuleTaskListForAffinity,
  resolveTaskAffinitySets,
  runHeartbeatFireQueueSplitMigration,
  setEventInvitationDelivery,
  setThreadProjectTriageRuntime,
  setThreadTaskPeopleDelivery,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createApiActionRegistry } from "./actionRegistryComposition.js";
import { createMailSyncAdapters, readOAuthClient } from "./mailSyncAdapters.js";
import { createAiGatewayClientForApi } from "./projectAgentGuidanceComposition.js";

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
 * The heartbeat action registry is populated by `createApiActionRegistry` with every seeded
 * api-affinity action (issue #641), and every `approvalExecute` job for an approved
 * generic-operation request replays through `replayApprovedGenericOperation` (issue #646). The
 * mail jobs resolve the mail databases' ids themselves, per job or per tenant pass, inside that
 * tenant's scope (`resolveMailModuleIds`): nothing is captured at boot, so this starts on a
 * database the mail module is not seeded in, and a tenant without those databases fails only the
 * job that needs them, naming the missing module ids and the seed CLI. Gmail, Graph and IMAP mail
 * accounts sync through the transports `createMailSyncAdapters` builds (#1505, #1508, #1510).
 * The remaining adapters (mail blob storage, a legacy raw-MIME fetcher, push senders) stay on
 * `createApiCoreTaskList`'s own defaults here — wiring one in is each adapter's own composition-root
 * concern once it exists. The calendar's `calendarSendEventInvitation` module task sends through the mail
 * transports `createMailTransportFactory` builds from the same Gmail and Microsoft OAuth client keys; this root
 * binds them with `setEventInvitationDelivery` before the runner starts and unbinds them in `stop()`
 * (docs/adr/2026-11-12-module-queue-tasks-read-their-composition-root-dependencies-from-a-binding.md). The mail
 * module's `mailTriageThreadProject` task (issue gh-1872) reads the pool and the gateway client of this root the same way
 * (`setThreadProjectTriageRuntime`), and its `mailSyncThreadTaskPeople` task (issue gh-1923) opens its transactions on
 * `pool` through `setThreadTaskPeopleDelivery`, bound and unbound the same way. The same transports are handed to
 * `createApiCoreTaskList`, so that the `approvalExecute` job sends an approved mail send of an agent (issue gh-1913)
 * through them, reading attachments from the list's default blob storage.
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

  const gmail = readOAuthClient(process.env, "GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET");
  const graph = readOAuthClient(process.env, "MS_GRAPH_OAUTH_CLIENT_ID", "MS_GRAPH_OAUTH_CLIENT_SECRET");
  const mailTransports = createMailTransportFactory(pool, {
    ...("clientId" in gmail ? { gmailOAuthClient: gmail } : {}),
    ...("clientId" in graph ? { graphOAuthClient: graph } : {}),
  });
  const actionRegistry = createApiActionRegistry(pool, moduleRegistry);
  const aiGateway = createAiGatewayClientForApi();
  const coreTaskList = createApiCoreTaskList(
    pool,
    actionRegistry,
    createLibraryMetadataFetcher({ tmdbToken: process.env.TMDB_READ_TOKEN }),
    createMailSyncAdapters({ pool, env: process.env }), // mailSyncAdapters: Gmail, Graph and IMAP
    undefined, // mailBlobStorage
    undefined, // legacyRawMimeFetcher
    moduleRegistry,
    undefined, // pushSenders
    replayApprovedGenericOperation,
    undefined, // filesBlobStorage
    undefined, // tenantBlobStorageDirs
    aiGateway,
    mailTransports, // mailSendTransports: where an approved mail send of an agent leaves
  );
  const taskList = await mergeModuleTaskListForAffinity(coreTaskList, moduleRegistry, "api");

  // Before this runner reports readiness (returns from `run()` below), prove its registered
  // handler set matches exactly what the shared affinity resolution says the API runtime owns —
  // an actionable error here, not a silently incomplete or cross-affinity runner.
  const affinitySets = await resolveTaskAffinitySets(moduleRegistry);
  assertTaskListMatchesAffinity(taskList, affinitySets.api, "api");

  setEventInvitationDelivery({ pool, transports: mailTransports });
  setThreadProjectTriageRuntime({ pool, gateway: aiGateway });
  setThreadTaskPeopleDelivery({ pool });
  let runner: Awaited<ReturnType<typeof runWorker>>;
  try {
    runner = await runWorker({
      pgPool: pool,
      taskList,
      crontab: options.crontab ?? CORE_CRONTAB,
      noHandleSignals: true,
    });
  } catch (error) {
    setEventInvitationDelivery(null);
    setThreadProjectTriageRuntime(null);
    setThreadTaskPeopleDelivery(null);
    throw error;
  }

  let stopped: Promise<void> | null = null;
  return {
    stop(): Promise<void> {
      stopped ??= runner.stop().finally(() => {
        setEventInvitationDelivery(null);
        setThreadProjectTriageRuntime(null);
        setThreadTaskPeopleDelivery(null);
      });
      return stopped;
    },
  };
}
