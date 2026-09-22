import type { Pool } from "pg";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { PEOPLE_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "./transcriptionJob.js";

/**
 * One-time populated-upgrade cutover for issue #180's Transcripts catalog extension
 * (mirroring `approvalRequestExecutionStatusCutoverMigration.ts`'s lock/idempotency-check/
 * backfill shape). `seedTenDatabases.ts` already declares the target shape — a `status` select
 * option `error` and a user-owned many-to-many `speakers` relation to People — but only for a
 * database this seed creates fresh; an instance whose Transcripts database was already
 * provisioned by an older build of that seed (before this issue) never receives either change,
 * since `properties.database_id`'s owning database stays `schema_locked` once seeded
 * (`assertDatabaseSchemaUnlocked` in `propertiesStore.ts` — "only a code-level migration may
 * change it", which is exactly what this is) and nothing re-runs the seed itself. No-ops
 * entirely when the Transcripts database doesn't exist yet (a genuinely fresh install, where
 * `seedTenDatabasesInTransaction` will create it with both pieces already in place).
 */
export async function runTranscriptsCatalogCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
    if (!transcripts) return; // not seeded yet; the fresh-install seed ships the target shape

    // Excludes concurrent schema reads/writes on this database's properties for the duration of
    // the cutover, so a reader never observes the `status` option added without `speakers`, or
    // either mid-write.
    await client.query(`LOCK TABLE properties IN EXCLUSIVE MODE`);

    // #245 assigns the three pipeline-owned properties to its sole composition root. This is
    // part of the catalog cutover as populated installs have locked Transcripts schemas.
    await client.query(
      `UPDATE properties SET owner_process = $2
       WHERE database_id = $1 AND key = ANY($3::text[]) AND owner = 'system'
         AND owner_process IS DISTINCT FROM $2`,
      [transcripts.id, TRANSCRIPTION_OWNER_PROCESS, ["status", "date", "link"]],
    );

    const { rows: statusRows } = await client.query<{
      id: string;
      config: { options?: { key: string }[] };
    }>(`SELECT id, config FROM properties WHERE database_id = $1 AND key = 'status'`, [transcripts.id]);
    const statusProperty = statusRows[0];
    if (statusProperty) {
      const options = statusProperty.config.options ?? [];
      if (!options.some((option) => option.key === "error")) {
        const result = await client.query(
          `UPDATE properties SET config = jsonb_set(config, '{options}', $2::jsonb) WHERE id = $1`,
          [statusProperty.id, JSON.stringify([...options, { key: "error" }])],
        );
        requireAffectedRows(result, "properties.status option backfill");
      }
    }

    const { rows: speakersRows } = await client.query<{ id: string }>(
      `SELECT id FROM properties WHERE database_id = $1 AND key = 'speakers'`,
      [transcripts.id],
    );
    if (speakersRows.length === 0) {
      const people = await getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
      if (people) {
        // Mirrors `createRelationPropertyWithClient`'s own three-step shape (create the
        // property, create the relation definition, then point the property's config at it) —
        // called directly with raw SQL rather than that helper, since it calls
        // `propertiesStore.createProperty`, which itself enforces `schema_locked` and would
        // reject exactly the write this migration exists to make.
        const { rows: propertyRows } = await client.query<{ id: string }>(
          `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
           VALUES ($1, 'speakers', 'Speakers', 'relation', '{}'::jsonb, false, 'user', NULL)
           RETURNING id`,
          [transcripts.id],
        );
        const propertyId = requireSingleRow(propertyRows, "properties row").id;

        const { rows: relationRows } = await client.query<{ id: string }>(
          `INSERT INTO relation_definitions (property_id_a, property_id_b, cardinality)
           VALUES ($1, NULL, 'many_to_many')
           RETURNING id`,
          [propertyId],
        );
        const relationDefinitionId = requireSingleRow(relationRows, "relation_definitions row").id;

        const result = await client.query(
          `UPDATE properties
             SET config = jsonb_build_object('relationDefinitionId', $2::uuid, 'targetDatabaseId', $3::uuid)
           WHERE id = $1`,
          [propertyId, relationDefinitionId, people.id],
        );
        requireAffectedRows(result, "properties.speakers config backfill");
      }
    }
  });
}
