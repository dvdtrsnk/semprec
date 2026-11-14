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
 * The custom-route handler shape this file's export is cast to by `semprec-api`'s mount (issue #239), duck-typed
 * as in `agentDatabaseGrantsRouteHandlers.ts`. The adapter authenticates a session before a handler runs, so a
 * request with an agent run credential never gets here, and it runs the handler inside the session's tenant.
 */
interface CustomRouteRequestContext {
  params: Record<string, string>;
  identity: { user: { locale: string } };
}

type CustomRouteResult = { status: number; body: unknown };

/** How the last run of an automation ended, as the project's agent screen shows it. */
export type LastOccurrenceStatus = "ok" | "waiting_approval" | "failed";

/** The last occurrence of an automation that ran: when it was due, how its run ended and, for a failure, why. */
export interface LastOccurrence {
  at: string;
  status: LastOccurrenceStatus;
  errorSummary: string | null;
}

/** One automation of a project as `GET /api/projects/:id/heartbeats` lists it. */
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

/**
 * The `seed/i18n/{cs,en}.json` catalogs the rule labels are read from, loaded once per process. A failed load is
 * not kept, so the next request tries again instead of failing until a restart.
 */
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
 * The status of `LastOccurrence` for the display status of a finished run: a failure (including a reply that
 * finished with a failed tool call) is `failed`, a pending approval is `waiting_approval`, anything else `ok`.
 * `running` is no outcome of a finished run, and `listLastFinishedOccurrenceRuns` leaves such a run out, so
 * reaching it means the run changed between that read and this one; it is refused instead of being reported as
 * one of the three outcomes.
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
 * The last occurrence of one automation, derived from the display status of its run (issues #1820 and #1890), not
 * from `heartbeat_occurrences.status` (which says only that the fire task finished) and not from the raw
 * `last_error`. The summary is the localized text of the run's error code (issue #1824), or of its incomplete
 * reply.
 */
async function readLastOccurrence(
  client: PoolClient,
  last: LastFinishedOccurrenceRun,
  locale: string,
): Promise<LastOccurrence> {
  const run = await getAgentRun(client, last.runId);
  // `listLastFinishedOccurrenceRuns` named this run a moment ago in this transaction, so a missing row is an inconsistency of the data, not a client error.
  if (!run) throw new Error("The run of the latest occurrence of a heartbeat is missing");
  // Read the reply once for both the display status and the summary, as `GET /api/agent-runs/:id` does.
  const replyOutcome = run.status === "done" ? await getAgentRunReplyOutcome(client, run) : null;
  const detail = await getAgentRunDetail(client, run, replyOutcome);
  const incompleteReply =
    detail.displayStatus === "error" && replyOutcome?.outcome === "incomplete" ? replyOutcome : null;
  const { errorSummary } = await agentRunErrorFields(run, locale, incompleteReply);
  return { at: last.scheduledFor, status: lastOccurrenceStatusOf(detail.displayStatus), errorSummary };
}

/**
 * `GET /api/projects/:id/heartbeats` (issue #1910): the project's automations a person made (`origin = 'user'`),
 * oldest first, each with its structured `rule`, the `ruleLabel` in the session user's language, whether it is
 * switched on, its next due time, how its last run ended and its tick thread (`null` while it has not run).
 * Shaped for one consumer, the project's agent screen, so it is the "single-consumer-read" justification; the
 * heartbeats the system created (seeds, the new-email automation) are not listed.
 *
 * `enabled` and `lastOccurrence.status` are independent: the system never switches an automation off because its
 * runs fail, so `enabled: false` with a `failed` last run reads as it is, an automation that was switched off and
 * whose last run failed. A missing, trashed or other tenant's project answers 404 with the same body.
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
