import type { Pool } from "pg";
import { z } from "zod";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import type { PropertyType } from "../types.js";

/**
 * The card-state properties of Processing proposals (issue #1451). Each is system-owned with a NULL
 * `owner_process`, like the database's existing system properties. `seed/seedInboxPipeline.ts`
 * declares the same list for fresh installs; `__tests__/tenantCutoverMigrations.test.ts` checks that
 * a fresh seed and a cutover tenant end with the same shape.
 */
const CARD_STATE_PROPERTIES: ReadonlyArray<{ key: string; name: string; type: PropertyType }> = [
  { key: "aiProposal", name: "AI proposal", type: "json" },
  { key: "userOverrides", name: "User overrides", type: "json" },
  { key: "userEditedKeys", name: "User-edited keys", type: "json" },
  { key: "aiVersion", name: "AI version", type: "number" },
  { key: "reason", name: "Reason", type: "text" },
  { key: "recognizedTypeId", name: "Recognized type ID", type: "text" },
  { key: "typeCandidates", name: "Type candidates", type: "json" },
  { key: "candidates", name: "Candidates", type: "json" },
  { key: "invalidReason", name: "Invalid reason", type: "json" },
  { key: "referencedItemIds", name: "Referenced item IDs", type: "json" },
  { key: "results", name: "Results", type: "json" },
  { key: "context", name: "Context", type: "json" },
];

/**
 * The `status` options issue #1451 adds. They are appended in this order, which matches the fresh seed's
 * option order, so a populated tenant and a fresh tenant end with the same option list.
 */
const CARD_STATE_STATUS_OPTIONS = ["computing", "computeFailed"] as const;
const statusConfigSchema = z
  .object({ options: z.array(z.object({ key: z.string() }).passthrough()).optional() })
  .passthrough();

/**
 * One-time populated-upgrade cutover for issue #1451's Processing proposals card state (mirroring
 * `transcription/transcriptsCatalogCutoverMigration.ts`'s lock / idempotency-check / bulk-backfill
 * shape). `seed/seedInboxPipeline.ts` declares the target shape for a fresh install. A populated
 * tenant's Processing proposals database is `schema_locked`, so the normal property writer refuses
 * to add to it, and this cutover writes the missing properties and options with raw SQL instead.
 * No-ops when the database does not exist yet. A database that exists without its `status` property
 * is not a state this cutover repairs: it throws, and the tenant's transaction rolls back.
 *
 * Every step is idempotent: a missing property is inserted, a missing option is appended, and the
 * backfill matches only cards whose `aiProposal` is still empty. Each run therefore changes nothing
 * a previous run already wrote.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via
 * `runTenantCutoverMigrations`; it resolves that tenant's own Processing proposals database.
 */
export async function runProcessingProposalsCardStateCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const proposals = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
    if (!proposals) return; // not seeded yet; the fresh-install seed ships the target shape

    // Takes EXCLUSIVE on the whole `properties` table, not only this database's rows, for the length of
    // this tenant's transaction. Property inserts from other sessions wait, so the existence checks below
    // cannot race one of them.
    await client.query(`LOCK TABLE properties IN EXCLUSIVE MODE`);

    const { rows: existingRows } = await client.query<{ key: string }>(
      `SELECT key FROM properties WHERE database_id = $1`,
      [proposals.id],
    );
    const existingKeys = new Set(existingRows.map((row) => row.key));
    for (const property of CARD_STATE_PROPERTIES) {
      if (existingKeys.has(property.key)) continue;
      // Raw SQL, not `propertiesStore.createProperty`: that refuses a schema-locked database, which
      // is exactly the database this cutover exists to change.
      await client.query(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, false, 'system', NULL)`,
        [proposals.id, property.key, property.name, property.type],
      );
    }

    const { rows: statusRows } = await client.query<{ id: string; config: unknown }>(
      `SELECT id, config FROM properties WHERE database_id = $1 AND key = 'status'`,
      [proposals.id],
    );
    const status = requireSingleRow(statusRows, "properties.status row");
    const options = statusConfigSchema.parse(status.config).options ?? [];
    const missingOptions = CARD_STATE_STATUS_OPTIONS.filter((key) => !options.some((option) => option.key === key));
    if (missingOptions.length > 0) {
      const result = await client.query(
        `UPDATE properties SET config = jsonb_set(config, '{options}', $2::jsonb) WHERE id = $1`,
        [status.id, JSON.stringify([...options, ...missingOptions.map((key) => ({ key }))])],
      );
      requireAffectedRows(result, "properties.status option backfill");
    }

    // Bulk, idempotent backfill: a card with no proposal, or one whose aiProposal is already set,
    // matches nothing. Zero affected rows is therefore a legitimate outcome, so rowCount is deliberately
    // not checked. The backfill does not change `updated_at` and emits no invalidation.
    await client.query(
      `UPDATE items
         SET properties = jsonb_set(properties, '{aiProposal}', properties -> 'proposal')
       WHERE database_id = $1
         AND properties -> 'proposal' IS NOT NULL AND properties -> 'proposal' <> 'null'::jsonb
         AND (properties -> 'aiProposal' IS NULL OR properties -> 'aiProposal' = 'null'::jsonb)`,
      [proposals.id],
    );
  });
}
