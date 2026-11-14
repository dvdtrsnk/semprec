import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";

/**
 * The cutover of the system property `splitFromProposalId` of Processing proposals (issue #1939), which a sibling card
 * made by splitting an Inbox source carries. `seed/seedInboxPipeline.ts` declares it for fresh installs, and
 * `__tests__/tenantCutoverMigrations.test.ts` checks that a cutover tenant ends with the shape of a fresh seed.
 *
 * Follows `runProcessingProposalsCardStateCutoverMigration`: a populated tenant's Processing proposals database is
 * `schema_locked`, so the normal property writer refuses to add to it and this step inserts the property with raw SQL,
 * system-owned with a NULL `owner_process` like the database's other card-state properties. It takes the same
 * `EXCLUSIVE` lock on `properties` for the length of the tenant's transaction, so the existence check cannot race an
 * insert from another session. The step is idempotent: an existing property is left as it is. No card is touched, as a
 * card without the property is a primary card. No-ops when the database does not exist yet.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via `runTenantCutoverMigrations`.
 */
export async function runProcessingProposalsSplitCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const proposals = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
    if (!proposals) return; // not seeded yet; the fresh-install seed ships the target shape

    await client.query(`LOCK TABLE properties IN EXCLUSIVE MODE`);
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM properties WHERE database_id = $1 AND key = 'splitFromProposalId'`,
      [proposals.id],
    );
    if (existing.rows.length > 0) return;
    // Raw SQL, not `propertiesStore.createProperty`: that refuses a schema-locked database, which is exactly the
    // database this cutover exists to change.
    await client.query(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, 'splitFromProposalId', 'Split from proposal ID', 'text', '{}'::jsonb, false, 'system', NULL)`,
      [proposals.id],
    );
  });
}
