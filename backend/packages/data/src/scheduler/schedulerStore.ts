import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { NotFoundError } from "../errors.js";
import { getSystemTimezone } from "../systemSettings.js";
import { computeNextFireAt } from "./nextFireAt.js";
import { heartbeatRuleSchema, isOnItemEventRule, type HeartbeatRule } from "./rule.js";

export interface HeartbeatRow {
  id: string;
  projectItemId: string;
  name: string;
  rule: HeartbeatRule;
  actionId: string;
  actionConfig: Record<string, unknown>;
  enabled: boolean;
  nextFireAt: string | null;
  lastFiredAt: string | null;
  lastError: string | null;
}

function mapRow(row: {
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
}): HeartbeatRow {
  return {
    id: row.id,
    projectItemId: row.project_item_id,
    name: row.name,
    rule: heartbeatRuleSchema.parse(row.rule),
    actionId: row.action_id,
    actionConfig: row.action_config,
    enabled: row.enabled,
    nextFireAt: row.next_fire_at ? row.next_fire_at.toISOString() : null,
    lastFiredAt: row.last_fired_at ? row.last_fired_at.toISOString() : null,
    lastError: row.last_error,
  };
}

const COLUMNS = "id, project_item_id, name, rule, action_id, action_config, enabled, next_fire_at, last_fired_at, last_error";

export interface CreateHeartbeatInput {
  projectItemId: string;
  name: string;
  rule: unknown;
  actionId: string;
  actionConfig?: Record<string, unknown>;
  enabled?: boolean;
}

export async function createHeartbeat(client: PoolClient, input: CreateHeartbeatInput): Promise<HeartbeatRow> {
  const rule = heartbeatRuleSchema.parse(input.rule);
  const enabled = input.enabled ?? true;
  const nextFireAt = enabled && !isOnItemEventRule(rule) ? await computeNextFireAtNow(client, rule) : null;

  const { rows } = await client.query(
    `INSERT INTO project_heartbeats (project_item_id, name, rule, action_id, action_config, enabled, next_fire_at)
     VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)
     RETURNING ${COLUMNS}`,
    [input.projectItemId, input.name, JSON.stringify(rule), input.actionId, JSON.stringify(input.actionConfig ?? {}), enabled, nextFireAt],
  );
  return mapRow(rows[0]);
}

async function computeNextFireAtNow(client: PoolClient, rule: HeartbeatRule): Promise<Date | null> {
  const timezone = await getSystemTimezone(client);
  return computeNextFireAt(rule, timezone, new Date());
}

export async function getHeartbeat(client: PoolClient, id: string): Promise<HeartbeatRow | null> {
  const { rows } = await client.query(`SELECT ${COLUMNS} FROM project_heartbeats WHERE id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

async function requireHeartbeat(client: PoolClient, id: string): Promise<HeartbeatRow> {
  const heartbeat = await getHeartbeat(client, id);
  if (!heartbeat) throw new NotFoundError(`Heartbeat ${id} not found`);
  return heartbeat;
}

/** Recomputes next_fire_at using the same pure function as the sweep — deterministic at write time. */
export async function updateHeartbeatRule(client: PoolClient, id: string, rawRule: unknown): Promise<HeartbeatRow> {
  const heartbeat = await requireHeartbeat(client, id);
  const rule = heartbeatRuleSchema.parse(rawRule);
  const nextFireAt = heartbeat.enabled && !isOnItemEventRule(rule) ? await computeNextFireAtNow(client, rule) : null;

  const { rows } = await client.query(
    `UPDATE project_heartbeats SET rule = $2::jsonb, next_fire_at = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, JSON.stringify(rule), nextFireAt],
  );
  return mapRow(rows[0]);
}

/** Disabling is a plain flag flip; re-enabling recomputes from now — occurrences missed while paused are not caught up. */
export async function setHeartbeatEnabled(client: PoolClient, id: string, enabled: boolean): Promise<HeartbeatRow> {
  const heartbeat = await requireHeartbeat(client, id);
  const nextFireAt = enabled && !isOnItemEventRule(heartbeat.rule) ? await computeNextFireAtNow(client, heartbeat.rule) : null;

  const { rows } = await client.query(
    `UPDATE project_heartbeats SET enabled = $2, next_fire_at = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, enabled, enabled ? nextFireAt : null],
  );
  return mapRow(rows[0]);
}

/** Called in the same transaction as the `timezone` settings write. */
export async function recomputeAllForTimezoneChange(client: PoolClient, newTimezone: string): Promise<void> {
  const { rows } = await client.query<{ id: string; rule: unknown }>(
    `SELECT id, rule FROM project_heartbeats WHERE enabled AND next_fire_at IS NOT NULL FOR UPDATE`,
  );
  for (const row of rows) {
    const rule = heartbeatRuleSchema.parse(row.rule);
    const nextFireAt = computeNextFireAt(rule, newTimezone, new Date());
    await client.query(`UPDATE project_heartbeats SET next_fire_at = $2 WHERE id = $1`, [row.id, nextFireAt]);
  }
}

export async function recordHeartbeatSuccess(client: Pool | PoolClient, id: string): Promise<void> {
  await client.query(`UPDATE project_heartbeats SET last_error = NULL WHERE id = $1`, [id]);
}

export async function recordHeartbeatFailure(client: Pool | PoolClient, id: string, error: string): Promise<void> {
  await client.query(`UPDATE project_heartbeats SET last_error = $2 WHERE id = $1`, [id, error]);
}

export function heartbeatFireJobKey(heartbeatId: string, itemId?: string): string {
  return itemId ? `heartbeat-fire:${heartbeatId}:${itemId}` : `heartbeat-fire:${heartbeatId}`;
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
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM project_heartbeats
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
      { jobKey: heartbeatFireJobKey(row.id, itemId), maxAttempts: 3 },
    );
  }
}

export interface SweptHeartbeat {
  id: string;
}

/**
 * The minute-granularity sweep: `FOR UPDATE SKIP LOCKED` is what guarantees "exactly
 * once", not transaction atomicity nor jobKey — two overlapping sweeps could otherwise
 * both select the same row under READ COMMITTED. This same query and update also *is*
 * the catch-up policy: a row whose next_fire_at fell in the past while the server was
 * down is picked up on the first sweep after restart and fired exactly once, with the
 * same "compute the next occurrence from now" logic as a regular on-time fire.
 */
export async function sweepDueHeartbeats(client: PoolClient): Promise<SweptHeartbeat[]> {
  const { rows } = await client.query<{ id: string; rule: unknown }>(
    `SELECT id, rule FROM project_heartbeats
     WHERE enabled AND next_fire_at IS NOT NULL AND next_fire_at <= now()
     FOR UPDATE SKIP LOCKED`,
  );
  if (rows.length === 0) return [];

  const timezone = await getSystemTimezone(client);
  const now = new Date();
  const fired: SweptHeartbeat[] = [];
  for (const row of rows) {
    const rule = heartbeatRuleSchema.parse(row.rule);
    const nextFireAt = computeNextFireAt(rule, timezone, now);
    await client.query(`UPDATE project_heartbeats SET next_fire_at = $2, last_fired_at = $3 WHERE id = $1`, [row.id, nextFireAt, now]);
    await enqueueJob(client, CORE_TASK_NAMES.HEARTBEAT_FIRE, { heartbeatId: row.id }, { jobKey: heartbeatFireJobKey(row.id), maxAttempts: 3 });
    fired.push({ id: row.id });
  }
  return fired;
}
