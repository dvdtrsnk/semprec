// Rollup recompute scheduling and execution: job keys, per-cell/backfill/per-edge enqueues, and the task handlers.
import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@alldots/queue";
import { runAfterCommit, withTransaction, type Queryable } from "../db/pool.js";
import { getProperty } from "../chokePoint/propertiesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { lockItemById, writeComputed } from "../chokePoint/itemsStore.js";
import { findDependenciesByRelationDefinition, getRollupDependency } from "./dependencies.js";
import { parseRollupConfig, type RollupAggregation } from "./config.js";
import { tenantLane } from "../tenancy/tenantLane.js";
import { notifyInvalidation } from "../realtimeHook.js";

const ROLLUP_RECOMPUTE_LANE = "rollup-recompute";
const ROLLUP_BACKFILL_LANE = "rollup-backfill";

export function rollupRecomputeJobKey(rollupPropertyId: string, itemId: string): string {
  return `rollup-recompute:${rollupPropertyId}:${itemId}`;
}

export function rollupRecomputeFullJobKey(rollupPropertyId: string): string {
  return `rollup-recompute:${rollupPropertyId}:full`;
}

/** Enqueues a single-cell recompute; must be called in the same transaction as the triggering write. */
export async function enqueueRollupRecompute(
  client: Queryable,
  rollupPropertyId: string,
  itemId: string,
): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.ROLLUP_RECOMPUTE,
    { rollupPropertyId, itemId },
    {
      jobKey: rollupRecomputeJobKey(rollupPropertyId, itemId),
      maxAttempts: 3,
      queueName: tenantLane(ROLLUP_RECOMPUTE_LANE),
    },
  );
}

export async function enqueueRollupBackfill(client: Queryable, rollupPropertyId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL,
    { rollupPropertyId },
    {
      jobKey: rollupRecomputeFullJobKey(rollupPropertyId),
      maxAttempts: 3,
      queueName: tenantLane(ROLLUP_BACKFILL_LANE),
    },
  );
}

// `date` values are unvalidated JSON strings; a garbage one is skipped rather than failing the `::timestamptz` cast.
const ISO_DATE_PATTERN = "'^\\d{4}-\\d{2}-\\d{2}(T[\\d:.+\\-Z]*)?$'";
const GUARDED_TIMESTAMP = `(CASE WHEN (t.properties ->> $3) ~ ${ISO_DATE_PATTERN} THEN (t.properties ->> $3)::timestamptz END)`;

function aggregationSql(aggregation: RollupAggregation): { select: string } {
  switch (aggregation) {
    case "count":
      return { select: "count(*)::int" };
    case "count_filled":
      return {
        select: "count(*) FILTER (WHERE t.properties ? $3 AND t.properties -> $3 IS DISTINCT FROM 'null'::jsonb)::int",
      };
    case "count_empty":
      return {
        select:
          "count(*) FILTER (WHERE NOT (t.properties ? $3) OR t.properties -> $3 IS NOT DISTINCT FROM 'null'::jsonb)::int",
      };
    case "percent_filled":
      return {
        select:
          "CASE WHEN count(*) = 0 THEN 0 ELSE count(*) FILTER (WHERE t.properties ? $3 AND t.properties -> $3 IS DISTINCT FROM 'null'::jsonb)::float8 / count(*) END",
      };
    case "percent_empty":
      return {
        select:
          "CASE WHEN count(*) = 0 THEN 0 ELSE count(*) FILTER (WHERE NOT (t.properties ? $3) OR t.properties -> $3 IS NOT DISTINCT FROM 'null'::jsonb)::float8 / count(*) END",
      };
    case "sum":
    case "avg":
    case "min":
    case "max": {
      // Defensive: skip values that aren't well-formed numbers instead of failing the whole job on bad data.
      const numeric = `NULLIF(t.properties ->> $3, '') `;
      const filtered = `(CASE WHEN ${numeric}~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${numeric})::numeric END)`;
      // node-pg returns `numeric` as a string; a number property needs a JS number.
      return { select: `${aggregation}(${filtered})::float8` };
    }
    case "earliest":
      return { select: `min(${GUARDED_TIMESTAMP})` };
    case "latest":
      return { select: `max(${GUARDED_TIMESTAMP})` };
  }
}

/**
 * Always a full recompute of one cell, holding `FOR UPDATE` on the target item so overlapping jobs for a cell
 * serialize and the last committed value reflects the newest source state.
 */
export async function recomputeRollupCell(pool: Pool, rollupPropertyId: string, itemId: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    // Loaded before the lock because the lock needs the target item's database id.
    const rollupProperty = await getProperty(client, rollupPropertyId);
    if (!rollupProperty) return; // rollup property was deleted since the job was enqueued

    const locked = await lockItemById(client, rollupProperty.databaseId, itemId);
    if (!locked) return; // target item was purged since the job was enqueued

    const dependency = await getRollupDependency(client, rollupPropertyId);
    if (!dependency) return; // dependency row was deleted since the job was enqueued

    const config = parseRollupConfig(rollupProperty.config);
    const { select } = aggregationSql(config.aggregation);

    // $3 must appear in the text even when `select` ignores it, or Postgres cannot infer its type while $4 is used;
    // the tautology gives it a harmless context.
    const { rows } = await client.query<{ value: unknown }>(
      `SELECT ${select} AS value
       FROM item_relations ir
       JOIN items t ON t.database_id = $4 AND t.id = (CASE WHEN ir.item_a = $2 THEN ir.item_b ELSE ir.item_a END)
       WHERE ir.relation_definition_id = $1 AND (ir.item_a = $2 OR ir.item_b = $2) AND t.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM databases d WHERE d.id = t.database_id AND d.archived_at IS NOT NULL)
         AND ($3::text IS NULL OR $3::text IS NOT NULL)`,
      [dependency.relationDefinitionId, itemId, config.targetPropertyKey ?? null, dependency.sourceDatabaseId],
    );

    const value = rows[0]?.value ?? (config.aggregation === "count" ? 0 : null);
    await writeComputed(client, rollupProperty.databaseId, itemId, rollupProperty.key, value);
    // `writeComputed` never advances `updated_at`, so announce the locked row's value, after commit.
    runAfterCommit(client, () =>
      notifyInvalidation({
        scope: "item",
        databaseId: rollupProperty.databaseId,
        itemId,
        op: "update",
        updatedAt: locked.updatedAt,
      }),
    );
  });
}

/**
 * Only enqueues per-cell jobs. Deliberately holds no connection across the walk, which can run for minutes and would
 * starve the pool; each query checks a connection out and back in.
 */
export async function backfillRollup(pool: Pool, rollupPropertyId: string): Promise<void> {
  const bootstrapClient = await pool.connect();
  let rollupProperty;
  try {
    rollupProperty = await getProperty(bootstrapClient, rollupPropertyId);
  } finally {
    bootstrapClient.release();
  }
  if (!rollupProperty) return;

  let cursor: string | null = null;
  const pageSize = 500;
  for (;;) {
    const { rows }: { rows: Array<{ id: string }> } = await pool.query(
      `SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL ${cursor ? "AND id > $3" : ""}
       ORDER BY id ASC LIMIT $2`,
      cursor ? [rollupProperty.databaseId, pageSize, cursor] : [rollupProperty.databaseId, pageSize],
    );
    // Annotated to break an inference cycle with `cursor` (TS7022).
    const lastRow: { id: string } | undefined = rows[rows.length - 1];
    if (lastRow === undefined) break;
    for (const row of rows) {
      await enqueueRollupRecompute(pool, rollupPropertyId, row.id);
    }
    if (rows.length < pageSize) break;
    cursor = lastRow.id;
  }
}

export async function handleRollupRecomputeTask(
  pool: Pool,
  payload: { rollupPropertyId: string; itemId: string },
): Promise<void> {
  await recomputeRollupCell(pool, payload.rollupPropertyId, payload.itemId);
}

export async function handleRollupRecomputeFullTask(pool: Pool, payload: { rollupPropertyId: string }): Promise<void> {
  await backfillRollup(pool, payload.rollupPropertyId);
}

async function resolveRollupRecomputeTargets(
  client: PoolClient,
  relationDefinitionId: string,
  itemA: string,
  itemB: string,
): Promise<Array<{ rollupPropertyId: string; itemId: string }>> {
  const dependencies = await findDependenciesByRelationDefinition(client, relationDefinitionId);
  if (dependencies.length === 0) return [];

  const reldef = await relationsStore.getRelationDefinition(client, relationDefinitionId);
  if (!reldef) return [];
  const propertyA = await propertiesStore.getProperty(client, reldef.propertyIdA);
  if (!propertyA) return [];

  const targets: Array<{ rollupPropertyId: string; itemId: string }> = [];
  for (const dependency of dependencies) {
    const rollupProperty = await propertiesStore.getProperty(client, dependency.rollupPropertyId);
    if (!rollupProperty) continue;
    const parentItemId = rollupProperty.databaseId === propertyA.databaseId ? itemA : itemB;
    targets.push({ rollupPropertyId: dependency.rollupPropertyId, itemId: parentItemId });
  }
  return targets;
}

/** For deletes that unlink relations outside `softDeleteItem`. */
export async function enqueueRollupRecomputeForEdge(
  client: PoolClient,
  edge: { relationDefinitionId: string; itemA: string; itemB: string },
): Promise<void> {
  const targets = await resolveRollupRecomputeTargets(client, edge.relationDefinitionId, edge.itemA, edge.itemB);
  for (const target of targets) {
    await enqueueRollupRecompute(client, target.rollupPropertyId, target.itemId);
  }
}
