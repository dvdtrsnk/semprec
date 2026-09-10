import type { PoolClient } from "pg";
import { requireSingleRow } from "../db/pool.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { PROPERTY_TYPES, type DatabaseRow, type PropertyOwner, type PropertyRow, type PropertyType } from "../types.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { getDatabase } from "./databasesStore.js";

/**
 * Issue #145: a select/multi_select property's `config.options` must already be in the
 * `{ key, label? }[]` catalog shape — the bare-string shape only ever exists in already-
 * written rows, repaired once by migration 0029, never accepted from a new write.
 */
function assertValidSelectOptions(type: PropertyType, config: Record<string, unknown> | undefined): void {
  if (type !== "select" && type !== "multi_select") return;
  const options = config?.options;
  if (options === undefined) return;
  if (!Array.isArray(options)) {
    throw new ValidationError("select/multi_select config.options must be an array", { field: "config" });
  }
  for (const option of options) {
    if (typeof option !== "object" || option === null || Array.isArray(option)) {
      throw new ValidationError("each select/multi_select option must be an object of shape { key, label? }", {
        field: "config",
      });
    }
    const { key, label } = option as { key?: unknown; label?: unknown };
    if (typeof key !== "string" || key.length === 0) {
      throw new ValidationError("each select/multi_select option requires a non-empty string 'key'", {
        field: "config",
      });
    }
    if (label !== undefined && typeof label !== "string") {
      throw new ValidationError("a select/multi_select option's 'label' must be a string when present", {
        field: "config",
      });
    }
  }
}

const PROPERTY_OWNERS: readonly PropertyOwner[] = ["user", "system"];
const MIGRATION_STATUSES: readonly PropertyRow["migrationStatus"][] = [
  "stable",
  "pending",
  "running",
  "done",
  "partial",
];

/** The raw `properties` row shape this module reads back from Postgres. */
type PropertyDbRow = {
  id: string;
  database_id: string;
  key: string;
  name: string | null;
  type: string;
  config: Record<string, unknown>;
  locked: boolean;
  owner: string;
  owner_process: string | null;
  migration_status: string;
};

function mapPropertyRow(row: PropertyDbRow): PropertyRow {
  return {
    id: row.id,
    databaseId: row.database_id,
    key: row.key,
    name: row.name,
    type: assertKnownValue(PROPERTY_TYPES, row.type, "property type"),
    config: row.config,
    locked: row.locked,
    owner: assertKnownValue(PROPERTY_OWNERS, row.owner, "property owner"),
    ownerProcess: row.owner_process,
    migrationStatus: assertKnownValue(MIGRATION_STATUSES, row.migration_status, "migration status"),
  };
}

const PROPERTY_COLUMNS = "id, database_id, key, name, type, config, locked, owner, owner_process, migration_status";

export async function getProperty(client: PoolClient, propertyId: string): Promise<PropertyRow | null> {
  const { rows } = await client.query<PropertyDbRow>(`SELECT ${PROPERTY_COLUMNS} FROM properties WHERE id = $1`, [
    propertyId,
  ]);
  return rows[0] ? mapPropertyRow(rows[0]) : null;
}

export async function getPropertyByKey(
  client: PoolClient,
  databaseId: string,
  key: string,
): Promise<PropertyRow | null> {
  const { rows } = await client.query<PropertyDbRow>(
    `SELECT ${PROPERTY_COLUMNS} FROM properties WHERE database_id = $1 AND key = $2`,
    [databaseId, key],
  );
  return rows[0] ? mapPropertyRow(rows[0]) : null;
}

export async function listPropertiesByDatabase(client: PoolClient, databaseId: string): Promise<PropertyRow[]> {
  const { rows } = await client.query<PropertyDbRow>(
    `SELECT ${PROPERTY_COLUMNS} FROM properties WHERE database_id = $1 ORDER BY key`,
    [databaseId],
  );
  return rows.map(mapPropertyRow);
}

/**
 * Batch form of `listPropertiesByDatabase` for callers iterating many databases at once (issue
 * #147's system-wide schema projection) — one query instead of one-per-database, grouped by
 * `databaseId` in memory. A database with no properties is simply absent from the result map.
 */
export async function listPropertiesByDatabases(
  client: PoolClient,
  databaseIds: readonly string[],
): Promise<Map<string, PropertyRow[]>> {
  const grouped = new Map<string, PropertyRow[]>();
  if (databaseIds.length === 0) return grouped;

  const { rows } = await client.query<PropertyDbRow>(
    `SELECT ${PROPERTY_COLUMNS} FROM properties WHERE database_id = ANY($1) ORDER BY database_id, key`,
    [databaseIds],
  );
  for (const row of rows) {
    const property = mapPropertyRow(row);
    const existing = grouped.get(property.databaseId);
    if (existing) {
      existing.push(property);
    } else {
      grouped.set(property.databaseId, [property]);
    }
  }
  return grouped;
}

async function requireProperty(client: PoolClient, propertyId: string): Promise<PropertyRow> {
  const property = await getProperty(client, propertyId);
  if (!property) throw new NotFoundError(`Property ${propertyId} not found`);
  return property;
}

async function assertDatabaseSchemaUnlocked(client: PoolClient, databaseId: string): Promise<DatabaseRow> {
  const database = await getDatabase(client, databaseId);
  if (!database) throw new NotFoundError(`Database ${databaseId} not found`);
  if (database.schemaLocked) {
    throw new ForbiddenError("The owning database's schema is locked; only a code-level migration may change it");
  }
  return database;
}

export interface CreatePropertyInput {
  databaseId: string;
  key: string;
  /** Required unless the owning database is a system database — enforced below, not by the (now nullable) column. */
  name: string | null;
  type: PropertyType;
  config?: Record<string, unknown>;
  locked?: boolean;
  owner?: PropertyOwner;
  ownerProcess?: string;
}

export async function createProperty(client: PoolClient, input: CreatePropertyInput): Promise<PropertyRow> {
  if (!PROPERTY_TYPES.includes(input.type)) {
    throw new ValidationError(`Unknown property type '${input.type}'`, { field: "type" });
  }
  const database = await assertDatabaseSchemaUnlocked(client, input.databaseId);
  if (!database.system && !input.name) {
    throw new ValidationError("name is required for a property of a non-system database", { field: "name" });
  }
  assertValidSelectOptions(input.type, input.config);

  const { rows } = await client.query<PropertyDbRow>(
    `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     RETURNING ${PROPERTY_COLUMNS}`,
    [
      input.databaseId,
      input.key,
      input.name,
      input.type,
      JSON.stringify(input.config ?? {}),
      input.locked ?? false,
      input.owner ?? "user",
      input.ownerProcess ?? null,
    ],
  );
  return mapPropertyRow(requireSingleRow(rows, "properties row"));
}

/** The label is always renamable — `locked` governs deletion / type change, never the display name. */
export async function renameProperty(client: PoolClient, propertyId: string, name: string): Promise<PropertyRow> {
  await requireProperty(client, propertyId);
  const { rows } = await client.query<PropertyDbRow>(
    `UPDATE properties SET name = $2 WHERE id = $1 RETURNING ${PROPERTY_COLUMNS}`,
    [propertyId, name],
  );
  return mapPropertyRow(requireSingleRow(rows, "properties row"));
}

async function assertPropertySchemaMutable(client: PoolClient, property: PropertyRow): Promise<void> {
  if (property.locked) {
    throw new ForbiddenError(`Property ${property.id} is locked; its schema cannot be changed`);
  }
  await assertDatabaseSchemaUnlocked(client, property.databaseId);
}

/** Changes `type` only. Caller (the choke-point) is responsible for the mirror-dependency and conversion-path checks. */
export async function changePropertyType(
  client: PoolClient,
  propertyId: string,
  newType: PropertyType,
  migrationStatus: PropertyRow["migrationStatus"],
): Promise<PropertyRow> {
  if (!PROPERTY_TYPES.includes(newType)) {
    throw new ValidationError(`Unknown property type '${newType}'`, { field: "type" });
  }
  const property = await requireProperty(client, propertyId);
  await assertPropertySchemaMutable(client, property);

  const { rows } = await client.query<PropertyDbRow>(
    // `migration_dropped_values` is cleared here and only here: a fresh retype starts a new
    // migration, so whatever a previous retype of this property discarded is no longer its
    // result. Every other writer only ever sets the flag.
    `UPDATE properties SET type = $2, migration_status = $3, migration_dropped_values = false
     WHERE id = $1 RETURNING ${PROPERTY_COLUMNS}`,
    [propertyId, newType, migrationStatus],
  );
  return mapPropertyRow(requireSingleRow(rows, "properties row"));
}

export async function setPropertyMigrationStatus(
  client: PoolClient,
  propertyId: string,
  migrationStatus: PropertyRow["migrationStatus"],
): Promise<void> {
  await client.query(`UPDATE properties SET migration_status = $2 WHERE id = $1`, [propertyId, migrationStatus]);
}

/**
 * Records that a property-type migration discarded an unconvertible value. Idempotent, and
 * deliberately not reset here — see migration 0026 for why this outlives a single job run.
 */
export async function markPropertyMigrationDroppedValues(client: PoolClient, propertyId: string): Promise<void> {
  await client.query(`UPDATE properties SET migration_dropped_values = true WHERE id = $1`, [propertyId]);
}

/**
 * Settles a finished property-type migration on 'partial' or 'done' from the durable
 * `migration_dropped_values` flag rather than from the calling run's own bookkeeping, so
 * a retry or an overlapping run cannot downgrade an earlier run's 'partial' to 'done'.
 */
export async function settlePropertyMigrationStatus(client: PoolClient, propertyId: string): Promise<void> {
  await client.query(
    `UPDATE properties
     SET migration_status = CASE WHEN migration_dropped_values THEN 'partial' ELSE 'done' END
     WHERE id = $1`,
    [propertyId],
  );
}

export async function setPropertyLocked(client: PoolClient, propertyId: string, locked: boolean): Promise<void> {
  await client.query(`UPDATE properties SET locked = $2 WHERE id = $1`, [propertyId, locked]);
}

export async function updatePropertyConfig(
  client: PoolClient,
  propertyId: string,
  config: Record<string, unknown>,
): Promise<PropertyRow> {
  const property = await requireProperty(client, propertyId);
  await assertPropertySchemaMutable(client, property);
  assertValidSelectOptions(property.type, config);

  const { rows } = await client.query<PropertyDbRow>(
    `UPDATE properties SET config = $2::jsonb WHERE id = $1 RETURNING ${PROPERTY_COLUMNS}`,
    [propertyId, JSON.stringify(config)],
  );
  return mapPropertyRow(requireSingleRow(rows, "properties row"));
}

/** Caller (the choke-point) is responsible for the mirror-dependency check before calling this. */
export async function deleteProperty(client: PoolClient, propertyId: string): Promise<void> {
  const property = await requireProperty(client, propertyId);
  await assertPropertySchemaMutable(client, property);
  await client.query(`DELETE FROM properties WHERE id = $1`, [propertyId]);
}
