import type { PoolClient } from "pg";
import { requireAffectedRows, requireSingleRow } from "../db/pool.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import type { DatabaseRow } from "../types.js";
import type { CollectionMetadataResolver } from "../manifest/collectionMetadata.js";
import { deleteRollupDependenciesBySourceDatabase } from "../rollup/dependencies.js";
import { RETENTION_DAYS } from "../trashRetention.js";
import { getItemsByIds } from "./itemsStore.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pgErr = err as { code?: string; constraint?: string };
  return pgErr?.code === "23505" && pgErr?.constraint === constraint;
}

type DatabaseDbRow = {
  id: string;
  name: string | null;
  key: string | null;
  parent_item_id: string | null;
  owner_project_item_id: string | null;
  owner_module_id: string | null;
  schema_locked: boolean;
  system: boolean;
  icon: string | null;
  color: string | null;
  overview_hidden: boolean;
  sensitive: boolean;
  archived_at: Date | null;
  purge_at: Date | null;
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
    icon: row.icon,
    color: row.color,
    overviewHidden: row.overview_hidden,
    sensitive: row.sensitive,
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    purgeAt: row.purge_at ? row.purge_at.toISOString() : null,
  };
}

const DATABASE_COLUMNS =
  "id, name, key, parent_item_id, owner_project_item_id, owner_module_id, schema_locked, system, icon, color, overview_hidden, sensitive, archived_at, purge_at";

export interface CreateDatabaseInput {
  /** Required unless `system` is true (enforced below, not by the column). */
  name: string | null;
  /** Stable English camelCase identifier; set only for system databases. */
  key?: string;
  parentItemId?: string;
  ownerProjectItemId?: string;
  ownerModuleId?: string;
  schemaLocked?: boolean;
  system?: boolean;
  /** Non-system only; a system database's icon comes from its module manifest. */
  icon?: string;
  /** `#RRGGBB`, stored upper-case; non-system only. */
  color?: string;
  /** Data an agent must not read or write by default; system databases only. */
  sensitive?: boolean;
}

export async function createDatabase(client: PoolClient, input: CreateDatabaseInput): Promise<DatabaseRow> {
  if (!input.system && !input.name) {
    throw new ValidationError("name is required for a non-system database", { field: "name" });
  }
  if (input.key && !input.system) {
    throw new ValidationError("key is only valid for system databases", { field: "key" });
  }
  if (input.sensitive && !input.system) {
    throw new ValidationError("sensitive is only valid for system databases", { field: "sensitive" });
  }
  if (input.system && !input.name && !input.key) {
    // Without a name, key is the display label before the fallback to the raw database id.
    throw new ValidationError("key is required for a system database with a null name", { field: "key" });
  }

  if (input.system && (input.icon !== undefined || input.color !== undefined)) {
    throw new ForbiddenError("The icon and color of a system database come from its module manifest");
  }

  if (input.parentItemId !== undefined) {
    // Foreign, soft-deleted, missing and malformed ids fail identically (no id in the message), so the
    // error is no existence oracle across tenants.
    const parentExists =
      UUID_RE.test(input.parentItemId) && (await getItemsByIds(client, [input.parentItemId])).length > 0;
    if (!parentExists) {
      throw new ValidationError("'parentItemId' does not reference an existing item", { field: "parentItemId" });
    }
  }

  let database: DatabaseRow;
  try {
    const { rows } = await client.query<DatabaseDbRow>(
      `INSERT INTO databases (name, key, parent_item_id, owner_project_item_id, owner_module_id, schema_locked, system, icon, color, sensitive)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${DATABASE_COLUMNS}`,
      [
        input.name,
        input.key ?? null,
        input.parentItemId ?? null,
        input.ownerProjectItemId ?? null,
        input.ownerModuleId ?? null,
        input.schemaLocked ?? false,
        input.system ?? false,
        input.icon ?? null,
        input.color?.toUpperCase() ?? null,
        input.sensitive ?? false,
      ],
    );
    database = mapDatabaseRow(requireSingleRow(rows, "databases row"));
  } catch (err) {
    if (isUniqueViolation(err, "databases_key_unique")) {
      throw new ConflictError(`Database key '${input.key}' is already in use`, { field: "key" });
    }
    throw err;
  }
  return database;
}

export async function getDatabase(client: PoolClient, id: string): Promise<DatabaseRow | null> {
  const { rows } = await client.query<DatabaseDbRow>(`SELECT ${DATABASE_COLUMNS} FROM databases WHERE id = $1`, [id]);
  return rows[0] ? mapDatabaseRow(rows[0]) : null;
}

/**
 * `getDatabase` holding the row to commit against its deletion: a purge that already deleted it makes this read wait
 * for that purge and then miss the row, and a later purge waits for this transaction.
 */
export async function getDatabaseForKeyShare(client: PoolClient, id: string): Promise<DatabaseRow | null> {
  const { rows } = await client.query<DatabaseDbRow>(
    `SELECT ${DATABASE_COLUMNS} FROM databases WHERE id = $1 FOR KEY SHARE`,
    [id],
  );
  return rows[0] ? mapDatabaseRow(rows[0]) : null;
}

/** Unique per tenant under RLS; a caller seeing several tenants fails with a plain `Error` on several matches. */
export async function getDatabaseByKey(client: PoolClient, key: string): Promise<DatabaseRow | null> {
  const { rows } = await client.query<DatabaseDbRow>(`SELECT ${DATABASE_COLUMNS} FROM databases WHERE key = $1`, [key]);
  if (rows.length > 1)
    throw new Error(`Database key '${key}' resolves to ${rows.length} databases, expected at most one`);
  return rows[0] ? mapDatabaseRow(rows[0]) : null;
}

/**
 * By canonical `owner_module_id` (e.g. 'tasks'). Per tenant under RLS; an RLS-bypassing caller with
 * several matches fails with a plain `Error` (an invariant violation) instead of picking one.
 */
export async function getDatabaseByModuleId(client: PoolClient, ownerModuleId: string): Promise<DatabaseRow | null> {
  const { rows } = await client.query<DatabaseDbRow>(
    `SELECT ${DATABASE_COLUMNS} FROM databases WHERE owner_module_id = $1 AND system`,
    [ownerModuleId],
  );
  if (rows.length > 1) {
    throw new Error(`Module id '${ownerModuleId}' resolves to ${rows.length} system databases, expected at most one`);
  }
  return rows[0] ? mapDatabaseRow(rows[0]) : null;
}

/** Every non-archived database, including system databases, which no project-scoped query sees. */
export async function listAllDatabases(client: PoolClient): Promise<DatabaseRow[]> {
  const { rows } = await client.query<DatabaseDbRow>(
    `SELECT ${DATABASE_COLUMNS} FROM databases WHERE archived_at IS NULL ORDER BY key, name`,
  );
  return rows.map(mapDatabaseRow);
}

/** Module id, `title` property key and sensitivity: what a reader needs to label an item. */
export interface DatabaseLabelRow {
  id: string;
  ownerModuleId: string | null;
  titlePropertyKey: string | null;
  sensitive: boolean;
}

/**
 * One query for a set of databases, including the `title` property key so titles need no query per
 * database. Several `title` properties resolve to the alphabetically first key.
 */
export async function listDatabaseLabelsByIds(client: PoolClient, ids: string[]): Promise<DatabaseLabelRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query<{
    id: string;
    owner_module_id: string | null;
    title_property_key: string | null;
    sensitive: boolean;
  }>(
    `SELECT DISTINCT ON (d.id) d.id, d.owner_module_id, d.sensitive, p.key AS title_property_key
     FROM databases d
     LEFT JOIN properties p ON p.database_id = d.id AND p.type = 'title'
     WHERE d.id = ANY($1::uuid[])
     ORDER BY d.id, p.key`,
    [ids],
  );
  return rows.map((row) => ({
    id: row.id,
    ownerModuleId: row.owner_module_id,
    titlePropertyKey: row.title_property_key,
    sensitive: row.sensitive,
  }));
}

async function requireDatabase(client: PoolClient, id: string): Promise<DatabaseRow> {
  const database = await getDatabase(client, id);
  if (!database) throw new NotFoundError(`Database ${id} not found`);
  return database;
}

/**
 * Moves a user database to the trash: `archived_at` is now and `purge_at` is `RETENTION_DAYS` × 24h
 * later, as for a trashed item. Archiving an archived database restarts both.
 */
export async function archiveDatabase(client: PoolClient, id: string): Promise<DatabaseRow> {
  const database = await requireDatabase(client, id);
  if (database.system) throw new ForbiddenError("A system database cannot be archived");

  const { rows } = await client.query<DatabaseDbRow>(
    `UPDATE databases SET archived_at = now(), purge_at = now() + make_interval(hours => $2::int * 24)
      WHERE id = $1 RETURNING ${DATABASE_COLUMNS}`,
    [id, RETENTION_DAYS],
  );
  return mapDatabaseRow(requireSingleRow(rows, "databases row"));
}

/** `null` for `icon` or `color` returns it to the read-time default. */
export interface DatabasePatch {
  name?: string;
  icon?: string | null;
  color?: string | null;
  overviewHidden?: boolean;
}

/**
 * Updates `name`, `icon`, `color`, `overviewHidden` in one statement. The name is always renamable;
 * a system database's icon and color belong to its module manifest.
 *
 * `overviewHidden` is accepted only when `resolver` reports the database hideable (a system database
 * whose descriptor declares `overviewHideable: true`); otherwise the whole patch is a `ForbiddenError`
 * before anything is written.
 */
export async function patchDatabase(
  client: PoolClient,
  id: string,
  patch: DatabasePatch,
  resolver?: Pick<CollectionMetadataResolver, "overviewHideable">,
): Promise<DatabaseRow> {
  const database = await requireDatabase(client, id);
  if (database.system && (patch.icon !== undefined || patch.color !== undefined)) {
    throw new ForbiddenError("The icon and color of a system database come from its module manifest");
  }
  if (patch.overviewHidden !== undefined && resolver?.overviewHideable(database) !== true) {
    throw new ForbiddenError("This database cannot be hidden from the overview");
  }
  const sets: string[] = [];
  const values: unknown[] = [id];
  const add = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.name !== undefined) add("name", patch.name);
  if (patch.icon !== undefined) add("icon", patch.icon);
  if (patch.color !== undefined) add("color", patch.color === null ? null : patch.color.toUpperCase());
  if (patch.overviewHidden !== undefined) add("overview_hidden", patch.overviewHidden);
  if (sets.length === 0) return database;
  const { rows } = await client.query<DatabaseDbRow>(
    `UPDATE databases SET ${sets.join(", ")} WHERE id = $1 RETURNING ${DATABASE_COLUMNS}`,
    values,
  );
  return mapDatabaseRow(requireSingleRow(rows, "databases row"));
}

export async function renameDatabase(client: PoolClient, id: string, name: string): Promise<DatabaseRow> {
  return patchDatabase(client, id, { name });
}

/** Inline databases owned by a page item, for the trash cascade and the purge sweep. */
export async function listDatabasesByParentItem(client: PoolClient, itemId: string): Promise<DatabaseRow[]> {
  const { rows } = await client.query<DatabaseDbRow>(
    `SELECT ${DATABASE_COLUMNS} FROM databases WHERE parent_item_id = $1`,
    [itemId],
  );
  return rows.map(mapDatabaseRow);
}

/** Clears `archived_at` and `purge_at`. */
export async function restoreDatabase(client: PoolClient, id: string): Promise<DatabaseRow> {
  await requireDatabase(client, id);
  const { rows } = await client.query<DatabaseDbRow>(
    `UPDATE databases SET archived_at = NULL, purge_at = NULL WHERE id = $1 RETURNING ${DATABASE_COLUMNS}`,
    [id],
  );
  return mapDatabaseRow(requireSingleRow(rows, "databases row"));
}

/** Earliest deadline first. */
export async function listExpiredArchivedDatabaseIds(client: PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM databases
      WHERE archived_at IS NOT NULL AND NOT system AND purge_at < now()
      ORDER BY purge_at, id`,
  );
  return rows.map((row) => row.id);
}

/**
 * Locks the row `FOR NO KEY UPDATE` (an archive or restore waits for it) and says whether it is still
 * an archived user database past its deadline. The purge calls it first in every transaction
 * that deletes from or drops the database, so an earlier restore is seen and a later one waits.
 */
export async function lockExpiredArchivedDatabase(client: PoolClient, id: string): Promise<boolean> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM databases
      WHERE id = $1 AND archived_at IS NOT NULL AND NOT system AND purge_at < now()
      FOR NO KEY UPDATE`,
    [id],
  );
  return rows.length === 1;
}

/**
 * Takes the purge's lock and says whether the row exists. A caller deciding on it (a restore reporting
 * an unknown id) holds the row to commit: an earlier purge shows as missing, a later one waits and
 * then finds the database no longer archived.
 */
export async function lockDatabase(client: PoolClient, id: string): Promise<boolean> {
  const { rows } = await client.query<{ id: string }>("SELECT id FROM databases WHERE id = $1 FOR NO KEY UPDATE", [id]);
  return rows.length === 1;
}

export async function listInlineDatabaseIds(client: PoolClient, itemIds: readonly string[]): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM databases WHERE parent_item_id = ANY($1::uuid[]) ORDER BY id",
    [itemIds],
  );
  return rows.map((row) => row.id);
}

/**
 * Permanently removes a database whose items the purge already removed with their dependents: its
 * `rollup_dependencies` rows (FKs without cascade), any item left, then the row (`properties` and `views`
 * cascade). A remaining item takes its derived rows with it; one whose dependents need their owner's delete
 * path fails the commit on that row's foreign key, so the caller must have emptied the database in the same
 * transaction.
 */
export async function deleteDatabaseWithItems(client: PoolClient, id: string): Promise<void> {
  await deleteRollupDependenciesBySourceDatabase(client, id);
  await client.query("DELETE FROM items WHERE database_id = $1", [id]);
  const result = await client.query("DELETE FROM databases WHERE id = $1", [id]);
  requireAffectedRows(result, `delete of databases row ${id}`);
}
