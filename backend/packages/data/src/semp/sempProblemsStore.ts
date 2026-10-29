import type { PoolClient } from "pg";
import { ValidationError } from "../errors.js";

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
  projectItemId?: string;
  /** When the problem started, for a first raise that happens after the fact. Defaults to now. */
  since?: Date;
  /** Identifies the job or run reporting; a repeat of the stored key adds no occurrence. */
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
 * `occurrence_count` and sets `last_seen_at`, unless `occurrenceKey` equals the stored
 * `last_occurrence_key` (a replay of the same job or run). A `critical` raise escalates a stored
 * `warning`; an equal or lower severity never changes the stored one. The push for a new or
 * escalated problem is the caller's to act on through the returned outcome.
 *
 * One INSERT ... ON CONFLICT on the partial unique index `semp_problems_active_dedupe_uq`. A
 * transaction-scoped advisory lock on the key, taken first, makes the prior severity the
 * statement reads consistent with the row it updates, so two concurrent escalations cannot both
 * report `escalated`; it is released with the caller's transaction.
 */
export async function raiseProblem(client: PoolClient, input: RaiseProblemInput): Promise<RaiseProblemResult> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('semp_problems:' || app_tenant_default()::text || ':' || $1::text, 0))",
    [input.dedupeKey],
  );
  const { rows } = await client.query<RaiseRow>(
    `WITH prior AS (
       SELECT severity FROM semp_problems
        WHERE tenant_id = app_tenant_default() AND dedupe_key = $6 AND resolved_at IS NULL
     )
     INSERT INTO semp_problems
       (user_id, category, kind, severity, source_table, source_id, dedupe_key, project_item_id,
        first_seen_at, last_seen_at, last_occurrence_key)
     VALUES ($1, $2, $3, $4, $5, $7, $6, $8, COALESCE($9::timestamptz, now()), now(), $10)
     ON CONFLICT (tenant_id, dedupe_key) WHERE resolved_at IS NULL DO UPDATE SET
       occurrence_count = semp_problems.occurrence_count
         + CASE WHEN EXCLUDED.last_occurrence_key IS NOT NULL
                     AND semp_problems.last_occurrence_key = EXCLUDED.last_occurrence_key THEN 0 ELSE 1 END,
       last_seen_at = CASE WHEN EXCLUDED.last_occurrence_key IS NOT NULL
                                AND semp_problems.last_occurrence_key = EXCLUDED.last_occurrence_key
                           THEN semp_problems.last_seen_at ELSE now() END,
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
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("raiseProblem: INSERT ... ON CONFLICT returned no row");
  if (row.inserted) return { problemId: row.id, outcome: "created" };
  const escalated = row.prior_severity === "warning" && row.severity === "critical";
  return { problemId: row.id, outcome: escalated ? "escalated" : "merged" };
}

/**
 * Resolves the active problem with `dedupeKey` in the caller's open transaction (it never opens
 * one). Idempotent: a key with no active problem changes nothing. Returns whether a row changed.
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
  return (result.rowCount ?? 0) > 0;
}
