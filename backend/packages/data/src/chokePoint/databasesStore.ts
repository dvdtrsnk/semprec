import type { PoolClient } from "pg";
import { requireSingleRow } from "../db/pool.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import type { DatabaseRow } from "../types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a Postgres error is the named unique-index violation, so callers can turn it into a clean ConflictError. */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pgErr = err as { code?: string; constraint?: string };
  return pgErr?.code === "23505" && pgErr?.constraint === constraint;
}

/** The raw `databases` row shape this module reads back from Postgres. */
type DatabaseDbRow = {
  id: string;
  name: string | null;
  key: string | null;
  parent_item_id: string | null;
  owner_project_item_id: string | null;
  owner_module_id: string | null;
  schema_locked: boolean;
  system: boolean;
  archived_at: Date | null;
};

function mapDatabaseRow(row: DatabaseDbRow): DatabaseRow {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    parentItemId: row.parent_item_id,
    ownerProjectItemId: row.owner_project_item_id,
    ownerModuleId: row.owner_module_id,
    schemaLocked: row.schema_locked,
    system: row.system,
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
  };
}

const DATABASE_COLUMNS =
  "id, name, key, parent_item_id, owner_project_item_id, owner_module_id, schema_locked, system, archived_at";

export interface CreateDatabaseInput {
  /** Required unless `system` is true — enforced below, not by the (now nullable) column. */
  name: string | null;
  /** Stable unique English camelCase identifier (issue #235) — only ever set for system databases. */
  key?: string;
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
  if (!input.system && !input.name) {
    throw new ValidationError("name is required for a non-system database", { field: "name" });
  }
  if (input.key && !input.system) {
    throw new ValidationError("key is only valid for system databases", { field: "key" });
  }
  if (input.system && !input.name && !input.key) {
    // Without a name, key is the only source of a display label the permissionManifest
    // fallback (db.name ?? db.key ?? db.id) has to fall back to before it resorts to
    // surfacing the raw database id.
    throw new ValidationError("key is required for a system database with a null name", { field: "key" });
  }

  let database: DatabaseRow;
  try {
    const { rows } = await client.query<DatabaseDbRow>(
      `INSERT INTO databases (name, key, parent_item_id, owner_project_item_id, owner_module_id, schema_locked, system)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${DATABASE_COLUMNS}`,
      [
        input.name,
        input.key ?? null,
        input.parentItemId ?? null,
        input.ownerProjectItemId ?? null,
        input.ownerModuleId ?? null,
        input.schemaLocked ?? false,
        input.system ?? false,
      ],
    );
    database = mapDatabaseRow(requireSingleRow(rows, "databases row"));
  } catch (err) {
    if (isUniqueViolation(err, "databases_key_unique")) {
      throw new ConflictError(`Database key '${input.key}' is already in use`, { field: "key" });
    }
    throw err;
  }

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
  await client.query(requireSingleRow(ddlRows, "partition DDL format()").ddl);

  return database;
}

export async function getDatabase(client: PoolClient, id: string): Promise<DatabaseRow | null> {
  const { rows } = await client.query<DatabaseDbRow>(`SELECT ${DATABASE_COLUMNS} FROM databases WHERE id = $1`, [id]);
  return rows[0] ? mapDatabaseRow(rows[0]) : null;
}

/** Looks up a system database by its canonical `owner_module_id` (e.g. 'tasks', 'events') — see the `canonical-keys` skill's established vocabulary. */
export async function getDatabaseByModuleId(client: PoolClient, ownerModuleId: string): Promise<DatabaseRow | null> {
  const { rows } = await client.query<DatabaseDbRow>(
    `SELECT ${DATABASE_COLUMNS} FROM databases WHERE owner_module_id = $1`,
    [ownerModuleId],
  );
  return rows[0] ? mapDatabaseRow(rows[0]) : null;
}

/**
 * Every non-archived database system-wide, including the ten hardcoded system databases
 * (issue #147's schema-projection endpoint needs these: they carry no `owner_project_item_id`,
 * so they're invisible to any project-scoped query like `generatePermissionManifest`'s).
 */
export async function listAllDatabases(client: PoolClient): Promise<DatabaseRow[]> {
  const { rows } = await client.query<DatabaseDbRow>(
    `SELECT ${DATABASE_COLUMNS} FROM databases WHERE archived_at IS NULL ORDER BY key, name`,
  );
  return rows.map(mapDatabaseRow);
}

async function requireDatabase(client: PoolClient, id: string): Promise<DatabaseRow> {
  const database = await getDatabase(client, id);
  if (!database) throw new NotFoundError(`Database ${id} not found`);
  return database;
}

export async function archiveDatabase(client: PoolClient, id: string): Promise<DatabaseRow> {
  const database = await requireDatabase(client, id);
  if (database.system) throw new ForbiddenError("A system database cannot be archived");

  const { rows } = await client.query<DatabaseDbRow>(
    `UPDATE databases SET archived_at = now() WHERE id = $1 RETURNING ${DATABASE_COLUMNS}`,
    [id],
  );
  return mapDatabaseRow(requireSingleRow(rows, "databases row"));
}

/** The label is always renamable, same as `renameProperty` in `propertiesStore.ts` — `schemaLocked`/`system` govern schema mutation, never the display name. */
export async function renameDatabase(client: PoolClient, id: string, name: string): Promise<DatabaseRow> {
  await requireDatabase(client, id);
  const { rows } = await client.query<DatabaseDbRow>(
    `UPDATE databases SET name = $2 WHERE id = $1 RETURNING ${DATABASE_COLUMNS}`,
    [id, name],
  );
  return mapDatabaseRow(requireSingleRow(rows, "databases row"));
}

export async function restoreDatabase(client: PoolClient, id: string): Promise<DatabaseRow> {
  await requireDatabase(client, id);
  const { rows } = await client.query<DatabaseDbRow>(
    `UPDATE databases SET archived_at = NULL WHERE id = $1 RETURNING ${DATABASE_COLUMNS}`,
    [id],
  );
  return mapDatabaseRow(requireSingleRow(rows, "databases row"));
}
