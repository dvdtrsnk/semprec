import type { Pool } from "pg";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";

/**
 * One-time populated-upgrade cutover for issue #1457: switches `Emails.senderPeople` from
 * `one_to_many` to `many_to_many`, so one person can be the sender of many emails. A fresh seed
 * already declares `many_to_many` (seedEmailModule.ts). Follows `transcriptsCatalogCutoverMigration.ts`:
 * the same `properties` lock, then an idempotent update. A tenant without an Emails database is
 * skipped. An Emails database whose `senderPeople` relation is missing fails the tenant rather than
 * being passed over silently: the Emails seed never produces that shape.
 *
 * Runs once per tenant, in that tenant's scope, via `runTenantCutoverMigrations`. Idempotent: the
 * update matches only a definition that is not already `many_to_many`, so a second run changes no row.
 */
export async function runEmailsSenderPeopleCardinalityCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const emails = await getDatabaseByModuleId(client, EMAILS_MODULE_ID);
    if (!emails) return; // not seeded yet; the fresh-install seed declares many_to_many

    // The same lock the Transcripts cutover takes, held on the shared properties table for the
    // cutover's duration.
    await client.query(`LOCK TABLE properties IN EXCLUSIVE MODE`);

    const { rows } = await client.query<{ id: string }>(
      `SELECT rd.id FROM relation_definitions rd
         JOIN properties p ON p.id = rd.property_id_a
        WHERE p.database_id = $1 AND p.key = 'senderPeople'`,
      [emails.id],
    );
    const definition = requireSingleRow(rows, "Emails.senderPeople relation definition");

    // Idempotent UPDATE: zero affected rows is legitimate (the definition is already many_to_many),
    // so rowCount is deliberately not checked.
    await client.query(
      `UPDATE relation_definitions SET cardinality = 'many_to_many'
        WHERE id = $1 AND cardinality <> 'many_to_many'`,
      [definition.id],
    );
  });
}
