import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { BOOKS_MODULE_ID } from "../seed/libraryModuleKeys.js";

/** Adds missing Books metadata properties to a populated, schema-locked database in the scoped tenant. */
export async function runLibraryBooksYearIsbnCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const books = await getDatabaseByModuleId(client, BOOKS_MODULE_ID);
    if (!books) return;
    // Code-level system schema migration, following transcriptsCatalogCutoverMigration.
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const { rows } = await client.query<{ key: string }>(
      "SELECT key FROM properties WHERE database_id = $1 AND key = ANY($2::text[])",
      [books.id, ["year", "isbn"]],
    );
    const existing = new Set(rows.map((row) => row.key));
    for (const [key, type] of [
      ["year", "number"],
      ["isbn", "text"],
    ] as const) {
      if (existing.has(key)) continue;
      await client.query(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
         VALUES ($1, $2, NULL, $3, '{}'::jsonb, false, 'user', NULL)`,
        [books.id, key, type],
      );
    }
  });
}
