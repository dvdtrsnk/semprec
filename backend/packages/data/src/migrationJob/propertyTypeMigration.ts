import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { tenantLane } from "../tenancy/tenantLane.js";
import type { Queryable } from "../db/pool.js";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import {
  getProperty,
  markPropertyMigrationDroppedValues,
  setPropertyMigrationStatus,
  settlePropertyMigrationStatus,
} from "../chokePoint/propertiesStore.js";
import { lockItemBatch } from "./itemBatch.js";
import { findDependenciesBySource } from "../rollup/dependencies.js";
import { enqueueRollupBackfill } from "../rollup/recompute.js";
import type { PropertyType } from "../types.js";

type Converter = (value: unknown) => { ok: true; value: unknown } | { ok: false };

/**
 * `YYYY-MM-DD`, or that date followed by `THH:mm`, optionally `:ss[.sss]`, and — whenever a time
 * component is present — a required `Z` or `±HH:mm` offset. A time without an explicit offset is
 * parsed as local time by `Date.parse`, which would silently produce a wrong UTC timestamp on a
 * non-UTC server, so it is rejected here rather than accepted. Anything else (`"March 5"`, a Unix
 * timestamp string) is also rejected even though `Date.parse` would accept it.
 */
const ISO_8601_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** The exact `toISOString()` shape the `text -> date` converter produces. */
const CONVERTED_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A fixed, small set of conversion functions per type pair — deliberately not exhaustive. */
const CONVERTERS: Partial<Record<PropertyType, Partial<Record<PropertyType, Converter>>>> = {
  text: {
    number: (value) => {
      if (typeof value !== "string" || value.trim() === "") return { ok: false };
      const n = Number(value);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    },
    date: (value) => {
      if (typeof value !== "string" || !ISO_8601_DATE.test(value)) return { ok: false };
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? { ok: false } : { ok: true, value: new Date(parsed).toISOString() };
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

/**
 * The pure conversion step `runPropertyTypeMigrationJob` applies to each value, exposed
 * standalone so its per-type-pair behavior (what converts, what's left empty) can be unit
 * tested without a database. `from === to` always passes the value through unchanged,
 * matching the no-op retype `runPropertyTypeMigrationJob` allows.
 */
export function convertPropertyValue(
  from: PropertyType,
  to: PropertyType,
  value: unknown,
): { ok: true; value: unknown } | { ok: false } {
  if (from === to) return { ok: true, value };
  const converter = CONVERTERS[from]?.[to];
  return converter ? converter(value) : { ok: false };
}

/**
 * True when `value` is already in the JS shape a converter targeting `type` would
 * produce. Used to make the migration idempotent under graphile-worker retries: a
 * retry replays the whole job from the start (cursor null), so rows already
 * converted by an earlier, partially-failed attempt must be recognized and left
 * alone — re-running the converter on an already-converted value fails its input
 * check and silently deletes the property instead. Only covers the target types
 * CONVERTERS can actually produce (number, text, date); anything else returns
 * false so it falls through to the normal conversion path.
 *
 * `date` only recognizes the exact `toISOString()` shape the converter itself produces
 * (`CONVERTED_DATE_SHAPE`), not any string — the original source text a `text -> date` retype
 * has not converted yet is also a string, and treating it as already-converted would skip it
 * forever instead of converting or dropping it.
 */
function isAlreadyTargetType(type: PropertyType, value: unknown): boolean {
  switch (type) {
    case "number":
      return typeof value === "number";
    case "text":
      return typeof value === "string";
    case "date":
      return typeof value === "string" && CONVERTED_DATE_SHAPE.test(value);
    default:
      return false;
  }
}

const PROPERTY_TYPE_MIGRATION_LANE = "property-type-migration";

export function propertyTypeMigrationJobKey(propertyId: string): string {
  return `property-type-migration:${propertyId}`;
}

/** Must run in the same transaction as the property's `type` column update. */
export async function enqueuePropertyTypeMigration(
  client: Queryable,
  propertyId: string,
  fromType: PropertyType,
): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.PROPERTY_TYPE_MIGRATION,
    { propertyId, fromType },
    {
      jobKey: propertyTypeMigrationJobKey(propertyId),
      maxAttempts: 3,
      queueName: tenantLane(PROPERTY_TYPE_MIGRATION_LANE),
    },
  );
}

/**
 * Eagerly, once, immediately converts every item's value for this property to its new
 * type. An unconvertible value is left empty (not overwritten with an error); the
 * database ends up `done` (no failures) or `partial` (some rows left empty). That verdict
 * comes from the property's durable `migration_dropped_values` flag, so a retried or
 * overlapping run — which necessarily skips the rows an earlier run already dropped —
 * settles on the same `partial` instead of reporting a clean `done`.
 */
export async function runPropertyTypeMigrationJob(
  pool: Pool,
  propertyId: string,
  fromType: PropertyType,
): Promise<void> {
  const bootstrapClient = await pool.connect();
  let property;
  try {
    property = await getProperty(bootstrapClient, propertyId);
    if (!property) return;
    await setPropertyMigrationStatus(bootstrapClient, propertyId, "running");
  } finally {
    bootstrapClient.release();
  }

  const needsConversion = fromType !== property.type;
  let cursor: string | null = null;
  const pageSize = 500;

  for (;;) {
    // One batch, one transaction: lockItemBatch's FOR UPDATE holds every row in the page
    // locked until this commits, so a choke-point write racing the same rows either waits
    // or (skipLocked here is false) is waited on — it cannot land between this batch's read
    // and its jsonb_set and get silently overwritten. The drop mark and the properties - key
    // delete land in the same transaction too, so a crash between them rolls back instead of
    // leaving a row marked dropped with the key still present.
    const rows: Array<{ id: string; properties: Record<string, unknown> }> = await withTransaction(
      pool,
      async (client: PoolClient) => {
        const batch = await lockItemBatch(client, {
          databaseId: property.databaseId,
          afterId: cursor,
          pageSize,
          skipLocked: false,
        });

        for (const row of batch) {
          if (!(property.key in row.properties)) continue;
          const oldValue = row.properties[property.key];
          if (needsConversion && isAlreadyTargetType(property.type, oldValue)) {
            // Already converted by an earlier attempt at this same migration (see
            // isAlreadyTargetType) — leave it exactly as-is instead of re-converting.
            continue;
          }
          const converted = convertPropertyValue(fromType, property.type, oldValue);
          if (converted.ok) {
            // updated_at DOES advance here, unlike a `computed` write — this changes the
            // value a client sees under `properties`, so a stale ifVersion must conflict.
            requireAffectedRows(
              await client.query(
                `UPDATE items SET properties = jsonb_set(properties, ARRAY[$3]::text[], $4::jsonb), updated_at = now()
               WHERE database_id = $1 AND id = $2`,
                [property.databaseId, row.id, property.key, JSON.stringify(converted.value)],
              ),
              "property type migration value conversion update",
            );
          } else {
            // Marked before the value is discarded, not after: once the key is gone from
            // `properties` every later pass skips the row, so a crash between the two
            // statements must leave the migration looking failed rather than clean.
            await markPropertyMigrationDroppedValues(client, propertyId);
            requireAffectedRows(
              await client.query(
                `UPDATE items SET properties = properties - $3, updated_at = now() WHERE database_id = $1 AND id = $2`,
                [property.databaseId, row.id, property.key],
              ),
              "property type migration dropped value update",
            );
          }
        }

        return batch;
      },
    );
    const lastRow = rows[rows.length - 1];
    if (lastRow === undefined || rows.length < pageSize) break;
    cursor = lastRow.id;
  }

  const finalClient = await pool.connect();
  try {
    await settlePropertyMigrationStatus(finalClient, propertyId);
    const dependents = await findDependenciesBySource(finalClient, property.databaseId, property.key);
    for (const dependency of dependents) {
      await enqueueRollupBackfill(finalClient, dependency.rollupPropertyId);
    }
  } finally {
    finalClient.release();
  }
}

/**
 * `isFinalAttempt` is graphile-worker's `helpers.job.attempts >= helpers.job.max_attempts` at
 * the moment this task runs — true exactly on the last try `maxAttempts: 3` allows. On that
 * try's failure, the job as a whole gives up and nothing will run this property's migration
 * again, so the status this leaves behind must be terminal: dropping the values already read
 * (an in-progress run has no half-converted value worth keeping) and settling from that durable
 * flag, same as a clean run's own settle step, rather than leaving `migration_status = 'running'`
 * forever. A non-final attempt leaves `'running'` as-is — graphile-worker will retry the job.
 */
export async function handlePropertyTypeMigrationTask(
  pool: Pool,
  payload: { propertyId: string; fromType: PropertyType },
  options: { isFinalAttempt: boolean },
): Promise<void> {
  try {
    await runPropertyTypeMigrationJob(pool, payload.propertyId, payload.fromType);
  } catch (err) {
    if (options.isFinalAttempt) {
      try {
        await withTransaction(pool, async (client) => {
          await markPropertyMigrationDroppedValues(client, payload.propertyId);
          await settlePropertyMigrationStatus(client, payload.propertyId);
        });
      } catch (settleErr) {
        // The original failure (`err`) is what must reach the caller/graphile-worker — a
        // failure here settling the terminal status must not replace it, only be visible.
        console.error("handlePropertyTypeMigrationTask: failed to settle terminal status", settleErr);
      }
    }
    throw err;
  }
}
