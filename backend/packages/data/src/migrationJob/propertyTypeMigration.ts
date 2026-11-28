import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@alldots/queue";
import { tenantLane } from "../tenancy/tenantLane.js";
import type { Queryable } from "../db/pool.js";
import { withTransaction } from "../db/pool.js";
import { migrateItemPropertyWithClient } from "../chokePoint/itemMigrationWrites.js";
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
import { logger } from "./logger.js";

type Converter = (value: unknown) => { ok: true; value: unknown } | { ok: false };

/**
 * A date, optionally with a time; a time requires a `Z` or `±HH:mm` offset because `Date.parse` would read it as
 * server-local time. Other formats `Date.parse` accepts are rejected too.
 */
const ISO_8601_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** The exact `toISOString()` shape the `text -> date` converter produces. */
const CONVERTED_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Deliberately a small, non-exhaustive set per type pair. */
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

/** Exported for unit tests. `from === to` passes the value through. */
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
 * Makes the job idempotent under retries: a retry restarts from the first row, and re-running a converter on an
 * already-converted value would fail its input check and delete the value. `date` matches only the converter's
 * exact output shape, because unconverted source text is also a string.
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
 * Converts every item's value to the new type; an unconvertible value is removed. Ends `done` or `partial`, judged
 * from the durable `migration_dropped_values` flag so a retry (which skips already-dropped rows) still settles
 * `partial`.
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
    // One batch per transaction: `FOR UPDATE` holds the page so a racing choke-point write cannot land between the
    // read and the write. The drop mark and the key removal commit together.
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
            // Converted by an earlier attempt.
            continue;
          }
          const converted = convertPropertyValue(fromType, property.type, oldValue);
          if (converted.ok) {
            // Advances updated_at (unlike a `computed` write), so a stale ifVersion conflicts.
            await migrateItemPropertyWithClient(client, {
              databaseId: property.databaseId,
              itemId: row.id,
              key: property.key,
              change: { kind: "set", value: converted.value },
            });
          } else {
            // Mark before removing: once the key is gone later passes skip the row, so the mark must not be lost.
            await markPropertyMigrationDroppedValues(client, propertyId);
            await migrateItemPropertyWithClient(client, {
              databaseId: property.databaseId,
              itemId: row.id,
              key: property.key,
              change: { kind: "remove" },
            });
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
 * On the final attempt's failure nothing will retry, so the status is settled terminally (values marked dropped,
 * then settled) instead of staying `running` forever. Earlier attempts leave `running` for the retry.
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
        // Never let the settle failure replace the original error.
        logger.error(
          { err: settleErr, propertyId: payload.propertyId },
          "handlePropertyTypeMigrationTask: failed to settle terminal status",
        );
      }
    }
    throw err;
  }
}
