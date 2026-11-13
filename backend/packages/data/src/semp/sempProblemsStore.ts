import type { PoolClient } from "pg";
import { ValidationError } from "../errors.js";
import { writeNotification } from "../notifications/notify.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { publishSempStatusInvalidation } from "../sempStatus/sempStatusInvalidation.js";

/** Mirrors the CHECK on `semp_problems.category`. */
export type SempProblemCategory = "mail" | "agents" | "guidance" | "automation" | "transcription" | "backup";

/** Mirrors the CHECK on `semp_problems.severity`. */
export type SempProblemSeverity = "critical" | "warning";

/** Extended by the recovery issue (#1915). */
const SEMP_PROBLEM_RESOLUTION_KINDS = ["recovered"] as const;
export type SempProblemResolutionKind = (typeof SEMP_PROBLEM_RESOLUTION_KINDS)[number];

export type RaiseProblemOutcome = "created" | "merged" | "escalated";

export interface RaiseProblemInput {
  userId: string;
  category: SempProblemCategory;
  kind: string;
  severity: SempProblemSeverity;
  sourceTable: string;
  sourceId: string;
  /** Identifies "the same problem" within the tenant while it is active. */
  dedupeKey: string;
  projectItemId?: string | null;
  /** When the problem started, for a first raise that happens after the fact. Defaults to now. */
  since?: Date;
  /** Identifies the job or run reporting; a repeat within this problem episode adds no occurrence. */
  occurrenceKey?: string;
}

export interface RaiseProblemResult {
  problemId: string;
  outcome: RaiseProblemOutcome;
}

interface RaiseRow {
  id: string;
  inserted: boolean;
  prior_severity: SempProblemSeverity | null;
  severity: SempProblemSeverity;
}

/**
 * Records one report of a problem in the caller's open transaction (it never opens one): creates
 * the active problem for `(tenant, dedupeKey)` or merges into it. A merge increases
 * `occurrence_count` and sets `last_seen_at`, unless `occurrenceKey` was already recorded for
 * this episode. A `critical` raise escalates a stored
 * `warning`; an equal or lower severity never changes the stored one.
 *
 * A new or escalated problem also writes its `semp_problem` notification in the same transaction
 * (issue #1466): one notification per problem and per severity rise, which the fanout job pushes
 * according to the user's preferences. A merge writes no notification. The returned outcome tells
 * the caller which of the three happened.
 *
 * Every raise that changed the status announces `sempStatus` once the transaction commits (a new
 * problem, a severity rise, a merged occurrence); a replay of an occurrence that was already counted
 * and raised no severity changed nothing and announces nothing.
 *
 * One INSERT ... ON CONFLICT on the partial unique index `semp_problems_active_dedupe_uq`. A
 * transaction-scoped advisory lock on the key, taken first, makes the prior severity the
 * statement reads consistent with the row it updates, so two concurrent escalations cannot both
 * report `escalated`; it is released with the caller's transaction.
 */
export async function raiseProblem(client: PoolClient, input: RaiseProblemInput): Promise<RaiseProblemResult> {
  if (input.projectItemId != null) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.projectItemId)) {
      throw new ValidationError("Invalid projectItemId", { field: "projectItemId" });
    }
  }
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('semp_problems:' || app_tenant_default()::text || ':' || $1::text, 0))",
    [input.dedupeKey],
  );
  const previous = await client.query<{ id: string; last_occurrence_key: string | null }>(
    `SELECT id, last_occurrence_key FROM semp_problems
     WHERE tenant_id = app_tenant_default() AND dedupe_key = $1 AND resolved_at IS NULL`,
    [input.dedupeKey],
  );
  const existing = previous.rows[0];
  let countOccurrence = true;
  if (existing && input.occurrenceKey !== undefined) {
    const receipt = await client.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM semp_problem_occurrences
         WHERE tenant_id = app_tenant_default() AND problem_id = $1 AND occurrence_key = $2) AS present`,
      [existing.id, input.occurrenceKey],
    );
    countOccurrence = existing.last_occurrence_key !== input.occurrenceKey && !receipt.rows[0]?.present;
  }
  const { rows } = await client.query<RaiseRow>(
    `WITH prior AS (
       SELECT severity FROM semp_problems
        WHERE tenant_id = app_tenant_default() AND dedupe_key = $6 AND resolved_at IS NULL
     )
     INSERT INTO semp_problems
       (user_id, category, kind, severity, source_table, source_id, dedupe_key, project_item_id,
        first_seen_at, last_seen_at, last_occurrence_key)
     SELECT $1, $2, $3, $4, $5, $7, $6, $8::uuid, COALESCE($9::timestamptz, now()), now(), $10
     WHERE $8::uuid IS NULL OR EXISTS (
       SELECT 1 FROM items i JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
        WHERE i.tenant_id = app_tenant_default() AND d.tenant_id = app_tenant_default()
          AND d.system AND d.owner_module_id = $11 AND i.id = $8::uuid
     )
     ON CONFLICT (tenant_id, dedupe_key) WHERE resolved_at IS NULL DO UPDATE SET
       occurrence_count = semp_problems.occurrence_count + CASE WHEN $12::boolean THEN 1 ELSE 0 END,
       last_seen_at = CASE WHEN $12::boolean THEN now() ELSE semp_problems.last_seen_at END,
       last_occurrence_key = COALESCE(EXCLUDED.last_occurrence_key, semp_problems.last_occurrence_key),
       severity = CASE WHEN EXCLUDED.severity = 'critical' THEN 'critical' ELSE semp_problems.severity END
     RETURNING id, (xmax = 0) AS inserted, (SELECT severity FROM prior) AS prior_severity, severity`,
    [
      input.userId,
      input.category,
      input.kind,
      input.severity,
      input.sourceTable,
      input.dedupeKey,
      input.sourceId,
      input.projectItemId ?? null,
      input.since?.toISOString() ?? null,
      input.occurrenceKey ?? null,
      PROJECTS_MODULE_ID,
      countOccurrence,
    ],
  );
  const row = rows[0];
  if (!row) throw new ValidationError("Invalid projectItemId", { field: "projectItemId" });
  if (input.occurrenceKey !== undefined) {
    const keys = new Set([input.occurrenceKey]);
    if (!row.inserted && existing?.last_occurrence_key !== null && existing?.last_occurrence_key !== undefined) {
      keys.add(existing.last_occurrence_key);
    }
    for (const key of keys) {
      await client.query(
        `INSERT INTO semp_problem_occurrences (problem_id, occurrence_key) VALUES ($1, $2)
         ON CONFLICT (tenant_id, problem_id, occurrence_key) DO NOTHING`,
        [row.id, key],
      );
    }
  }
  const escalated = row.prior_severity === "warning" && row.severity === "critical";
  const outcome: RaiseProblemOutcome = row.inserted ? "created" : escalated ? "escalated" : "merged";
  if (outcome !== "merged" || countOccurrence) publishSempStatusInvalidation(client);
  if (outcome !== "merged") {
    // The transition instance names the severity, so a severity rise is a new transition of the
    // same problem. The severity comes from RETURNING, not from the input.
    await writeNotification(client, {
      userId: input.userId,
      kind: "semp_problem",
      linkHref: `?page=semp-status&id=${row.id}`,
      sourceTable: "semp_problems",
      sourceId: row.id,
      transitionInstance: `${row.id}:${row.severity}`,
      payload: { severity: row.severity },
    });
  }
  return { problemId: row.id, outcome };
}

/**
 * Resolves the active problem with `dedupeKey` in the caller's open transaction (it never opens
 * one). Idempotent: a key with no active problem changes nothing. Returns whether a row changed;
 * a change announces `sempStatus` once the transaction commits, no change announces nothing.
 */
export async function resolveProblem(
  client: PoolClient,
  input: { dedupeKey: string; resolutionKind: SempProblemResolutionKind },
): Promise<boolean> {
  if (!SEMP_PROBLEM_RESOLUTION_KINDS.includes(input.resolutionKind)) {
    throw new ValidationError(`Unknown problem resolution kind: ${String(input.resolutionKind)}`);
  }
  const result = await client.query(
    `UPDATE semp_problems SET resolved_at = now(), resolution_kind = $2
      WHERE tenant_id = app_tenant_default() AND dedupe_key = $1 AND resolved_at IS NULL`,
    [input.dedupeKey, input.resolutionKind],
  );
  const changed = (result.rowCount ?? 0) > 0;
  if (changed) publishSempStatusInvalidation(client);
  return changed;
}
