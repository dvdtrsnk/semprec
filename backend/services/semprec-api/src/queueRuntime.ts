import type { Pool } from "pg";
import { replayApprovedGenericOperation } from "@semprec/application";
import { runWorker } from "@semprec/queue";
import {
  CORE_CRONTAB,
  createLibraryMetadataFetcher,
  assertTaskListMatchesAffinity,
  createApiCoreTaskList,
  createMailTransportFactory,
  mergeModuleTaskListForAffinity,
  resolveTaskAffinitySets,
  setEventInvitationDelivery,
  setGoogleCalendarSyncRuntime,
  setGraphCalendarSyncRuntime,
  setCalendarPushRuntime,
  setInvitationReplyDelivery,
  setThreadProjectTriageRuntime,
  setThreadTaskPeopleDelivery,
  installQueueSchema,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createApiActionRegistry } from "./actionRegistryComposition.js";
import { resolveCalendarPushRuntime } from "./calendarPushComposition.js";
import { createMailSyncAdapters, readOAuthClient } from "./mailSyncAdapters.js";
import { createAiGatewayClientForApi } from "./projectAgentGuidanceComposition.js";

export interface ApiQueueRuntimeOptions {
  /** Tests use a faster cadence to observe a sweep. */
  crontab?: string;
}

export interface ApiQueueRuntime {
  /** Idempotent. Never closes `pool`; `serve.ts` owns it. */
  stop(): Promise<void>;
}

/**
 * The one long-lived graphile-worker runner hosting every `queueAffinity: 'api'` handler (core/data
 * tasks plus active modules' api tasks), and the only runtime that installs `CORE_CRONTAB`, so the
 * two queue consumers share exactly one scheduler.
 *
 * Heartbeat actions come from `createApiActionRegistry`; `approvalExecute` jobs replay through
 * `replayApprovedGenericOperation`. Mail jobs resolve the mail database ids per job inside the
 * tenant's scope, so nothing is captured at boot and a tenant without them fails only the job that
 * needs them. Mail accounts sync through `createMailSyncAdapters`; other adapters keep
 * `createApiCoreTaskList`'s defaults.
 *
 * Module tasks that need composition-root dependencies get them through bindings set before the
 * runner starts and cleared in `stop()`: the calendar invitation and reply senders
 * (`setEventInvitationDelivery`, `setInvitationReplyDelivery`, over the mail transports), the
 * thread project triage (`setThreadProjectTriageRuntime`), the thread task people sync
 * (`setThreadTaskPeopleDelivery`), the Google calendar sync, over the Gmail OAuth client
 * (`setGoogleCalendarSyncRuntime`), and the Microsoft calendar sync's token refresh
 * (`setGraphCalendarSyncRuntime`, only with the Graph OAuth client configured), and the calendar push channels
 * (`setCalendarPushRuntime`, `resolveCalendarPushRuntime`). The same transports are handed to
 * `createApiCoreTaskList`, so an approved agent mail send goes through them.
 */
export async function createApiQueueRuntime(
  pool: Pool,
  moduleRegistry: ModuleRegistry,
  options: ApiQueueRuntimeOptions = {},
): Promise<ApiQueueRuntime> {
  await installQueueSchema(pool);

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
    createMailSyncAdapters({ pool, env: process.env }), // mailSyncAdapters
    undefined, // mailBlobStorage
    moduleRegistry,
    undefined, // pushSenders
    replayApprovedGenericOperation,
    undefined, // filesBlobStorage
    undefined, // tenantBlobStorageDirs
    aiGateway,
    mailTransports, // mailSendTransports: where an approved agent mail send leaves
  );
  const taskList = await mergeModuleTaskListForAffinity(coreTaskList, moduleRegistry, "api");

  // Before reporting readiness, prove the registered handler set matches what affinity resolution
  // says the API runtime owns: an actionable error instead of a silently incomplete or
  // cross-affinity runner.
  const affinitySets = await resolveTaskAffinitySets(moduleRegistry);
  assertTaskListMatchesAffinity(taskList, affinitySets.api, "api");

  setEventInvitationDelivery({ pool, transports: mailTransports });
  setInvitationReplyDelivery({ pool, transports: mailTransports });
  setThreadProjectTriageRuntime({ pool, gateway: aiGateway });
  setThreadTaskPeopleDelivery({ pool });
  setGoogleCalendarSyncRuntime("clientId" in gmail ? { pool, ...gmail } : null);
  setGraphCalendarSyncRuntime("clientId" in graph ? { pool, ...graph } : null);
  setCalendarPushRuntime(resolveCalendarPushRuntime(pool, process.env, { gmail, graph }));
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
    setInvitationReplyDelivery(null);
    setThreadProjectTriageRuntime(null);
    setThreadTaskPeopleDelivery(null);
    setGoogleCalendarSyncRuntime(null);
    setGraphCalendarSyncRuntime(null);
    setCalendarPushRuntime(null);
    throw error;
  }

  let stopped: Promise<void> | null = null;
  return {
    stop(): Promise<void> {
      stopped ??= runner.stop().finally(() => {
        setEventInvitationDelivery(null);
        setInvitationReplyDelivery(null);
        setThreadProjectTriageRuntime(null);
        setThreadTaskPeopleDelivery(null);
        setGoogleCalendarSyncRuntime(null);
        setGraphCalendarSyncRuntime(null);
        setCalendarPushRuntime(null);
      });
      return stopped;
    },
  };
}
