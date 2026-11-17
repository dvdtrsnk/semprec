import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { AgentRunDisplayStatus } from "../agentRuns/agentRunDisplayStatus.js";
import { getAgentRunDetail, getAgentRunReplyOutcome } from "../agentRuns/agentRunDetail.js";
import { agentRunErrorFields } from "../agentRuns/agentRunErrorSummary.js";
import { getAgentRun } from "../agentRuns/agentRunsStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { findTickThread } from "../semp/sempTickThreadStore.js";
import { formatHeartbeatRuleLabel } from "./heartbeatRuleLabel.js";
import { findLiveProject } from "./heartbeatRunScope.js";
import {
  listHeartbeatsByProject,
  listLastFinishedOccurrenceRuns,
  type HeartbeatRow,
  type LastFinishedOccurrenceRun,
} from "./schedulerStore.js";

/**
 * Duck-typed shape of `semprec-api`'s custom-route mount. The adapter authenticates a session first (an
 * agent run credential never reaches here) and runs the handler inside the session's tenant.
 */
interface CustomRouteRequestContext {
  params: Record<string, string>;
  identity: { user: { locale: string } };
}

type CustomRouteResult = { status: number; body: unknown };

export type LastOccurrenceStatus = "ok" | "waiting_approval" | "failed";

/** When it was due, how its run ended and, for a failure, why. */
export interface LastOccurrence {
  at: string;
  status: LastOccurrenceStatus;
  errorSummary: string | null;
}

export interface ProjectHeartbeatBody {
  id: string;
  name: string;
  rule: HeartbeatRow["rule"];
  ruleLabel: string;
  enabled: boolean;
  nextFireAt: string | null;
  lastOccurrence: LastOccurrence | null;
  threadId: string | null;
}

const projectIdSchema = z.uuid();

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/** Loaded once per process; a failed load is not cached, so the next request retries. */
function getSeedCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(
    new URL("../seed/systemDatabasesModuleManifest.js", import.meta.url).href,
  ).catch((err: unknown) => {
    catalogsPromise = undefined;
    throw err;
  });
  return catalogsPromise;
}

/**
 * Maps a finished run's display status: failures (including a reply with a failed tool call) are
 * `failed`, a pending approval `waiting_approval`, anything else `ok`. `running` means the run changed
 * since `listLastFinishedOccurrenceRuns` read it and is refused rather than misreported.
 */
export function lastOccurrenceStatusOf(displayStatus: AgentRunDisplayStatus): LastOccurrenceStatus {
  switch (displayStatus) {
    case "error":
      return "failed";
    case "waiting_approval":
      return "waiting_approval";
    case "done":
      return "ok";
    case "running":
      throw new Error("The latest occurrence of a heartbeat has a run that is still running");
  }
}

/**
 * Derived from the run's display status, not from `heartbeat_occurrences.status` (which only says the
 * fire task finished) or raw `last_error`. The summary is the localized text of the run's error code
 * or incomplete reply.
 */
async function readLastOccurrence(
  client: PoolClient,
  last: LastFinishedOccurrenceRun,
  locale: string,
): Promise<LastOccurrence> {
  const run = await getAgentRun(client, last.runId);
  // The run was listed earlier in this transaction, so its absence is a data inconsistency, not a client error.
  if (!run) throw new Error("The run of the latest occurrence of a heartbeat is missing");
  // One reply read for both the display status and the summary, as `GET /api/agent-runs/:id` does.
  const replyOutcome = run.status === "done" ? await getAgentRunReplyOutcome(client, run) : null;
  const detail = await getAgentRunDetail(client, run, replyOutcome);
  const incompleteReply =
    detail.displayStatus === "error" && replyOutcome?.outcome === "incomplete" ? replyOutcome : null;
  const { errorSummary } = await agentRunErrorFields(run, locale, incompleteReply);
  return { at: last.scheduledFor, status: lastOccurrenceStatusOf(detail.displayStatus), errorSummary };
}

/**
 * `GET /api/projects/:id/heartbeats`: the project's user-made automations (`origin = 'user'`), oldest
 * first, with rule, localized `ruleLabel`, enabled state, next due time, last outcome and tick thread.
 * A single-consumer read for the project's agent screen; system heartbeats are not listed.
 *
 * `enabled` and `lastOccurrence.status` are independent: failing runs never switch an automation off.
 * A missing, trashed or other tenant's project answers the same 404.
 */
export function createProjectHeartbeatsRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const projectId = projectIdSchema.safeParse(ctx.params.id);
    if (!projectId.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const locale = ctx.identity.user.locale;
    const catalogs = await getSeedCatalogs();
    const label = (key: string) => resolveCatalogLabel(null, catalogs[toManifestLocale(locale)], catalogs.en, key);
    const rows = await withTransaction(pool, async (client) => {
      if (!(await findLiveProject(client, projectId.data))) throw new NotFoundError("Project not found");
      const heartbeats = await listHeartbeatsByProject(client, projectId.data, new Map(), "user");
      const lastRuns = await listLastFinishedOccurrenceRuns(
        client,
        heartbeats.map((heartbeat) => heartbeat.id),
      );
      const lastRunOf = new Map(lastRuns.map((last) => [last.heartbeatId, last]));
      const bodies: ProjectHeartbeatBody[] = [];
      for (const heartbeat of heartbeats) {
        const last = lastRunOf.get(heartbeat.id);
        bodies.push({
          id: heartbeat.id,
          name: heartbeat.name,
          rule: heartbeat.rule,
          ruleLabel: formatHeartbeatRuleLabel(heartbeat.rule, label),
          enabled: heartbeat.enabled,
          nextFireAt: heartbeat.nextFireAt,
          lastOccurrence: last ? await readLastOccurrence(client, last, locale) : null,
          threadId: (await findTickThread(client, heartbeat.id))?.id ?? null,
        });
      }
      return bodies;
    });
    return { status: 200, body: { rows } };
  };
}
