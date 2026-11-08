import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { JOURNAL_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

export async function runJournalProjectCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const journal = await getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
    const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!journal || !projects) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'project'",
      [journal.id],
    );
    if (existing.rows.length) return;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, 'project', NULL, 'relation', '{}'::jsonb, false, 'user', NULL) RETURNING id`,
      [journal.id],
    );
    const property = requireSingleRow(inserted.rows, "journal project property");
    const relations = await client.query<{ id: string }>(
      "INSERT INTO relation_definitions (property_id_a, property_id_b, cardinality) VALUES ($1, NULL, 'many_to_many') RETURNING id",
      [property.id],
    );
    const relation = requireSingleRow(relations.rows, "journal project relation");
    const configured = await client.query(
      "UPDATE properties SET config = jsonb_build_object('relationDefinitionId', $2::uuid, 'targetDatabaseId', $3::uuid) WHERE id = $1",
      [property.id, relation.id, projects.id],
    );
    requireAffectedRows(configured, "journal project config");
  });
}
