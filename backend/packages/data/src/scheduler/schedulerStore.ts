import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { enqueueJob } from "@semprec/queue";
import { tenantLane } from "../tenancy/tenantLane.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { getDatabase } from "../chokePoint/databasesStore.js";
import { getSystemTimezone } from "../systemSettings.js";
import { requireAffectedRows, requireSingleRow, TransactionLocal, withTransaction } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { publishProjectAgentInvalidation } from "../projectAgent/projectAgentInvalidation.js";
import { computeNextFireAt } from "./nextFireAt.js";
import {
  isFloatingRuleKind,
  isOnItemEventRule,
  parseHeartbeatRule,
  type OnItemEventRule,
  type AnyHeartbeatRule,
  type HeartbeatRuleKindRegistry,
} from "./rule.js";
import {
  CORE_AGENT_RUN_ACTION_ID,
  createActionQueueAffinity,
  resolveAgentRunLane,
  resolveHeartbeatFireTaskName,
  type ActionQueueAffinity,
} from "./actions.js";
import { ITEM_EVENT_BATCH_ACTION_IDS } from "./itemEventBatchActions.js";

export const HEARTBEAT_ORIGINS = ["user", "system"] as const;
export type HeartbeatOrigin = (typeof HEARTBEAT_ORIGINS)[number];

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
  /** `user` when a person asked Semp to create it, `system` for seeds and internal upserts. */
  origin: HeartbeatOrigin;
}

type HeartbeatDbRow = {
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
  origin: string;
};

function mapRow(
  row: HeartbeatDbRow,
  moduleRuleKinds: HeartbeatRuleKindRegistry,
  options: { tolerateUnknownRuleKind?: boolean } = {},
): HeartbeatRow {
  let rule: AnyHeartbeatRule;
  try {
    rule = parseHeartbeatRule(row.rule, moduleRuleKinds);
  } catch (err) {
    // Disabling only needs the row to exist; a heartbeat whose module was deactivated must stay disable-able.
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
    origin: assertKnownValue(HEARTBEAT_ORIGINS, row.origin, "heartbeat origin"),
  };
}

const COLUMNS =
  "id, project_item_id, name, rule, action_id, action_config, enabled, next_fire_at, last_fired_at, last_error, origin";

export interface CreateHeartbeatInput {
  projectItemId: string;
  name: string;
  rule: unknown;
  actionId: string;
  actionConfig?: Record<string, unknown>;
  enabled?: boolean;
  /** Defaults to `system`; only the heartbeat.create tool writes `user`. */
  origin?: HeartbeatOrigin;
}

/** A foreign tenant's database id fails like a missing one. */
async function assertOnItemEventDatabaseExists(client: PoolClient, rule: AnyHeartbeatRule): Promise<void> {
  if (!isOnItemEventRule(rule)) return;
  if (!(await getDatabase(client, (rule as OnItemEventRule).databaseId))) {
    throw new ValidationError("'rule.databaseId' does not reference an existing database", {
      field: "rule.databaseId",
    });
  }
}

/** Announced after commit; `system` heartbeats (seeds, internal upserts) announce nothing. */
function announceUserHeartbeatChange(client: PoolClient, heartbeat: HeartbeatRow): HeartbeatRow {
  if (heartbeat.origin === "user") publishProjectAgentInvalidation(client, heartbeat.projectItemId);
  return heartbeat;
}

export async function createHeartbeat(
  client: PoolClient,
  input: CreateHeartbeatInput,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<HeartbeatRow> {
  const rule = parseHeartbeatRule(input.rule, moduleRuleKinds);
  await assertOnItemEventDatabaseExists(client, rule);
  const enabled = input.enabled ?? true;
  const nextFireAt =
    enabled && !isOnItemEventRule(rule) ? await computeNextFireAtNow(client, rule, moduleRuleKinds) : null;

  const { rows } = await client.query<HeartbeatDbRow>(
    `INSERT INTO project_heartbeats (project_item_id, name, rule, action_id, action_config, enabled, next_fire_at, origin)
     VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [
      input.projectItemId,
      input.name,
      JSON.stringify(rule),
      input.actionId,
      JSON.stringify(input.actionConfig ?? {}),
      enabled,
      nextFireAt,
      input.origin ?? "system",
    ],
  );
  return announceUserHeartbeatChange(client, mapRow(requireSingleRow(rows, "project_heartbeats row"), moduleRuleKinds));
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
  const { rows } = await client.query<HeartbeatDbRow>(`SELECT ${COLUMNS} FROM project_heartbeats WHERE id = $1`, [id]);
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

/** Optionally filtered by `origin`. A rule of a deactivated module still lists instead of failing the call. */
export async function listHeartbeatsByProject(
  client: Pool | PoolClient,
  projectItemId: string,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
  origin: HeartbeatOrigin | null = null,
): Promise<HeartbeatRow[]> {
  const { rows } = await client.query<HeartbeatDbRow>(
    `SELECT ${COLUMNS} FROM project_heartbeats
     WHERE project_item_id = $1 AND ($2::text IS NULL OR origin = $2)
     ORDER BY created_at ASC`,
    [projectItemId, origin],
  );
  return rows.map((row) => mapRow(row, moduleRuleKinds, { tolerateUnknownRuleKind: true }));
}

export interface LastFinishedOccurrenceRun {
  heartbeatId: string;
  /** ISO timestamp. */
  scheduledFor: string;
  /** The run with the highest `attempt` (as `getLatestRunOfOccurrence` returns). */
  runId: string;
}

/**
 * Per heartbeat, the latest occurrence whose latest run is no longer `running` (occurrence `status` only
 * says the fire task succeeded). Heartbeats without one are absent.
 */
export async function listLastFinishedOccurrenceRuns(
  client: Pool | PoolClient,
  heartbeatIds: readonly string[],
): Promise<LastFinishedOccurrenceRun[]> {
  if (heartbeatIds.length === 0) return [];
  const { rows } = await client.query<{ heartbeat_id: string; scheduled_for: Date; run_id: string }>(
    `SELECT h.id AS heartbeat_id, last.scheduled_for, last.run_id
     FROM unnest($1::uuid[]) AS h(id)
     CROSS JOIN LATERAL (
       SELECT o.scheduled_for, r.id AS run_id
       FROM heartbeat_occurrences o
       JOIN LATERAL (
         SELECT id, status FROM agent_runs
         WHERE heartbeat_occurrence_id = o.id
         ORDER BY attempt DESC, started_at DESC
         LIMIT 1
       ) r ON r.status <> 'running'
       WHERE o.heartbeat_id = h.id
       ORDER BY o.scheduled_for DESC
       LIMIT 1
     ) last`,
    [heartbeatIds],
  );
  return rows.map((row) => ({
    heartbeatId: row.heartbeat_id,
    scheduledFor: row.scheduled_for.toISOString(),
    runId: row.run_id,
  }));
}

/** One `WHERE` on id and project, so another project's id is indistinguishable from an unknown one. */
export async function getHeartbeatForProject(
  client: Pool | PoolClient,
  projectItemId: string,
  heartbeatId: string,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<HeartbeatRow | null> {
  const { rows } = await client.query<HeartbeatDbRow>(
    `SELECT ${COLUMNS} FROM project_heartbeats WHERE id = $1 AND project_item_id = $2`,
    [heartbeatId, projectItemId],
  );
  return rows[0] ? mapRow(rows[0], moduleRuleKinds, { tolerateUnknownRuleKind: true }) : null;
}

/**
 * `$1` is the calling run's project. Excludes heartbeats of a project holding a `read`/`write` grant on a
 * `sensitive` database the caller lacks (their results could reveal it). `none` rows are refusals, not grants.
 */
const SENSITIVE_PROJECT_HEARTBEAT_EXCLUSION = `NOT EXISTS (
  SELECT 1 FROM agent_database_grants own_grant
  JOIN databases d ON d.id = own_grant.database_id AND d.sensitive
  WHERE own_grant.project_item_id = h.project_item_id AND own_grant.access IN ('read', 'write')
    AND NOT EXISTS (
      SELECT 1 FROM agent_database_grants caller_grant
      WHERE caller_grant.project_item_id = $1 AND caller_grant.database_id = own_grant.database_id
        AND caller_grant.access IN ('read', 'write')))`;

/** Oldest first, minus the sensitive exclusion; tenant isolation is the table's RLS. */
export async function listHeartbeatsVisibleToChatRun(
  client: Pool | PoolClient,
  callingProjectItemId: string,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<HeartbeatRow[]> {
  const { rows } = await client.query<HeartbeatDbRow>(
    `SELECT ${COLUMNS} FROM project_heartbeats h
     WHERE ${SENSITIVE_PROJECT_HEARTBEAT_EXCLUSION}
     ORDER BY h.created_at ASC`,
    [callingProjectItemId],
  );
  return rows.map((row) => mapRow(row, moduleRuleKinds, { tolerateUnknownRuleKind: true }));
}

/** One statement; unknown, other-tenant and excluded ids all give `null`. */
export async function getHeartbeatVisibleToChatRun(
  client: Pool | PoolClient,
  callingProjectItemId: string,
  heartbeatId: string,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<HeartbeatRow | null> {
  const { rows } = await client.query<HeartbeatDbRow>(
    `SELECT ${COLUMNS} FROM project_heartbeats h
     WHERE h.id = $2 AND ${SENSITIVE_PROJECT_HEARTBEAT_EXCLUSION}`,
    [callingProjectItemId, heartbeatId],
  );
  return rows[0] ? mapRow(rows[0], moduleRuleKinds, { tolerateUnknownRuleKind: true }) : null;
}

/** Same sensitive exclusion, for a project that has no heartbeat to look up yet. */
export async function isProjectReachableByChatRun(
  client: Pool | PoolClient,
  callingProjectItemId: string,
  targetProjectItemId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ reachable: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM (SELECT $2::uuid AS project_item_id) h WHERE ${SENSITIVE_PROJECT_HEARTBEAT_EXCLUSION}
     ) AS reachable`,
    [callingProjectItemId, targetProjectItemId],
  );
  return rows[0]?.reachable === true;
}

/**
 * `FOR UPDATE`, scoped to `projectItemId` or (when `null`) the tenant, so the enabled check and enqueue hold
 * against `setHeartbeatEnabled`. Must run inside `withTransaction`.
 */
export async function lockHeartbeatForManualFire(
  client: PoolClient,
  heartbeatId: string,
  projectItemId: string | null,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<HeartbeatRow | null> {
  const { rows } = await client.query<HeartbeatDbRow>(
    `SELECT ${COLUMNS} FROM project_heartbeats
     WHERE id = $1 AND ($2::uuid IS NULL OR project_item_id = $2::uuid)
     FOR UPDATE`,
    [heartbeatId, projectItemId],
  );
  return rows[0] ? mapRow(rows[0], moduleRuleKinds, { tolerateUnknownRuleKind: true }) : null;
}

/** Reads only the current `enabled` flag, never the old rule, so replacing a rule of a deactivated module works. */
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
  await assertOnItemEventDatabaseExists(client, rule);
  const nextFireAt =
    existingRows[0].enabled && !isOnItemEventRule(rule)
      ? await computeNextFireAtNow(client, rule, moduleRuleKinds)
      : null;

  const { rows } = await client.query<HeartbeatDbRow>(
    `UPDATE project_heartbeats SET rule = $2::jsonb, next_fire_at = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, JSON.stringify(rule), nextFireAt],
  );
  return announceUserHeartbeatChange(client, mapRow(requireSingleRow(rows, "project_heartbeats row"), moduleRuleKinds));
}

export const HEARTBEAT_NAME_MAX_LENGTH = 200;
export const HEARTBEAT_TASK_MAX_LENGTH = 4000;

/** Touches only `name`, so a deactivated module's rule does not block a rename. `null` when not visible. */
export async function updateHeartbeatName(
  client: Pool | PoolClient,
  id: string,
  name: string,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<HeartbeatRow | null> {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length === 0 || trimmed.length > HEARTBEAT_NAME_MAX_LENGTH) {
    throw new ValidationError(`'name' must be 1-${HEARTBEAT_NAME_MAX_LENGTH} characters after trimming`, {
      field: "name",
    });
  }
  const { rows, rowCount } = await client.query<HeartbeatDbRow>(
    `UPDATE project_heartbeats SET name = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, trimmed],
  );
  return rowCount && rows[0] ? mapRow(rows[0], moduleRuleKinds, { tolerateUnknownRuleKind: true }) : null;
}

/** Keeps other `action_config` keys. `null` when not visible; a non-`core.agentRun` heartbeat is a validation error. */
export async function updateHeartbeatTask(
  client: Pool | PoolClient,
  id: string,
  task: string,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<HeartbeatRow | null> {
  if (typeof task !== "string" || task.trim().length === 0 || task.length > HEARTBEAT_TASK_MAX_LENGTH) {
    throw new ValidationError(`'task' must be a non-empty string of at most ${HEARTBEAT_TASK_MAX_LENGTH} characters`, {
      field: "task",
    });
  }
  // The action check is part of the UPDATE's WHERE, so a concurrent action change cannot slip in between.
  const { rows, rowCount } = await client.query<HeartbeatDbRow>(
    `UPDATE project_heartbeats
     SET action_config = jsonb_set(action_config, '{task}', to_jsonb($2::text))
     WHERE id = $1 AND action_id = $3
     RETURNING ${COLUMNS}`,
    [id, task, CORE_AGENT_RUN_ACTION_ID],
  );
  if (rowCount && rows[0]) return mapRow(rows[0], moduleRuleKinds, { tolerateUnknownRuleKind: true });
  const { rows: existing } = await client.query<{ action_id: string }>(
    `SELECT action_id FROM project_heartbeats WHERE id = $1`,
    [id],
  );
  if (!existing[0]) return null;
  throw new ValidationError(`Heartbeat action '${existing[0].action_id}' has no task to change`, {
    field: "actionId",
  });
}

/** Re-enabling recomputes from now (missed occurrences are not caught up). User heartbeats announce after commit. */
export async function setHeartbeatEnabled(
  client: PoolClient,
  id: string,
  enabled: boolean,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<HeartbeatRow> {
  if (!enabled) {
    // Disabling must not depend on the rule parsing: a heartbeat of a deactivated module must be disable-able.
    const { rows } = await client.query<HeartbeatDbRow>(
      `UPDATE project_heartbeats SET enabled = false, next_fire_at = NULL WHERE id = $1 RETURNING ${COLUMNS}`,
      [id],
    );
    if (!rows[0]) throw new NotFoundError(`Heartbeat ${id} not found`);
    return announceUserHeartbeatChange(client, mapRow(rows[0], moduleRuleKinds, { tolerateUnknownRuleKind: true }));
  }

  // Re-enabling needs the rule to pick a calculator, so this throws while the owning module is inactive.
  const heartbeat = await requireHeartbeat(client, id, moduleRuleKinds);
  const nextFireAt = !isOnItemEventRule(heartbeat.rule)
    ? await computeNextFireAtNow(client, heartbeat.rule, moduleRuleKinds)
    : null;

  const { rows } = await client.query<HeartbeatDbRow>(
    `UPDATE project_heartbeats SET enabled = true, next_fire_at = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, nextFireAt],
  );
  return announceUserHeartbeatChange(client, mapRow(requireSingleRow(rows, "project_heartbeats row"), moduleRuleKinds));
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
    // One unresolvable rule must not abort the batch (and the timezone transaction): record it, keep its next_fire_at.
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

/** `suffix` is an `itemId` or a batch for an `onItemEvent` fire; distinct suffixes never replace each other's job. */
export function heartbeatFireJobKey(heartbeatId: string, suffix?: string): string {
  return suffix ? `heartbeat-fire:${heartbeatId}:${suffix}` : `heartbeat-fire:${heartbeatId}`;
}

/** One key per generation, so a reactivated occurrence is never mistaken for an old handler's job. */
export function occurrenceFireJobKey(heartbeatId: string, occurrenceId: string, generation: number): string {
  return `heartbeat-fire:${heartbeatId}:${occurrenceId}:${generation}`;
}

/** Distinct from scheduler keys so manual and scheduled fires never steal attribution; repeats collapse. */
export function manualHeartbeatFireJobKey(heartbeatId: string): string {
  return `heartbeat-fire:manual:${heartbeatId}`;
}

/** Repeated retries of one run collapse; distinct from manual and scheduler keys. */
export function retryHeartbeatFireJobKey(runId: string): string {
  return `heartbeat-fire:retry:${runId}`;
}

const HEARTBEAT_OCCURRENCE_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type HeartbeatOccurrenceStatus = (typeof HEARTBEAT_OCCURRENCE_STATUSES)[number];

/** A missing occurrence (FK from `agent_runs`) or unknown status throws. */
export async function getHeartbeatOccurrenceStatus(
  client: Pool | PoolClient,
  occurrenceId: string,
): Promise<HeartbeatOccurrenceStatus> {
  const { rows } = await client.query<{ status: string }>(`SELECT status FROM heartbeat_occurrences WHERE id = $1`, [
    occurrenceId,
  ]);
  return assertKnownValue(
    HEARTBEAT_OCCURRENCE_STATUSES,
    requireSingleRow(rows, "heartbeat_occurrences row").status,
    "heartbeat occurrence status",
  );
}

/**
 * Matches every key starting `heartbeatFireJobKey(id)` + `:`. Only runnable jobs count (locked or attempts
 * left): a permanently failed job keeps its key until pruned. Reads graphile-worker 0.17.3's `jobs` view.
 */
export async function hasWaitingHeartbeatFireJob(client: Pool | PoolClient, heartbeatId: string): Promise<boolean> {
  const { rows } = await client.query<{ waiting: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM graphile_worker.jobs
       WHERE (key = $1 OR starts_with(key, $2))
         AND (locked_at IS NOT NULL OR attempts < max_attempts)
     ) AS waiting`,
    [manualHeartbeatFireJobKey(heartbeatId), `${heartbeatFireJobKey(heartbeatId)}:`],
  );
  return requireSingleRow(rows, "heartbeat fire job lookup").waiting;
}

/**
 * Per managed transaction and heartbeat, the key and the item ids of its batched fire job. A savepoint rolled back
 * after an item was added leaves that id in the batch; the handlers treat an item that is gone as no work, as they do
 * for one deleted before its fire.
 */
const itemEventBatches = new TransactionLocal(() => new Map<string, { jobKey: string; itemIds: string[] }>());

/**
 * Runs in the item write's transaction. These heartbeats keep `next_fire_at` NULL, invisible to the sweep. An action in
 * `ITEM_EVENT_BATCH_ACTION_IDS` gets one job per heartbeat and transaction carrying every item id (re-enqueued under
 * the same key, so the uncommitted job's payload grows); every other action one job per item.
 */
export async function triggerOnItemEventHeartbeats(
  client: PoolClient,
  databaseId: string,
  event: "create" | "update" | "delete",
  itemId: string,
  queueAffinity: ActionQueueAffinity = createActionQueueAffinity(),
): Promise<void> {
  // Served by project_heartbeats_on_item_event_idx: its partial predicate must match this WHERE verbatim.
  const { rows } = await client.query<{ id: string; action_id: string }>(
    `SELECT id, action_id FROM project_heartbeats
     WHERE enabled
       AND rule ->> 'kind' = 'onItemEvent'
       AND rule ->> 'databaseId' = $1
       AND rule ->> 'event' = $2`,
    [databaseId, event],
  );
  for (const row of rows) {
    const baseLane = queueAffinity.get(row.action_id);
    const queueName =
      resolveAgentRunLane(row.action_id) ?? (baseLane === undefined ? undefined : (tenantLane(baseLane) ?? baseLane));
    const batches = ITEM_EVENT_BATCH_ACTION_IDS.has(row.action_id) ? itemEventBatches.get(client) : undefined;
    if (batches) {
      let batch = batches.get(row.id);
      if (!batch) {
        batch = { jobKey: heartbeatFireJobKey(row.id, `batch:${randomUUID()}`), itemIds: [] };
        batches.set(row.id, batch);
      }
      if (!batch.itemIds.includes(itemId)) batch.itemIds.push(itemId);
      await enqueueJob(
        client,
        resolveHeartbeatFireTaskName(row.action_id),
        { heartbeatId: row.id, itemIds: [...batch.itemIds] },
        { jobKey: batch.jobKey, maxAttempts: 3, queueName },
      );
      continue;
    }
    await enqueueJob(
      client,
      resolveHeartbeatFireTaskName(row.action_id),
      { heartbeatId: row.id, itemId },
      { jobKey: heartbeatFireJobKey(row.id, itemId), maxAttempts: 3, queueName },
    );
  }
}

export interface SweptHeartbeat {
  id: string;
}

/** See {@link sweepDueHeartbeats} for `lastId`/`exhausted`. */
export interface SweepChunkResult {
  fired: SweptHeartbeat[];
  lastId: string | null;
  exhausted: boolean;
}

/** Keyset page size; one transaction per chunk. */
const SWEEP_CHUNK_SIZE = 100;

export interface OccurrenceInsertResult {
  occurrenceId: string;
  generation: number;
  jobKeyMode: "replace" | "preserve_run_at";
}

/**
 * Inserts the `queued` occurrence (`scheduled_for` = old `next_fire_at`) or handles the conflict:
 * - `cancelled`: reactivate with a new snapshot and bumped `generation`;
 * - `queued` with a stale snapshot: replace it and bump `generation` (a starting handler waits on the lock);
 * - otherwise a no-op returning `null` (no enqueue, no schedule advance).
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

  // Same locks the sweep holds, so a concurrent handler start (its FOR UPDATE on this row) waits for the
  // reactivation and then re-reads snapshot and generation.
  const { rows: existingRows } = await client.query<{ id: string; status: string; snapshot_matches: boolean }>(
    `SELECT id, status, (rule_snapshot = $3::jsonb) AS snapshot_matches
     FROM heartbeat_occurrences WHERE heartbeat_id = $1 AND scheduled_for = $2 FOR UPDATE`,
    [heartbeatId, scheduledFor, snapshotJson],
  );
  const existing = existingRows[0];
  if (!existing) return null; // vanished by cascade between the insert and this lock

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

  return null; // never reactivatable
}

/**
 * One chunk of the minute sweep. `FOR UPDATE SKIP LOCKED` gives exactly-once firing across overlapping
 * sweeps and is the catch-up policy: a time missed while down fires once after restart.
 *
 * Fixed rules move to their next calendar time here; floating rules get `NULL` until the first attempt
 * computes it from the real start. Paginated by `id`, not `next_fire_at`, so rows deliberately left due
 * do not head every page. Times use the row's `db_now`, never the app clock, which could lag and stall a rule.
 */
export async function sweepDueHeartbeats(
  client: PoolClient,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
  afterId: string | null = null,
): Promise<SweepChunkResult> {
  const { rows } = await client.query<{
    id: string;
    rule: unknown;
    next_fire_at: Date;
    action_id: string;
    db_now: Date;
  }>(
    `SELECT id, rule, next_fire_at, action_id, now() AS db_now FROM project_heartbeats
     WHERE enabled AND next_fire_at IS NOT NULL AND next_fire_at <= now()
       AND ($1::uuid IS NULL OR id > $1)
     ORDER BY id
     LIMIT $2
     FOR UPDATE SKIP LOCKED`,
    [afterId, SWEEP_CHUNK_SIZE],
  );
  if (rows.length === 0) return { fired: [], lastId: null, exhausted: true };

  const timezone = await getSystemTimezone(client);
  const fired: SweptHeartbeat[] = [];
  for (const row of rows) {
    // A rule of a module deactivated since last scheduling is not dispatched: record the failure and keep
    // next_fire_at due, so reactivating the module lets a later sweep pick it up.
    let rule: AnyHeartbeatRule;
    let calendarNextFireAt: Date | null;
    try {
      rule = parseHeartbeatRule(row.rule, moduleRuleKinds);
      calendarNextFireAt = computeNextFireAt(rule, timezone, row.db_now, moduleRuleKinds);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordHeartbeatFailure(client, row.id, message);
      continue;
    }

    const reactivation = await insertHeartbeatOccurrence(client, row.id, row.next_fire_at, rule);
    if (!reactivation) continue; // a non-reactivatable occurrence for this due time already exists
    const { occurrenceId, generation, jobKeyMode } = reactivation;

    const nextFireAt = isFloatingRuleKind(rule.kind) ? null : calendarNextFireAt;
    await client.query(`UPDATE project_heartbeats SET next_fire_at = $2 WHERE id = $1`, [row.id, nextFireAt]);
    await enqueueJob(
      client,
      resolveHeartbeatFireTaskName(row.action_id),
      { heartbeatId: row.id, occurrenceId, generation },
      {
        jobKey: occurrenceFireJobKey(row.id, occurrenceId, generation),
        maxAttempts: 3,
        jobKeyMode,
        queueName: resolveAgentRunLane(row.action_id),
      },
    );
    fired.push({ id: row.id });
  }
  const lastRow = rows[rows.length - 1];
  return { fired, lastId: lastRow ? lastRow.id : null, exhausted: rows.length < SWEEP_CHUNK_SIZE };
}

export type OccurrenceFirePreparation =
  | { outcome: "missing" }
  | { outcome: "stale" }
  | { outcome: "cancelled" }
  | { outcome: "degraded" }
  | { outcome: "proceed"; heartbeat: HeartbeatRow };

/**
 * The fire task's first step, in its own short transaction (never held across the handler):
 * 1. a stale `generation` is a no-op, so an old handler never touches a reactivated occurrence;
 * 2. `rule` vs `rule_snapshot` by `jsonb` equality; disabled or mismatched cancels the occurrence;
 * 3. only a first attempt sets the start, `running`, `last_fired_at` and a floating `next_fire_at`.
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
      origin: string;
      first_started_at: Date | null;
      generation: number;
      rules_match: boolean;
    }>(
      `SELECT h.id, h.project_item_id, h.name, h.rule, h.action_id, h.action_config, h.enabled,
              h.next_fire_at, h.last_fired_at, h.last_error, h.origin,
              o.first_started_at, o.generation, (h.rule = o.rule_snapshot) AS rules_match
       FROM heartbeat_occurrences o
       JOIN project_heartbeats h ON h.id = o.heartbeat_id
       WHERE o.id = $1 AND o.heartbeat_id = $2
       FOR UPDATE`,
      [occurrenceId, heartbeatId],
    );
    const row = rows[0];
    if (!row) return { outcome: "missing" }; // deleted (cascade) since enqueue

    if (row.generation !== generation) return { outcome: "stale" }; // superseded by a reactivation

    if (!row.enabled || !row.rules_match) {
      await client.query(`UPDATE heartbeat_occurrences SET status = 'cancelled' WHERE id = $1`, [occurrenceId]);
      return { outcome: "cancelled" };
    }

    // The rule's module went inactive since enqueue: degrade (record, do not execute) instead of retrying.
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

    // Tolerates an unparseable rule: dispatch only needs action, config and project, so this degrades
    // instead of becoming a retriable job error.
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

/**
 * Final-attempt close-out when setup (preparation, affinity, handler lookup) threw. Restores a floating
 * rule's `NULL` `next_fire_at` from the database clock if it can, and fails a `queued`/`running` occurrence.
 */
export async function recordHeartbeatFireSetupFailure(
  client: PoolClient,
  heartbeatId: string,
  occurrenceId: string | undefined,
  message: string,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<{ id: string; name: string } | null> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    rule: unknown;
    enabled: boolean;
    next_fire_at: Date | null;
    db_now: Date;
  }>(
    `SELECT id, name, rule, enabled, next_fire_at, now() AS db_now
     FROM project_heartbeats WHERE id = $1 FOR UPDATE`,
    [heartbeatId],
  );
  const row = rows[0];
  if (!row) return null;

  if (row.enabled && row.next_fire_at === null) {
    // Read before the try: a database failure must propagate as itself, not be recorded as an unrestorable rule.
    const timezone = await getSystemTimezone(client);
    let restored: { ok: true; nextFireAt: Date | null } | { ok: false; error: string };
    try {
      const rule = parseHeartbeatRule(row.rule, moduleRuleKinds);
      const nextFireAt = computeNextFireAt(rule, timezone, row.db_now, moduleRuleKinds);
      restored = { ok: true, nextFireAt };
    } catch (err) {
      restored = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (restored.ok) {
      requireAffectedRows(
        await client.query(`UPDATE project_heartbeats SET next_fire_at = $2, last_error = $3 WHERE id = $1`, [
          heartbeatId,
          restored.nextFireAt,
          message,
        ]),
        "project_heartbeats schedule restore",
      );
    } else {
      requireAffectedRows(
        await client.query(`UPDATE project_heartbeats SET last_error = $2 WHERE id = $1`, [
          heartbeatId,
          `${message}; schedule could not be restored: ${restored.error}`,
        ]),
        "project_heartbeats last_error update",
      );
    }
  } else {
    requireAffectedRows(
      await client.query(`UPDATE project_heartbeats SET last_error = $2 WHERE id = $1`, [heartbeatId, message]),
      "project_heartbeats last_error update",
    );
  }

  if (occurrenceId !== undefined) {
    // Zero rows is valid: the occurrence is already terminal or gone.
    await client.query(
      `UPDATE heartbeat_occurrences SET status = 'failed', last_error = $2
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [occurrenceId, message],
    );
  }

  return { id: row.id, name: row.name };
}
