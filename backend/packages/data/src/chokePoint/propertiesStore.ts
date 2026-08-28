import type { PoolClient } from "pg";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { PROPERTY_TYPES, type PropertyOwner, type PropertyRow, type PropertyType } from "../types.js";
import { getDatabase } from "./databasesStore.js";

const PROPERTY_OWNERS: readonly PropertyOwner[] = ["user", "system"];
const MIGRATION_STATUSES: readonly PropertyRow["migrationStatus"][] = ["stable", "pending", "running", "done", "partial"];

function assertKnownValue<T extends string>(allowed: readonly T[], value: string, label: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Unknown ${label} in database row: '${value}'`);
  }
  return value as T;
}

function mapPropertyRow(row: {
  id: string;
  database_id: string;
  key: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  locked: boolean;
  owner: string;
  owner_process: string | null;
  migration_status: string;
}): PropertyRow {
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
  const { rows } = await client.query(`SELECT ${PROPERTY_COLUMNS} FROM properties WHERE id = $1`, [propertyId]);
  return rows[0] ? mapPropertyRow(rows[0]) : null;
}

export async function getPropertyByKey(client: PoolClient, databaseId: string, key: string): Promise<PropertyRow | null> {
  const { rows } = await client.query(`SELECT ${PROPERTY_COLUMNS} FROM properties WHERE database_id = $1 AND key = $2`, [
    databaseId,
    key,
  ]);
  return rows[0] ? mapPropertyRow(rows[0]) : null;
}

export async function listPropertiesByDatabase(client: PoolClient, databaseId: string): Promise<PropertyRow[]> {
  const { rows } = await client.query(`SELECT ${PROPERTY_COLUMNS} FROM properties WHERE database_id = $1 ORDER BY key`, [
    databaseId,
  ]);
  return rows.map(mapPropertyRow);
}

async function requireProperty(client: PoolClient, propertyId: string): Promise<PropertyRow> {
  const property = await getProperty(client, propertyId);
  if (!property) throw new NotFoundError(`Property ${propertyId} not found`);
  return property;
}

async function assertDatabaseSchemaUnlocked(client: PoolClient, databaseId: string): Promise<void> {
  const database = await getDatabase(client, databaseId);
  if (!database) throw new NotFoundError(`Database ${databaseId} not found`);
  if (database.schemaLocked) {
    throw new ForbiddenError("The owning database's schema is locked; only a code-level migration may change it");
  }
}

export interface CreatePropertyInput {
  databaseId: string;
  key: string;
  name: string;
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
  await assertDatabaseSchemaUnlocked(client, input.databaseId);

  const { rows } = await client.query(
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
  return mapPropertyRow(rows[0]);
}

/** The label is always renamable — `locked` governs deletion / type change, never the display name. */
export async function renameProperty(client: PoolClient, propertyId: string, name: string): Promise<PropertyRow> {
  await requireProperty(client, propertyId);
  const { rows } = await client.query(`UPDATE properties SET name = $2 WHERE id = $1 RETURNING ${PROPERTY_COLUMNS}`, [
    propertyId,
    name,
  ]);
  return mapPropertyRow(rows[0]);
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

  const { rows } = await client.query(
    `UPDATE properties SET type = $2, migration_status = $3 WHERE id = $1 RETURNING ${PROPERTY_COLUMNS}`,
    [propertyId, newType, migrationStatus],
  );
  return mapPropertyRow(rows[0]);
}

export async function setPropertyMigrationStatus(
  client: PoolClient,
  propertyId: string,
  migrationStatus: PropertyRow["migrationStatus"],
): Promise<void> {
  await client.query(`UPDATE properties SET migration_status = $2 WHERE id = $1`, [propertyId, migrationStatus]);
}

export async function updatePropertyConfig(
  client: PoolClient,
  propertyId: string,
  config: Record<string, unknown>,
): Promise<PropertyRow> {
  const property = await requireProperty(client, propertyId);
  await assertPropertySchemaMutable(client, property);

  const { rows } = await client.query(`UPDATE properties SET config = $2::jsonb WHERE id = $1 RETURNING ${PROPERTY_COLUMNS}`, [
    propertyId,
    JSON.stringify(config),
  ]);
  return mapPropertyRow(rows[0]);
}

/** Caller (the choke-point) is responsible for the mirror-dependency check before calling this. */
export async function deleteProperty(client: PoolClient, propertyId: string): Promise<void> {
  const property = await requireProperty(client, propertyId);
  await assertPropertySchemaMutable(client, property);
  await client.query(`DELETE FROM properties WHERE id = $1`, [propertyId]);
}
