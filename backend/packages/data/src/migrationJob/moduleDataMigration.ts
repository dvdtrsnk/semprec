import type { Pool, PoolClient } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { lockItemBatch } from "./itemBatch.js";

/**
 * Converts one item's properties to the transition's target shape. Must be idempotent —
 * `converter(converter(p))` deep-equals `converter(p)` — because the runner makes two passes
 * over the database's items: the first skips rows another transaction holds locked, the
 * second revisits every row (blocking on a held one) so rows skipped or inserted below the
 * cursor during the first pass are converted too. Together they guarantee every row is
 * converted at least once and rewritten only when the converter actually changes it.
 */
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

interface Transition {
  moduleId: string;
  databaseKey: string;
  fromVersion: string;
  toVersion: string;
}

interface Progress {
  pass: 1 | 2;
  cursor: string | null;
}

const DEFAULT_PAGE_SIZE = 500;

/** One advisory-lock key per (moduleId, databaseKey, fromVersion, toVersion) transition. */
function lockKey(transition: Transition): string {
  const { moduleId, databaseKey, fromVersion, toVersion } = transition;
  return `module-data-migration:${moduleId}:${databaseKey}:${fromVersion}:${toVersion}`;
}

/**
 * Runs one manifest-declared data migration (issue #111) end to end: batched, id-ordered,
 * two-pass (see `ModuleDataMigrationConverter`), resumable from the transition's
 * `module_migration_progress` row, and guarded against concurrent runners of the same
 * (moduleId, databaseKey, fromVersion, toVersion) transition via a session-level Postgres
 * advisory lock held on a single dedicated connection for the whole run — the transition's
 * batches commit one at a time (for resumability), so a plain transaction-scoped lock can't
 * span them.
 *
 * A no-op if the transition is already recorded in `module_migrations` (already done by an
 * earlier run) or another runner currently holds its advisory lock (already in progress
 * elsewhere) — the caller is expected to retry later in either case.
 */
export async function runModuleDataMigration(pool: Pool, params: RunModuleDataMigrationParams): Promise<void> {
  const { moduleId, databaseKey, fromVersion, toVersion, converter } = params;
  const transition: Transition = { moduleId, databaseKey, fromVersion, toVersion };
  const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
  const key = lockKey(transition);

  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [key],
    );
    const { locked } = requireSingleRow(rows, "pg_try_advisory_lock");
    if (!locked) return;

    try {
      const { rows: existing } = await client.query<Record<string, unknown>>(
        `SELECT 1 FROM module_migrations WHERE module_id = $1 AND database_key = $2 AND from_version = $3 AND to_version = $4`,
        [moduleId, databaseKey, fromVersion, toVersion],
      );
      if (existing.length > 0) return;

      const database = await getDatabaseByModuleId(client, databaseKey);
      if (!database) throw new Error(`No database seeded for database key "${databaseKey}"`);

      await convertInBatches(pool, transition, database.id, converter, pageSize);

      await withTransaction(pool, async (txClient) => {
        await txClient.query(
          `INSERT INTO module_migrations (module_id, database_key, from_version, to_version)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (module_id, database_key, from_version, to_version) DO NOTHING`,
          [moduleId, databaseKey, fromVersion, toVersion],
        );
        await txClient.query(
          `DELETE FROM module_migration_progress
           WHERE module_id = $1 AND database_key = $2 AND from_version = $3 AND to_version = $4`,
          [moduleId, databaseKey, fromVersion, toVersion],
        );
      });
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    }
  } finally {
    client.release();
  }
}

/**
 * Converts `databaseId`'s items in deterministic id-ordered pages, each page row-locked for
 * its whole transaction (`lockItemBatch`) and committed together with the transition's
 * progress. Pass 1 skips rows another transaction holds locked; once it reaches the end the
 * progress resets to pass 2 with no cursor, which repeats the loop but waits on held rows, so
 * every row skipped or inserted below the cursor during pass 1 is visited before the caller
 * records the transition. A converter failure rolls back that batch's transaction — the
 * progress stays at the last committed batch of the current pass and the error propagates,
 * so a retry resumes from the recorded (pass, cursor) and no row is ever left partially
 * converted.
 */
async function convertInBatches(
  pool: Pool,
  transition: Transition,
  databaseId: string,
  converter: ModuleDataMigrationConverter,
  pageSize: number,
): Promise<void> {
  for (;;) {
    const finished = await withTransaction(pool, async (client) => {
      const progress = await readProgress(client, transition);
      const rows = await lockItemBatch(client, {
        databaseId,
        afterId: progress.cursor,
        pageSize,
        skipLocked: progress.pass === 1,
      });

      for (const row of rows) {
        const converted = converter(row.properties);
        // A full replace is safe only because the row is locked for this whole transaction.
        // Zero affected rows is the expected outcome when the converter left the row as is:
        // the guard keeps `updated_at` (the `ifVersion` token) untouched on such a row.
        await client.query(
          `UPDATE items SET properties = $3::jsonb, updated_at = now()
           WHERE database_id = $1 AND id = $2 AND properties IS DISTINCT FROM $3::jsonb`,
          [databaseId, row.id, JSON.stringify(converted)],
        );
      }

      const lastRow = rows[rows.length - 1];
      const cursor = lastRow?.id ?? progress.cursor;
      if (rows.length === pageSize) {
        await writeProgress(client, transition, { pass: progress.pass, cursor });
        return false;
      }
      if (progress.pass === 1) {
        await writeProgress(client, transition, { pass: 2, cursor: null });
        return false;
      }
      await writeProgress(client, transition, { pass: 2, cursor });
      return true;
    });

    if (finished) return;
  }
}

async function readProgress(client: PoolClient, transition: Transition): Promise<Progress> {
  const { rows } = await client.query<{ pass: number; cursor: string | null }>(
    `SELECT pass, cursor FROM module_migration_progress
     WHERE module_id = $1 AND database_key = $2 AND from_version = $3 AND to_version = $4`,
    [transition.moduleId, transition.databaseKey, transition.fromVersion, transition.toVersion],
  );
  const row = rows[0];
  if (row === undefined) return { pass: 1, cursor: null };
  if (row.pass !== 1 && row.pass !== 2) {
    throw new Error(`module_migration_progress.pass is ${String(row.pass)}, expected 1 or 2`);
  }
  return { pass: row.pass, cursor: row.cursor };
}

async function writeProgress(client: PoolClient, transition: Transition, progress: Progress): Promise<void> {
  await client.query(
    `INSERT INTO module_migration_progress (module_id, database_key, from_version, to_version, pass, cursor)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (module_id, database_key, from_version, to_version)
     DO UPDATE SET pass = EXCLUDED.pass, cursor = EXCLUDED.cursor`,
    [
      transition.moduleId,
      transition.databaseKey,
      transition.fromVersion,
      transition.toVersion,
      progress.pass,
      progress.cursor,
    ],
  );
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
