import type { PoolClient } from "pg";
import { ForbiddenError, NotFoundError } from "../errors.js";
import type { DatabaseRow } from "../types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapDatabaseRow(row: {
  id: string;
  name: string;
  parent_item_id: string | null;
  owner_project_item_id: string | null;
  owner_module_id: string | null;
  schema_locked: boolean;
  system: boolean;
  archived_at: Date | null;
}): DatabaseRow {
  return {
    id: row.id,
    name: row.name,
    parentItemId: row.parent_item_id,
    ownerProjectItemId: row.owner_project_item_id,
    ownerModuleId: row.owner_module_id,
    schemaLocked: row.schema_locked,
    system: row.system,
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
  };
}

export interface CreateDatabaseInput {
  name: string;
  parentItemId?: string;
  ownerProjectItemId?: string;
  ownerModuleId?: string;
  schemaLocked?: boolean;
  system?: boolean;
}

/**
 * Creates the `databases` row and its dedicated `items` partition in one transaction.
 * `items` has no DEFAULT partition (see the migration's header note), so a database
 * only becomes writable once this returns.
 */
export async function createDatabase(client: PoolClient, input: CreateDatabaseInput): Promise<DatabaseRow> {
  const { rows } = await client.query(
    `INSERT INTO databases (name, parent_item_id, owner_project_item_id, owner_module_id, schema_locked, system)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, parent_item_id, owner_project_item_id, owner_module_id, schema_locked, system, archived_at`,
    [
      input.name,
      input.parentItemId ?? null,
      input.ownerProjectItemId ?? null,
      input.ownerModuleId ?? null,
      input.schemaLocked ?? false,
      input.system ?? false,
    ],
  );
  const database = mapDatabaseRow(rows[0]);

  if (!UUID_RE.test(database.id)) {
    // Sanity invariant only: database.id always comes straight from gen_random_uuid()
    // above, never from external input. The DDL below no longer depends on this check
    // for safety (both the identifier and the literal are escaped server-side by
    // format() below) — this just fails loudly if that invariant were ever violated.
    throw new Error(`Generated database id is not a UUID: ${database.id}`);
  }
  const partitionName = `items_p_${database.id.replace(/-/g, "")}`;
  // DDL statements cannot bind $-placeholders directly, so the identifier and the
  // partition-bound literal are both escaped server-side via format() (%I / %L)
  // instead of interpolated into the query string by the application.
  const { rows: ddlRows } = await client.query<{ ddl: string }>(
    `SELECT format('CREATE TABLE %I PARTITION OF items FOR VALUES IN (%L)', $1::text, $2::text) AS ddl`,
    [partitionName, database.id],
  );
  await client.query(ddlRows[0].ddl);

  return database;
}

export async function getDatabase(client: PoolClient, id: string): Promise<DatabaseRow | null> {
  const { rows } = await client.query(
    `SELECT id, name, parent_item_id, owner_project_item_id, owner_module_id, schema_locked, system, archived_at
     FROM databases WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapDatabaseRow(rows[0]) : null;
}

async function requireDatabase(client: PoolClient, id: string): Promise<DatabaseRow> {
  const database = await getDatabase(client, id);
  if (!database) throw new NotFoundError(`Database ${id} not found`);
  return database;
}

export async function archiveDatabase(client: PoolClient, id: string): Promise<DatabaseRow> {
  const database = await requireDatabase(client, id);
  if (database.system) throw new ForbiddenError("A system database cannot be archived");

  const { rows } = await client.query(
    `UPDATE databases SET archived_at = now() WHERE id = $1
     RETURNING id, name, parent_item_id, owner_project_item_id, owner_module_id, schema_locked, system, archived_at`,
    [id],
  );
  return mapDatabaseRow(rows[0]);
}

export async function restoreDatabase(client: PoolClient, id: string): Promise<DatabaseRow> {
  await requireDatabase(client, id);
  const { rows } = await client.query(
    `UPDATE databases SET archived_at = NULL WHERE id = $1
     RETURNING id, name, parent_item_id, owner_project_item_id, owner_module_id, schema_locked, system, archived_at`,
    [id],
  );
  return mapDatabaseRow(rows[0]);
}
