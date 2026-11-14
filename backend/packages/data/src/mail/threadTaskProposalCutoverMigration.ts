import type { Pool } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { MAIL_THREAD_CARD_KIND } from "../inbox/mailThreadCard.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";

/** The relation property from a `mailThread` card to its Threads item, as `seed/seedInboxPipeline.ts` creates it. */
const SOURCE_THREAD_PROPERTY_KEY = "sourceThread";

const kindConfigSchema = z
  .object({ options: z.array(z.object({ key: z.string() }).passthrough()).optional() })
  .passthrough();

/**
 * Per-tenant cutover of issue gh-2034: adds what the card of a task that Semp proposes from a mail thread needs to a
 * tenant whose Processing proposals database was seeded before it, with the shape `seed/seedInboxPipeline.ts` gives a
 * new tenant:
 *
 * 1. the option `mailThread` of the `kind` select, appended after the options it has;
 * 2. the relation property `sourceThread` to Threads: `many_to_many` with Processing proposals as the source,
 *    one-directional, owner `system` with the Processing proposals module as owner process, named 'Source thread' as the seed names it.
 *
 * Processing proposals is schema-locked, so both are written with direct SQL, in the steps
 * `createRelationPropertyWithClient` takes (the property, the relation definition, then the property's config
 * pointing at the definition and the target database). Each part is added only when it is missing, so a second run, a
 * fresh install and a tenant that has one part but not the other all end in the same state. A tenant without the
 * Processing proposals database or without the Threads database is left unchanged. Runs once per tenant, in that
 * tenant's scope, via `runTenantCutoverMigrations`.
 */
export async function runThreadTaskProposalCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const proposals = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
    const threads = await getDatabaseByModuleId(client, THREADS_MODULE_ID);
    if (!proposals || !threads) return;
    // Excludes concurrent schema writes of `properties` for the rest of the transaction, so the presence checks below
    // and the inserts that follow them see the same schema.
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");

    const kinds = await client.query<{ id: string; config: unknown }>(
      "SELECT id, config FROM properties WHERE database_id = $1 AND key = 'kind'",
      [proposals.id],
    );
    const kind = requireSingleRow(kinds.rows, "properties.kind row of Processing proposals");
    const options = kindConfigSchema.parse(kind.config).options ?? [];
    if (!options.some((option) => option.key === MAIL_THREAD_CARD_KIND)) {
      const updated = await client.query(
        "UPDATE properties SET config = jsonb_set(config, '{options}', $2::jsonb) WHERE id = $1",
        [kind.id, JSON.stringify([...options, { key: MAIL_THREAD_CARD_KIND }])],
      );
      requireAffectedRows(updated, "properties.kind option backfill");
    }

    const existing = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
      [proposals.id, SOURCE_THREAD_PROPERTY_KEY],
    );
    if (existing.rows.length > 0) return;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, $2, 'Source thread', 'relation', '{}'::jsonb, false, 'system', $3) RETURNING id`,
      [proposals.id, SOURCE_THREAD_PROPERTY_KEY, PROCESSING_PROPOSALS_MODULE_ID],
    );
    const property = requireSingleRow(inserted.rows, "sourceThread property");
    const relations = await client.query<{ id: string }>(
      "INSERT INTO relation_definitions (property_id_a, property_id_b, cardinality) VALUES ($1, NULL, 'many_to_many') RETURNING id",
      [property.id],
    );
    const relation = requireSingleRow(relations.rows, "sourceThread relation");
    const configured = await client.query(
      "UPDATE properties SET config = jsonb_build_object('relationDefinitionId', $2::uuid, 'targetDatabaseId', $3::uuid) WHERE id = $1",
      [property.id, relation.id, threads.id],
    );
    requireAffectedRows(configured, "sourceThread config");
  });
}
