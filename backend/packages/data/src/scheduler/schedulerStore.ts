import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { NotFoundError } from "../errors.js";
import { getSystemTimezone } from "../systemSettings.js";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import { computeNextFireAt } from "./nextFireAt.js";
import {
  isFloatingRuleKind,
  isOnItemEventRule,
  parseHeartbeatRule,
  type AnyHeartbeatRule,
  type HeartbeatRuleKindRegistry,
} from "./rule.js";
import type { ActionQueueAffinity } from "./actions.js";

export interface HeartbeatRow {
  id: string;
  projectItemId: string;
  name: string;
  rule: AnyHeartbeatRule;
  actionId: string;
  actionConfig: Record<string, unknown>;
  enabled: boolean;
  nextFireAt: string | null;
  lastFiredAt: string | null;
  lastError: string | null;
}

function mapRow(
  row: {
    id: string;
    project_item_id: string;
    name: string;
    rule: unknown;
    action_id: string;
    action_config: Record<string, unknown>;
    enabled: boolean;
    next_fire_at: Date | null;
    last_fired_at: Date | null;
    last_error: string | null;
  },
  moduleRuleKinds: HeartbeatRuleKindRegistry,
  options: { tolerateUnknownRuleKind?: boolean } = {},
): HeartbeatRow {
  let rule: AnyHeartbeatRule;
  try {
    rule = parseHeartbeatRule(row.rule, moduleRuleKinds);
  } catch (err) {
    // Some callers (disabling a heartbeat) only need the row to exist, not its rule to
    // still resolve — a heartbeat whose module was deactivated must stay disable-able.
    if (!options.tolerateUnknownRuleKind) throw err;
    rule = row.rule as AnyHeartbeatRule;
  }
  return {
    id: row.id,
    projectItemId: row.project_item_id,
    name: row.name,
    rule,
    actionId: row.action_id,
    actionConfig: row.action_config,
    enabled: row.enabled,
    nextFireAt: row.next_fire_at ? row.next_fire_at.toISOString() : null,
    lastFiredAt: row.last_fired_at ? row.last_fired_at.toISOString() : null,
    lastError: row.last_error,
  };
}

const COLUMNS =
  "id, project_item_id, name, rule, action_id, action_config, enabled, next_fire_at, last_fired_at, last_error";

export interface CreateHeartbeatInput {
  projectItemId: string;
  name: string;
  rule: unknown;
  actionId: string;
  actionConfig?: Record<string, unknown>;
  enabled?: boolean;
}

export async function createHeartbeat(
  client: PoolClient,
  input: CreateHeartbeatInput,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<HeartbeatRow> {
  const rule = parseHeartbeatRule(input.rule, moduleRuleKinds);
  const enabled = input.enabled ?? true;
  const nextFireAt =
    enabled && !isOnItemEventRule(rule) ? await computeNextFireAtNow(client, rule, moduleRuleKinds) : null;

  const { rows } = await client.query(
    `INSERT INTO project_heartbeats (project_item_id, name, rule, action_id, action_config, enabled, next_fire_at)
     VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)
     RETURNING ${COLUMNS}`,
    [
      input.projectItemId,
      input.name,
      JSON.stringify(rule),
      input.actionId,
      JSON.stringify(input.actionConfig ?? {}),
      enabled,
      nextFireAt,
    ],
  );
  return mapRow(rows[0], moduleRuleKinds);
}

async function computeNextFireAtNow(
  client: PoolClient,
  rule: AnyHeartbeatRule,
  moduleRuleKinds: HeartbeatRuleKindRegistry,
): Promise<Date | null> {
  const timezone = await getSystemTimezone(client);
  return computeNextFireAt(rule, timezone, new Date(), moduleRuleKinds);
}

export async function getHeartbeat(
  client: PoolClient,
  id: string,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<HeartbeatRow | null> {
  const { rows } = await client.query(`SELECT ${COLUMNS} FROM project_heartbeats WHERE id = $1`, [id]);
  return rows[0] ? mapRow(rows[0], moduleRuleKinds) : null;
}

async function requireHeartbeat(
  client: PoolClient,
  id: string,
  moduleRuleKinds: HeartbeatRuleKindRegistry,
): Promise<HeartbeatRow> {
  const heartbeat = await getHeartbeat(client, id, moduleRuleKinds);
  if (!heartbeat) throw new NotFoundError(`Heartbeat ${id} not found`);
  return heartbeat;
}

/**
 * All of a project's heartbeats, agent-triggered and deterministic alike (issue #135's
 * `heartbeat.list`) — a rule whose kind's module was deactivated still lists (matching
 * `setHeartbeatEnabled`'s disable path) rather than failing the whole call for one bad row.
 */
export async function listHeartbeatsByProject(
  client: Pool | PoolClient,
  projectItemId: string,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<HeartbeatRow[]> {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM project_heartbeats WHERE project_item_id = $1 ORDER BY created_at ASC`,
    [projectItemId],
  );
  return rows.map((row) => mapRow(row, moduleRuleKinds, { tolerateUnknownRuleKind: true }));
}

/**
 * Scoped lookup for `heartbeat.history`'s ownership check: a single `WHERE` on both
 * `id` and `project_item_id`, so a `heartbeatId` that exists but belongs to another
 * project produces the exact same empty result as an unknown id (issue #135's "cross-project
 * ids are indistinguishable from unknown ids") — never a two-step exists-then-owns check.
 */
export async function getHeartbeatForProject(
  client: Pool | PoolClient,
  projectItemId: string,
  heartbeatId: string,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<HeartbeatRow | null> {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM project_heartbeats WHERE id = $1 AND project_item_id = $2`,
    [heartbeatId, projectItemId],
  );
  return rows[0] ? mapRow(rows[0], moduleRuleKinds, { tolerateUnknownRuleKind: true }) : null;
}

/**
 * Recomputes next_fire_at using the same pure function as the sweep — deterministic at write
 * time. Only the row's `enabled` flag is needed from the *current* state — never its current
 * rule — so replacing a heartbeat whose existing rule kind's module was deactivated (e.g. to
 * point it at a different, working rule) isn't itself blocked by that old rule failing to parse.
 */
export async function updateHeartbeatRule(
  client: PoolClient,
  id: string,
  rawRule: unknown,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<HeartbeatRow> {
  const { rows: existingRows } = await client.query<{ enabled: boolean }>(
    `SELECT enabled FROM project_heartbeats WHERE id = $1`,
    [id],
  );
  if (!existingRows[0]) throw new NotFoundError(`Heartbeat ${id} not found`);
  const rule = parseHeartbeatRule(rawRule, moduleRuleKinds);
  const nextFireAt =
    existingRows[0].enabled && !isOnItemEventRule(rule)
      ? await computeNextFireAtNow(client, rule, moduleRuleKinds)
      : null;

  const { rows } = await client.query(
    `UPDATE project_heartbeats SET rule = $2::jsonb, next_fire_at = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, JSON.stringify(rule), nextFireAt],
  );
  return mapRow(rows[0], moduleRuleKinds);
}

/** Disabling is a plain flag flip; re-enabling recomputes from now — occurrences missed while paused are not caught up. */
export async function setHeartbeatEnabled(
  client: PoolClient,
  id: string,
  enabled: boolean,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<HeartbeatRow> {
  if (!enabled) {
    // Disabling must never depend on the rule still being parseable: a heartbeat whose rule
    // kind's module was deactivated needs to be disable-able precisely because it can no
    // longer be scheduled, not stuck enabled forever for the same reason.
    const { rows } = await client.query(
      `UPDATE project_heartbeats SET enabled = false, next_fire_at = NULL WHERE id = $1 RETURNING ${COLUMNS}`,
      [id],
    );
    if (!rows[0]) throw new NotFoundError(`Heartbeat ${id} not found`);
    return mapRow(rows[0], moduleRuleKinds, { tolerateUnknownRuleKind: true });
  }

  // Re-enabling does need the rule: computing next_fire_at requires knowing which calculator
  // (core or module) applies, so this still throws if the owning module is inactive.
  const heartbeat = await requireHeartbeat(client, id, moduleRuleKinds);
  const nextFireAt = !isOnItemEventRule(heartbeat.rule)
    ? await computeNextFireAtNow(client, heartbeat.rule, moduleRuleKinds)
    : null;

  const { rows } = await client.query(
    `UPDATE project_heartbeats SET enabled = true, next_fire_at = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, nextFireAt],
  );
  return mapRow(rows[0], moduleRuleKinds);
}

/** Called in the same transaction as the `timezone` settings write. */
export async function recomputeAllForTimezoneChange(
  client: PoolClient,
  newTimezone: string,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<void> {
  const { rows } = await client.query<{ id: string; rule: unknown }>(
    `SELECT id, rule FROM project_heartbeats WHERE enabled AND next_fire_at IS NOT NULL FOR UPDATE`,
  );
  for (const row of rows) {
    // Same deactivated-module guard as sweepDueHeartbeats: one row whose rule kind no longer
    // resolves must not abort the whole batch (and the whole timezone-change transaction) —
    // record the failure and move on, leaving that row's next_fire_at as-is.
    let rule: AnyHeartbeatRule;
    let nextFireAt: Date | null;
    try {
      rule = parseHeartbeatRule(row.rule, moduleRuleKinds);
      nextFireAt = computeNextFireAt(rule, newTimezone, new Date(), moduleRuleKinds);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordHeartbeatFailure(client, row.id, message);
      continue;
    }
    await client.query(`UPDATE project_heartbeats SET next_fire_at = $2 WHERE id = $1`, [row.id, nextFireAt]);
  }
}

export async function recordHeartbeatSuccess(client: Pool | PoolClient, id: string): Promise<void> {
  await client.query(`UPDATE project_heartbeats SET last_error = NULL WHERE id = $1`, [id]);
}

export async function recordHeartbeatFailure(client: Pool | PoolClient, id: string, error: string): Promise<void> {
  await client.query(`UPDATE project_heartbeats SET last_error = $2 WHERE id = $1`, [id, error]);
}

/** `suffix` is an `itemId` for an `onItemEvent` fire; distinct suffixes never collapse onto or replace each other's job. */
export function heartbeatFireJobKey(heartbeatId: string, suffix?: string): string {
  return suffix ? `heartbeat-fire:${heartbeatId}:${suffix}` : `heartbeat-fire:${heartbeatId}`;
}

/**
 * The scheduled-occurrence job key (issue #84's generation protocol, superseding #213's plain
 * `heartbeat-fire:${heartbeatId}:${occurrenceId}`). Every generation of the same occurrence gets
 * a distinct key, so reactivating a cancelled or stale-queued occurrence never collapses onto —
 * or is mistaken for — the job an old, still-finishing handler was enqueued for.
 */
export function occurrenceFireJobKey(heartbeatId: string, occurrenceId: string, generation: number): string {
  return `heartbeat-fire:${heartbeatId}:${occurrenceId}:${generation}`;
}

/**
 * The manual-trigger dedup key (issue #136's `heartbeat.trigger`) — deliberately distinct from
 * `heartbeatFireJobKey`'s scheduler key so a pending manual fire can never collapse onto (and
 * thus silently steal the attribution of) a pending scheduled one, or vice versa. Two manual
 * triggers for the same heartbeat before the first has started running do collapse onto one
 * job, same replace semantics as the scheduler key.
 */
export function manualHeartbeatFireJobKey(heartbeatId: string): string {
  return `heartbeat-fire:manual:${heartbeatId}`;
}

/**
 * The onItemEvent write path: called from the choke-point, in the same transaction as
 * the item write that just happened, for every enabled onItemEvent heartbeat watching
 * this database+event. `next_fire_at` stays NULL for these — they are invisible to the sweep.
 */
export async function triggerOnItemEventHeartbeats(
  client: PoolClient,
  databaseId: string,
  event: "create" | "update" | "delete",
  itemId: string,
  queueAffinity: ActionQueueAffinity = new Map(),
): Promise<void> {
  const { rows } = await client.query<{ id: string; action_id: string }>(
    `SELECT id, action_id FROM project_heartbeats
     WHERE enabled
       AND rule ->> 'kind' = 'onItemEvent'
       AND rule ->> 'databaseId' = $1
       AND rule ->> 'event' = $2`,
    [databaseId, event],
  );
  for (const row of rows) {
    await enqueueJob(
      client,
      CORE_TASK_NAMES.HEARTBEAT_FIRE,
      { heartbeatId: row.id, itemId },
      { jobKey: heartbeatFireJobKey(row.id, itemId), maxAttempts: 3, queueName: queueAffinity.get(row.action_id) },
    );
  }
}

export interface SweptHeartbeat {
  id: string;
}

export interface OccurrenceInsertResult {
  occurrenceId: string;
  generation: number;
  jobKeyMode: "replace" | "preserve_run_at";
}

/**
 * Inserts the `queued` occurrence for one due fire, or reactivates an existing one for the same
 * `(heartbeat_id, scheduled_for)` (issue #84's generation protocol, superseding #213's plain
 * conflict-is-always-a-no-op rule). `scheduled_for` is the row's *old* `next_fire_at` — the due
 * time this sweep is firing for, not any newly computed one.
 *
 * A conflicting `cancelled` row means edit-away/edit-back or disable/re-enable recomputed the
 * schedule back onto a timestamp whose occurrence was already cancelled: reactivate it in place
 * (new `rule_snapshot`, `status` back to `queued`, cleared `first_started_at`/`last_error`,
 * incremented `generation`) and treat it like a fresh occurrence.
 *
 * A conflicting `queued` row whose `rule_snapshot` no longer matches the rule the sweep just saw
 * means the still-pending occurrence's snapshot went stale (the rule was edited since it was
 * queued): replace the snapshot and bump `generation` in place, preserving the occurrence's id and
 * `queued` status — a concurrently starting handler blocks on this same row lock and, once
 * released, sees the fresh snapshot.
 *
 * Every other conflict (`queued` with a matching snapshot, or `running`/`succeeded`/`failed`) is
 * an idempotent no-op: `null` tells the caller not to enqueue a job or advance the schedule again.
 * `running`/`succeeded`/`failed` occurrences are never reactivatable, matching or not.
 */
async function insertHeartbeatOccurrence(
  client: PoolClient,
  heartbeatId: string,
  scheduledFor: Date,
  ruleSnapshot: AnyHeartbeatRule,
): Promise<OccurrenceInsertResult | null> {
  const snapshotJson = JSON.stringify(ruleSnapshot);
  const { rows: inserted } = await client.query<{ id: string; generation: number }>(
    `INSERT INTO heartbeat_occurrences (heartbeat_id, scheduled_for, rule_snapshot, status)
     VALUES ($1, $2, $3::jsonb, 'queued')
     ON CONFLICT (heartbeat_id, scheduled_for) DO NOTHING
     RETURNING id, generation`,
    [heartbeatId, scheduledFor, snapshotJson],
  );
  if (inserted[0]) {
    return { occurrenceId: inserted[0].id, generation: inserted[0].generation, jobKeyMode: "replace" };
  }

  // Lock the existing row under the same locks the sweep already holds on the heartbeat, so a
  // concurrent handler-start (prepareHeartbeatOccurrenceFire's own FOR UPDATE on this row) waits
  // for whichever reactivation below commits, then re-reads the fresh snapshot/generation.
  const { rows: existingRows } = await client.query<{ id: string; status: string; snapshot_matches: boolean }>(
    `SELECT id, status, (rule_snapshot = $3::jsonb) AS snapshot_matches
     FROM heartbeat_occurrences WHERE heartbeat_id = $1 AND scheduled_for = $2 FOR UPDATE`,
    [heartbeatId, scheduledFor, snapshotJson],
  );
  const existing = existingRows[0];
  if (!existing) return null; // the conflicting row vanished (heartbeat/occurrence cascade) between the insert and this lock

  if (existing.status === "cancelled") {
    const { rows } = await client.query<{ generation: number }>(
      `UPDATE heartbeat_occurrences
       SET rule_snapshot = $2::jsonb, status = 'queued', first_started_at = NULL, last_error = NULL,
           generation = generation + 1
       WHERE id = $1
       RETURNING generation`,
      [existing.id, snapshotJson],
    );
    return {
      occurrenceId: existing.id,
      generation: requireSingleRow(rows, "heartbeat_occurrences reactivate RETURNING").generation,
      jobKeyMode: "replace",
    };
  }

  if (existing.status === "queued" && !existing.snapshot_matches) {
    const { rows } = await client.query<{ generation: number }>(
      `UPDATE heartbeat_occurrences
       SET rule_snapshot = $2::jsonb, last_error = NULL, generation = generation + 1
       WHERE id = $1
       RETURNING generation`,
      [existing.id, snapshotJson],
    );
    return {
      occurrenceId: existing.id,
      generation: requireSingleRow(rows, "heartbeat_occurrences resnapshot RETURNING").generation,
      jobKeyMode: "preserve_run_at",
    };
  }

  return null; // queued-with-matching-snapshot, running, succeeded, or failed: never reactivatable
}

/**
 * The minute-granularity sweep: `FOR UPDATE SKIP LOCKED` is what guarantees "exactly
 * once", not transaction atomicity nor jobKey — two overlapping sweeps could otherwise
 * both select the same row under READ COMMITTED. This same query and update also *is*
 * the catch-up policy: a row whose next_fire_at fell in the past while the server was
 * down is picked up on the first sweep after restart and fired exactly once.
 *
 * `next_fire_at` only moves here for a *fixed* rule (`dailyTime`/`weekly`), immediately to its
 * next calendar occurrence — queue delay can never shift a calendar-anchored rule. A *floating*
 * rule (`interval`/`everyNDays`) is set to `NULL` instead: it stays scheduling-less until the
 * fire task's first attempt actually starts and computes the next occurrence from that real
 * execution time, not from this enqueue time (issue #213's fix for the delay-shifts-schedule
 * bug). `last_fired_at` is no longer touched here either — the first attempt sets it, for both
 * fixed and floating rules, to `first_started_at`.
 */
export async function sweepDueHeartbeats(
  client: PoolClient,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<SweptHeartbeat[]> {
  const { rows } = await client.query<{ id: string; rule: unknown; next_fire_at: Date }>(
    `SELECT id, rule, next_fire_at FROM project_heartbeats
     WHERE enabled AND next_fire_at IS NOT NULL AND next_fire_at <= now()
     FOR UPDATE SKIP LOCKED`,
  );
  if (rows.length === 0) return [];

  const timezone = await getSystemTimezone(client);
  const now = new Date();
  const fired: SweptHeartbeat[] = [];
  for (const row of rows) {
    // A row whose rule kind belongs to a module deactivated since it was last scheduled must
    // not be newly dispatched: record the failure and leave next_fire_at as-is (still due) so
    // reactivating the module lets the next sweep pick it back up, instead of enqueueing a
    // heartbeatFire job for a rule core can no longer even parse.
    let rule: AnyHeartbeatRule;
    let calendarNextFireAt: Date | null;
    try {
      rule = parseHeartbeatRule(row.rule, moduleRuleKinds);
      calendarNextFireAt = computeNextFireAt(rule, timezone, now, moduleRuleKinds);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordHeartbeatFailure(client, row.id, message);
      continue;
    }

    const reactivation = await insertHeartbeatOccurrence(client, row.id, row.next_fire_at, rule);
    if (!reactivation) continue; // idempotent no-op: a non-reactivatable occurrence for this exact due time already exists
    const { occurrenceId, generation, jobKeyMode } = reactivation;

    const nextFireAt = isFloatingRuleKind(rule.kind) ? null : calendarNextFireAt;
    await client.query(`UPDATE project_heartbeats SET next_fire_at = $2 WHERE id = $1`, [row.id, nextFireAt]);
    await enqueueJob(
      client,
      CORE_TASK_NAMES.HEARTBEAT_FIRE,
      { heartbeatId: row.id, occurrenceId, generation },
      { jobKey: occurrenceFireJobKey(row.id, occurrenceId, generation), maxAttempts: 3, jobKeyMode },
    );
    fired.push({ id: row.id });
  }
  return fired;
}

export type OccurrenceFirePreparation =
  | { outcome: "missing" }
  | { outcome: "stale" }
  | { outcome: "cancelled" }
  | { outcome: "degraded" }
  | { outcome: "proceed"; heartbeat: HeartbeatRow };

/**
 * The occurrence fire task's "first attempt, lock and decide" step (issue #213, extended by #84's
 * generation protocol). Locks the heartbeat and occurrence row together.
 *
 * The very first check is `generation`: the payload's generation must equal the row's current
 * generation, or this job was enqueued for a generation that a reactivation (cancelled-occurrence
 * or stale-queued-snapshot replace, see `insertHeartbeatOccurrence`) has since superseded. A stale
 * generation is a successful no-op — it never touches status, `rule_snapshot`, or heartbeat
 * scheduling — so an old handler can only finish or remove its own generation's job, never the
 * reactivated one.
 *
 * With a matching generation, it compares the heartbeat's *current* `rule` against the
 * occurrence's `rule_snapshot` with plain PostgreSQL `jsonb` equality — never by re-parsing either
 * side, so a disabled heartbeat or one whose rule kind's module went inactive since the sweep
 * still compares correctly. A disabled heartbeat or a rule that no longer matches its snapshot
 * cancels the occurrence and executes nothing; the disable/rule-edit transaction that caused the
 * mismatch already owns recomputing or clearing `next_fire_at`, so this never touches heartbeat
 * scheduling.
 *
 * Only a genuine first attempt (`first_started_at` still `NULL`) sets `first_started_at`,
 * `status = 'running'`, `project_heartbeats.last_fired_at`, and — for a floating rule only — the
 * freshly computed `next_fire_at`. A retry (the job was re-attempted after a failure) finds
 * `first_started_at` already set and skips straight to `"proceed"` without touching any of that
 * state again, reusing the same occurrence and timestamp.
 *
 * Runs as its own short transaction, separate from the (possibly long) handler execution that
 * follows a `"proceed"` result — the row locks here must never be held across that call.
 */
export async function prepareHeartbeatOccurrenceFire(
  pool: Pool,
  heartbeatId: string,
  occurrenceId: string,
  generation: number,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<OccurrenceFirePreparation> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      id: string;
      project_item_id: string;
      name: string;
      rule: { kind?: unknown } | null;
      action_id: string;
      action_config: Record<string, unknown>;
      enabled: boolean;
      next_fire_at: Date | null;
      last_fired_at: Date | null;
      last_error: string | null;
      first_started_at: Date | null;
      generation: number;
      rules_match: boolean;
    }>(
      `SELECT h.id, h.project_item_id, h.name, h.rule, h.action_id, h.action_config, h.enabled,
              h.next_fire_at, h.last_fired_at, h.last_error,
              o.first_started_at, o.generation, (h.rule = o.rule_snapshot) AS rules_match
       FROM heartbeat_occurrences o
       JOIN project_heartbeats h ON h.id = o.heartbeat_id
       WHERE o.id = $1 AND o.heartbeat_id = $2
       FOR UPDATE`,
      [occurrenceId, heartbeatId],
    );
    const row = rows[0];
    if (!row) return { outcome: "missing" }; // heartbeat/occurrence deleted (cascade) since enqueue

    if (row.generation !== generation) return { outcome: "stale" }; // superseded by a reactivation; this job's generation is dead

    if (!row.enabled || !row.rules_match) {
      await client.query(`UPDATE heartbeat_occurrences SET status = 'cancelled' WHERE id = $1`, [occurrenceId]);
      return { outcome: "cancelled" };
    }

    // Same deactivated-module guard as the sweep and the non-occurrence fire path: a rule kind
    // whose owning module went inactive between the sweep enqueuing this job and it running now
    // must degrade (record the failure, don't execute) instead of throwing and retrying up to
    // max_attempts against a module that retrying can't reactivate.
    let rule: AnyHeartbeatRule;
    try {
      rule = parseHeartbeatRule(row.rule, moduleRuleKinds);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordHeartbeatFailure(client, heartbeatId, message);
      await client.query(`UPDATE heartbeat_occurrences SET status = 'failed', last_error = $2 WHERE id = $1`, [
        occurrenceId,
        message,
      ]);
      return { outcome: "degraded" };
    }

    if (row.first_started_at === null) {
      const now = new Date();
      const nextFireAt = isFloatingRuleKind(rule.kind)
        ? computeNextFireAt(rule, await getSystemTimezone(client), now, moduleRuleKinds)
        : undefined;

      await client.query(`UPDATE heartbeat_occurrences SET first_started_at = $2, status = 'running' WHERE id = $1`, [
        occurrenceId,
        now,
      ]);
      if (nextFireAt !== undefined) {
        await client.query(`UPDATE project_heartbeats SET last_fired_at = $2, next_fire_at = $3 WHERE id = $1`, [
          heartbeatId,
          now,
          nextFireAt,
        ]);
      } else {
        await client.query(`UPDATE project_heartbeats SET last_fired_at = $2 WHERE id = $1`, [heartbeatId, now]);
      }
    }

    // Built from the row already locked above, tolerating an unparseable rule (its module may
    // have gone inactive between the sweep and this fire) — the handler dispatch that follows
    // only needs `actionId`/`actionConfig`/`projectItemId`, never the parsed `rule` itself, so
    // this must degrade the same way `listHeartbeatsByProject`/`setHeartbeatEnabled`'s disable
    // path do rather than throw and turn a graceful skip into a retriable job error.
    const heartbeat = mapRow(row, moduleRuleKinds, { tolerateUnknownRuleKind: true });
    return { outcome: "proceed", heartbeat };
  });
}

export async function succeedHeartbeatOccurrence(client: Pool | PoolClient, occurrenceId: string): Promise<void> {
  await client.query(`UPDATE heartbeat_occurrences SET status = 'succeeded', last_error = NULL WHERE id = $1`, [
    occurrenceId,
  ]);
}

export async function failHeartbeatOccurrence(
  client: Pool | PoolClient,
  occurrenceId: string,
  message: string,
): Promise<void> {
  await client.query(`UPDATE heartbeat_occurrences SET status = 'failed', last_error = $2 WHERE id = $1`, [
    occurrenceId,
    message,
  ]);
}
