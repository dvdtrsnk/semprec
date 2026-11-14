import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { EMAILS_MODULE_ID, THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * Per-tenant cutover of issue gh-1898: adds the Threads `attachments` relation to Files, as the shared Threads
 * builder (`seed/seedEmailModule.ts`) creates it for a new tenant: `one_to_many` with Threads as the "one" side,
 * one-directional, `owner: system` with the `emails` process as owner. Threads is schema-locked, so the property, its
 * relation definition and its config are written with direct SQL. A tenant without Threads or Files, or whose Threads
 * already has `attachments` (a fresh install, or a second run), is left unchanged. Attachments that already exist get
 * no edge and keep their values.
 */
export async function runThreadAttachmentsCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const threads = await getDatabaseByModuleId(client, THREADS_MODULE_ID);
    const files = await getDatabaseByModuleId(client, FILES_MODULE_ID);
    if (!threads || !files) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'attachments'",
      [threads.id],
    );
    if (existing.rows.length) return;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, 'attachments', NULL, 'relation', '{}'::jsonb, false, 'system', $2) RETURNING id`,
      [threads.id, EMAILS_MODULE_ID],
    );
    const property = requireSingleRow(inserted.rows, "thread attachments property");
    const relations = await client.query<{ id: string }>(
      "INSERT INTO relation_definitions (property_id_a, property_id_b, cardinality) VALUES ($1, NULL, 'one_to_many') RETURNING id",
      [property.id],
    );
    const relation = requireSingleRow(relations.rows, "thread attachments relation");
    const configured = await client.query(
      "UPDATE properties SET config = jsonb_build_object('relationDefinitionId', $2::uuid, 'targetDatabaseId', $3::uuid) WHERE id = $1",
      [property.id, relation.id, files.id],
    );
    requireAffectedRows(configured, "thread attachments config");
  });
}
