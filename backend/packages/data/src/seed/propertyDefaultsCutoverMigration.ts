import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";

/** Installs the six shipped defaults in the caller's tenant without changing existing config values. */
export async function runPropertyDefaultsCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    // Code-level schema cutover: the normal property writer refuses schema-locked system databases.
    // Bulk update, including missing databases/properties: zero matches is a legitimate no-op.
    await client.query(
      `UPDATE properties p
       SET config = jsonb_set(p.config, '{default}', defaults.value)
       FROM databases d,
         (VALUES ('projects', 'status', '"inProgress"'::jsonb),
                 ('tasks', 'status', '"notDone"'::jsonb),
                 ('areas', 'active', 'true'::jsonb),
                 ('files', 'date', '"today"'::jsonb),
                 ('books', 'status', '"toRead"'::jsonb),
                 ('movies', 'status', '"planned"'::jsonb)) AS defaults(module_id, key, value)
       WHERE p.database_id = d.id AND d.system = true
         AND d.owner_module_id = defaults.module_id AND p.key = defaults.key
         AND NOT (p.config ? 'default')`,
    );
  });
}
