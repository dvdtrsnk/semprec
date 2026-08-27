import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import type { Queryable } from "../db/pool.js";
import { getProperty, setPropertyMigrationStatus } from "../chokePoint/propertiesStore.js";
import { findDependenciesBySource } from "../rollup/dependencies.js";
import { enqueueRollupBackfill } from "../rollup/recompute.js";
import type { PropertyType } from "../types.js";

type Converter = (value: unknown) => { ok: true; value: unknown } | { ok: false };

/** A fixed, small set of conversion functions per type pair — deliberately not exhaustive. */
const CONVERTERS: Partial<Record<PropertyType, Partial<Record<PropertyType, Converter>>>> = {
  text: {
    number: (value) => {
      if (typeof value !== "string" || value.trim() === "") return { ok: false };
      const n = Number(value);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    },
    date: (value) => {
      if (typeof value !== "string") return { ok: false };
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? { ok: false } : { ok: true, value: d.toISOString() };
    },
  },
  number: {
    text: (value) => (typeof value === "number" ? { ok: true, value: String(value) } : { ok: false }),
  },
  date: {
    text: (value) => (typeof value === "string" ? { ok: true, value } : { ok: false }),
  },
};

export function isConversionSupported(from: PropertyType, to: PropertyType): boolean {
  return from === to || Boolean(CONVERTERS[from]?.[to]);
}

export function propertyTypeMigrationJobKey(propertyId: string): string {
  return `property-type-migration:${propertyId}`;
}

/** Must run in the same transaction as the property's `type` column update. */
export async function enqueuePropertyTypeMigration(client: Queryable, propertyId: string, fromType: PropertyType): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.PROPERTY_TYPE_MIGRATION,
    { propertyId, fromType },
    { jobKey: propertyTypeMigrationJobKey(propertyId), maxAttempts: 3 },
  );
}

/**
 * Eagerly, once, immediately converts every item's value for this property to its new
 * type. An unconvertible value is left empty (not overwritten with an error); the
 * database ends up `done` (no failures) or `partial` (some rows left empty).
 */
export async function runPropertyTypeMigrationJob(pool: Pool, propertyId: string, fromType: PropertyType): Promise<void> {
  const bootstrapClient = await pool.connect();
  let property;
  try {
    property = await getProperty(bootstrapClient, propertyId);
    if (!property) return;
    await setPropertyMigrationStatus(bootstrapClient, propertyId, "running");
  } finally {
    bootstrapClient.release();
  }

  const converter = fromType === property.type ? null : CONVERTERS[fromType]?.[property.type];
  let anyFailures = false;
  let cursor: string | null = null;
  const pageSize = 500;

  for (;;) {
    const client: PoolClient = await pool.connect();
    let rows: Array<{ id: string; properties: Record<string, unknown> }>;
    try {
      const result = await client.query(
        `SELECT id, properties FROM items WHERE database_id = $1 ${cursor ? "AND id > $3" : ""}
         ORDER BY id ASC LIMIT $2`,
        cursor ? [property.databaseId, pageSize, cursor] : [property.databaseId, pageSize],
      );
      rows = result.rows;

      for (const row of rows) {
        if (!(property.key in row.properties)) continue;
        const oldValue = row.properties[property.key];
        const converted = converter ? converter(oldValue) : { ok: true as const, value: oldValue };
        if (converted.ok) {
          // updated_at DOES advance here, unlike a `computed` write — this changes the
          // value a client sees under `properties`, so a stale ifVersion must conflict.
          await client.query(
            `UPDATE items SET properties = jsonb_set(properties, ARRAY[$3]::text[], $4::jsonb), updated_at = now()
             WHERE database_id = $1 AND id = $2`,
            [property.databaseId, row.id, property.key, JSON.stringify(converted.value)],
          );
        } else {
          anyFailures = true;
          await client.query(`UPDATE items SET properties = properties - $3, updated_at = now() WHERE database_id = $1 AND id = $2`, [
            property.databaseId,
            row.id,
            property.key,
          ]);
        }
      }
    } finally {
      client.release();
    }
    if (rows.length === 0 || rows.length < pageSize) break;
    cursor = rows[rows.length - 1].id;
  }

  const finalClient = await pool.connect();
  try {
    await setPropertyMigrationStatus(finalClient, propertyId, anyFailures ? "partial" : "done");
    const dependents = await findDependenciesBySource(finalClient, property.databaseId, property.key);
    for (const dependency of dependents) {
      await enqueueRollupBackfill(finalClient, dependency.rollupPropertyId);
    }
  } finally {
    finalClient.release();
  }
}

export async function handlePropertyTypeMigrationTask(
  pool: Pool,
  payload: { propertyId: string; fromType: PropertyType },
): Promise<void> {
  await runPropertyTypeMigrationJob(pool, payload.propertyId, payload.fromType);
}
