import type { Pool } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import type { Queryable } from "../db/pool.js";
import { getProperty } from "../chokePoint/propertiesStore.js";
import { writeComputed } from "../chokePoint/itemsStore.js";
import { getRollupDependency } from "./dependencies.js";
import { parseRollupConfig, type RollupAggregation } from "./config.js";

export function rollupRecomputeJobKey(rollupPropertyId: string, itemId: string): string {
  return `rollup-recompute:${rollupPropertyId}:${itemId}`;
}

export function rollupRecomputeFullJobKey(rollupPropertyId: string): string {
  return `rollup-recompute:${rollupPropertyId}:full`;
}

/** Enqueues a single-cell recompute; must be called in the same transaction as the triggering write. */
export async function enqueueRollupRecompute(client: Queryable, rollupPropertyId: string, itemId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.ROLLUP_RECOMPUTE,
    { rollupPropertyId, itemId },
    { jobKey: rollupRecomputeJobKey(rollupPropertyId, itemId), maxAttempts: 3 },
  );
}

/** Enqueues the backfill job (walks all parent rows and enqueues a per-cell job for each). */
export async function enqueueRollupBackfill(client: Queryable, rollupPropertyId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL,
    { rollupPropertyId },
    { jobKey: rollupRecomputeFullJobKey(rollupPropertyId), maxAttempts: 3 },
  );
}

function aggregationSql(aggregation: RollupAggregation): { select: string } {
  switch (aggregation) {
    case "count":
      return { select: "count(*)::int" };
    case "count_filled":
      return { select: "count(*) FILTER (WHERE t.properties ? $3 AND t.properties -> $3 IS DISTINCT FROM 'null'::jsonb)::int" };
    case "count_empty":
      return { select: "count(*) FILTER (WHERE NOT (t.properties ? $3) OR t.properties -> $3 IS NOT DISTINCT FROM 'null'::jsonb)::int" };
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
      // ::float8, not the bare numeric sum/avg/min/max — node-pg returns `numeric` as a
      // string (to avoid silent precision loss), but a number-typed property needs a JS number.
      return { select: `${aggregation}(${filtered})::float8` };
    }
    case "earliest":
      return { select: "min((t.properties ->> $3)::timestamptz)" };
    case "latest":
      return { select: "max((t.properties ->> $3)::timestamptz)" };
  }
}

/** The actual aggregation: one SQL query over item_relations JOIN items, always a full recompute of one cell. */
export async function recomputeRollupCell(pool: Pool, rollupPropertyId: string, itemId: string): Promise<void> {
  const client = await pool.connect();
  try {
    const dependency = await getRollupDependency(client, rollupPropertyId);
    if (!dependency) return; // rollup property (or its dependency row) was deleted since the job was enqueued

    const rollupProperty = await getProperty(client, rollupPropertyId);
    if (!rollupProperty) return;
    const config = parseRollupConfig(rollupProperty.config);
    const { select } = aggregationSql(config.aggregation);

    // $3 (targetPropertyKey) is always bound, even when `select` doesn't use it (e.g.
    // 'count') — Postgres infers a placeholder's type from where it's referenced in the
    // query text, and errors ("could not determine data type of parameter $3") if a
    // later placeholder ($4) is used but $3 never appears at all. The tautological
    // `$3::text IS NULL OR $3::text IS NOT NULL` gives it an explicit, harmless context.
    const { rows } = await client.query(
      `SELECT ${select} AS value
       FROM item_relations ir
       JOIN items t ON t.database_id = $4 AND t.id = (CASE WHEN ir.item_a = $2 THEN ir.item_b ELSE ir.item_a END)
       WHERE ir.relation_definition_id = $1 AND (ir.item_a = $2 OR ir.item_b = $2) AND t.deleted_at IS NULL
         AND ($3::text IS NULL OR $3::text IS NOT NULL)`,
      [dependency.relationDefinitionId, itemId, config.targetPropertyKey ?? null, dependency.sourceDatabaseId],
    );

    const value = rows[0]?.value ?? (config.aggregation === "count" ? 0 : null);
    await writeComputed(client, rollupProperty.databaseId, itemId, rollupProperty.key, value);
  } finally {
    client.release();
  }
}

/** Backfill: never writes cells itself — walks all non-deleted parent rows and enqueues a per-cell job for each. */
export async function backfillRollup(pool: Pool, rollupPropertyId: string): Promise<void> {
  const client = await pool.connect();
  try {
    const rollupProperty = await getProperty(client, rollupPropertyId);
    if (!rollupProperty) return;

    let cursor: string | null = null;
    const pageSize = 500;
    for (;;) {
      const { rows }: { rows: Array<{ id: string }> } = await client.query(
        `SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL ${cursor ? "AND id > $3" : ""}
         ORDER BY id ASC LIMIT $2`,
        cursor ? [rollupProperty.databaseId, pageSize, cursor] : [rollupProperty.databaseId, pageSize],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        await enqueueRollupRecompute(client, rollupPropertyId, row.id);
      }
      if (rows.length < pageSize) break;
      cursor = rows[rows.length - 1].id;
    }
  } finally {
    client.release();
  }
}

export async function handleRollupRecomputeTask(pool: Pool, payload: { rollupPropertyId: string; itemId: string }): Promise<void> {
  await recomputeRollupCell(pool, payload.rollupPropertyId, payload.itemId);
}

export async function handleRollupRecomputeFullTask(pool: Pool, payload: { rollupPropertyId: string }): Promise<void> {
  await backfillRollup(pool, payload.rollupPropertyId);
}
