import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { INBOX_ITEM_TYPES_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/** The most Inbox item types one transaction converts through the choke point. */
const PAGE_SIZE = 100;

const JOURNAL_METHOD = "journal";

const processingMethodPropertySchema = z.object({
  id: z.string(),
  config: z.object({ options: z.array(z.object({ key: z.string() }).passthrough()) }).passthrough(),
});

/**
 * Step (a): appends the `journal` option to the `processingMethod` select, which `seedInboxPipeline.ts` declares for
 * fresh installs. The Inbox item types database is schema-locked once seeded, so only this code-level migration may
 * change it. It never reorders or removes an option. Returns the Inbox item types database id, or `null` when the
 * tenant has none (the seed then creates the new shape). A database whose `processingMethod` property is missing or
 * malformed is an invariant violation and fails the tenant's step.
 */
async function addJournalOption(pool: Pool): Promise<string | null> {
  return withTransaction(pool, async (client) => {
    const inboxItemTypes = await getDatabaseByModuleId(client, INBOX_ITEM_TYPES_MODULE_ID);
    if (!inboxItemTypes) return null;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const { rows } = await client.query<Record<string, unknown>>(
      "SELECT id, config FROM properties WHERE database_id = $1 AND key = 'processingMethod'",
      [inboxItemTypes.id],
    );
    if (!rows[0]) throw new Error("The Inbox item types database has no 'processingMethod' property");
    const property = processingMethodPropertySchema.parse(rows[0]);
    if (property.config.options.some((option) => option.key === JOURNAL_METHOD)) return inboxItemTypes.id;
    const result = await client.query(
      "UPDATE properties SET config = jsonb_set(config, '{options}', $2::jsonb) WHERE id = $1",
      [property.id, JSON.stringify([...property.config.options, { key: JOURNAL_METHOD }])],
    );
    requireAffectedRows(result, "properties.inboxItemTypes.processingMethod option backfill");
    return inboxItemTypes.id;
  });
}

/**
 * One committed page of step (b): the next at most `PAGE_SIZE` live types with `processingMethod: 'database'` and
 * `targetDatabase: 'journal'`, each rewritten to `processingMethod: 'journal'` with `targetDatabase: null` through
 * the choke point (the default system writer, so the change is recorded and announced after commit). The choke point
 * merges the patch into the stored properties, so `null` is how it clears a key: the key stays with a JSON `null`,
 * which every reader and the type-write rules take as unset. `convertTrashedTypes` stores the same shape. The rows are
 * selected and locked `FOR UPDATE` in the transaction that rewrites them, and a rewritten row no longer matches the
 * selection, so the next page starts at the next unconverted row. Returns the number of types converted.
 */
async function convertLiveTypes(client: PoolClient, typesDatabaseId: string): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
      WHERE database_id = $1 AND deleted_at IS NULL
        AND properties ->> 'processingMethod' = 'database' AND properties ->> 'targetDatabase' = $2
      ORDER BY id LIMIT $3 FOR UPDATE`,
    [typesDatabaseId, JOURNAL_MODULE_ID, PAGE_SIZE],
  );
  for (const row of rows) {
    await updateItemWithClient(client, {
      databaseId: typesDatabaseId,
      itemId: row.id,
      propertiesPatch: { processingMethod: JOURNAL_METHOD, targetDatabase: null },
    });
  }
  return rows.length;
}

/**
 * A type in the Trash cannot be written through the choke point, which refuses a deleted item. The few of them that
 * hold the pairing are locked, then converted in one statement that sets the method and `targetDatabase: null` (the
 * shape `convertLiveTypes` leaves), so a type that is restored later is not the stale pairing the type-write rules now
 * refuse. `updated_at` and the trash state are left as they are. This statement is the one exception to the choke
 * point that the cutover makes, recorded in
 * `docs/adr/2026-11-14-the-journal-method-cutover-converts-trashed-types-with-one-statement.md`.
 */
async function convertTrashedTypes(client: PoolClient, typesDatabaseId: string): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
      WHERE database_id = $1 AND deleted_at IS NOT NULL
        AND properties ->> 'processingMethod' = 'database' AND properties ->> 'targetDatabase' = $2
      ORDER BY id FOR UPDATE`,
    [typesDatabaseId, JOURNAL_MODULE_ID],
  );
  if (rows.length === 0) return;
  const result = await client.query(
    `UPDATE items SET properties = properties || jsonb_build_object('processingMethod', $3::text, 'targetDatabase', null)
      WHERE database_id = $1 AND id = ANY($2::uuid[])`,
    [typesDatabaseId, rows.map((row) => row.id), JOURNAL_METHOD],
  );
  if (result.rowCount !== rows.length)
    throw new Error("Trashed Inbox item type conversion changed an unexpected row count");
}

/**
 * Populated-upgrade cutover for the `journal` processing method of an Inbox item type (issue gh-1975).
 *
 * (a) Adds the `journal` option to the `processingMethod` select of the tenant's Inbox item types database.
 * (b) Converts every Inbox item type with `processingMethod: 'database'` and `targetDatabase: 'journal'` — the pairing
 * the type-write rules now refuse — to `processingMethod: 'journal'` without a target (`targetDatabase: null`, unset), live types through the choke
 * point in pages of `PAGE_SIZE`, trashed ones in one statement. Step (a) is committed first, so the select check of
 * the choke point accepts the new value.
 *
 * Both steps change nothing on a second run: the option is found, and no type matches the selection. A tenant without
 * an Inbox item types database is skipped.
 *
 * Runs once per tenant, in that tenant's scope, via `runTenantCutoverMigrations`.
 */
export async function runInboxJournalMethodCutoverMigration(pool: Pool): Promise<void> {
  const typesDatabaseId = await addJournalOption(pool);
  if (typesDatabaseId === null) return;
  for (;;) {
    const converted = await withTransaction(pool, (client) => convertLiveTypes(client, typesDatabaseId));
    if (converted < PAGE_SIZE) break;
  }
  await withTransaction(pool, (client) => convertTrashedTypes(client, typesDatabaseId));
}
