import type { Pool, PoolClient } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";

export type ModuleDataMigrationConverter = (properties: Record<string, unknown>) => Record<string, unknown>;

export interface RunModuleDataMigrationParams {
  moduleId: string;
  databaseKey: string;
  fromVersion: string;
  toVersion: string;
  converter: ModuleDataMigrationConverter;
  /** Item rows converted per committed batch. Overridable only for tests. */
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 500;

/** One advisory-lock key per (moduleId, databaseKey, fromVersion, toVersion) transition. */
function lockKey(moduleId: string, databaseKey: string, fromVersion: string, toVersion: string): string {
  return `module-data-migration:${moduleId}:${databaseKey}:${fromVersion}:${toVersion}`;
}

/**
 * Runs one manifest-declared data migration (issue #111) end to end: batched, id-ordered,
 * resumable from `databases.migration_cursor`, and guarded against concurrent runners of
 * the same (moduleId, databaseKey, fromVersion, toVersion) transition via a session-level
 * Postgres advisory lock held on a single dedicated connection for the whole run — the
 * transition's batches commit one at a time (for resumability), so a plain transaction-
 * scoped lock can't span them.
 *
 * A no-op if the transition is already recorded in `module_migrations` (already done by an
 * earlier run) or another runner currently holds its advisory lock (already in progress
 * elsewhere) — the caller is expected to retry later in either case.
 */
export async function runModuleDataMigration(pool: Pool, params: RunModuleDataMigrationParams): Promise<void> {
  const { moduleId, databaseKey, fromVersion, toVersion, converter } = params;
  const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
  const key = lockKey(moduleId, databaseKey, fromVersion, toVersion);

  const client = await pool.connect();
  try {
    const {
      rows: [{ locked }],
    } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [
      key,
    ]);
    if (!locked) return;

    try {
      const { rows: existing } = await client.query(
        `SELECT 1 FROM module_migrations WHERE module_id = $1 AND database_key = $2 AND from_version = $3 AND to_version = $4`,
        [moduleId, databaseKey, fromVersion, toVersion],
      );
      if (existing.length > 0) return;

      const database = await getDatabaseByModuleId(client, databaseKey);
      if (!database) throw new Error(`No database seeded for database key "${databaseKey}"`);

      await convertInBatches(pool, database.id, converter, pageSize);

      await withTransaction(pool, async (txClient) => {
        await txClient.query(
          `INSERT INTO module_migrations (module_id, database_key, from_version, to_version)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (module_id, database_key, from_version, to_version) DO NOTHING`,
          [moduleId, databaseKey, fromVersion, toVersion],
        );
        await txClient.query(`UPDATE databases SET migration_cursor = NULL WHERE id = $1`, [database.id]);
      });
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    }
  } finally {
    client.release();
  }
}

/**
 * Converts `databaseId`'s items in deterministic id-ordered pages, committing
 * `databases.migration_cursor` after each successfully converted batch. A converter
 * failure rolls back that batch's transaction — the cursor stays at the last committed
 * item and rethrows, so already-committed batches are never replayed and no row is ever
 * left partially converted.
 */
async function convertInBatches(
  pool: Pool,
  databaseId: string,
  converter: ModuleDataMigrationConverter,
  pageSize: number,
): Promise<void> {
  for (;;) {
    const rowCount = await withTransaction(pool, async (client) => {
      const cursor = await readCursor(client, databaseId);
      const { rows } = await client.query<{ id: string; properties: Record<string, unknown> }>(
        `SELECT id, properties FROM items WHERE database_id = $1 ${cursor ? "AND id > $3" : ""}
         ORDER BY id ASC LIMIT $2`,
        cursor ? [databaseId, pageSize, cursor] : [databaseId, pageSize],
      );

      for (const row of rows) {
        const converted = converter(row.properties);
        await client.query(
          `UPDATE items SET properties = $3::jsonb, updated_at = now() WHERE database_id = $1 AND id = $2`,
          [databaseId, row.id, JSON.stringify(converted)],
        );
      }

      if (rows.length > 0) {
        await client.query(`UPDATE databases SET migration_cursor = $2 WHERE id = $1`, [
          databaseId,
          rows[rows.length - 1].id,
        ]);
      }
      return rows.length;
    });

    if (rowCount < pageSize) return;
  }
}

async function readCursor(client: PoolClient, databaseId: string): Promise<string | null> {
  const { rows } = await client.query<{ migration_cursor: string | null }>(
    `SELECT migration_cursor FROM databases WHERE id = $1`,
    [databaseId],
  );
  return rows[0]?.migration_cursor ?? null;
}

/**
 * Runs every data migration the currently active modules declare (`ModuleRegistry.
 * getDataMigrationDefinitions()`) — the "manifest scripts" entry point for issue #111.
 * Each one is independently a no-op if already recorded or already in progress elsewhere,
 * so calling this repeatedly (e.g. from a heartbeat sweep) is always safe.
 */
export async function runModuleDataMigrations(pool: Pool, moduleRegistry: ModuleRegistry): Promise<void> {
  const migrations = await moduleRegistry.getDataMigrationDefinitions();
  for (const migration of migrations) {
    await runModuleDataMigration(pool, migration);
  }
}
