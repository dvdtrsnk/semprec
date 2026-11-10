import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * Per-tenant cutover of issue #1612: adds the Threads `tasks` relation to Tasks, as the shared Threads builder
 * (`seed/seedEmailModule.ts`) creates it for a new tenant: `one_to_many` with Threads as the "one" side,
 * one-directional, owner `user`. Threads is schema-locked, so the property, its relation definition and its config
 * are written with direct SQL. A tenant without Threads or Tasks, or whose Threads already has `tasks` (a fresh
 * install, or a second run), is left unchanged.
 */
export async function runThreadTasksCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const threads = await getDatabaseByModuleId(client, THREADS_MODULE_ID);
    const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
    if (!threads || !tasks) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'tasks'",
      [threads.id],
    );
    if (existing.rows.length) return;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, 'tasks', NULL, 'relation', '{}'::jsonb, false, 'user', NULL) RETURNING id`,
      [threads.id],
    );
    const property = requireSingleRow(inserted.rows, "thread tasks property");
    const relations = await client.query<{ id: string }>(
      "INSERT INTO relation_definitions (property_id_a, property_id_b, cardinality) VALUES ($1, NULL, 'one_to_many') RETURNING id",
      [property.id],
    );
    const relation = requireSingleRow(relations.rows, "thread tasks relation");
    const configured = await client.query(
      "UPDATE properties SET config = jsonb_build_object('relationDefinitionId', $2::uuid, 'targetDatabaseId', $3::uuid) WHERE id = $1",
      [property.id, relation.id, tasks.id],
    );
    requireAffectedRows(configured, "thread tasks config");
  });
}
