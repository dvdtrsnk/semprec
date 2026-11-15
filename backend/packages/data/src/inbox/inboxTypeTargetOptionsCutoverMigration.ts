import type { Pool } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { INBOX_ITEM_TYPES_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { INBOX_TYPE_MODULE_TARGET_DATABASES } from "./inboxTypesStore.js";

const targetDatabasePropertySchema = z.object({
  id: z.string(),
  config: z.object({ options: z.array(z.object({ key: z.string() }).passthrough()) }).passthrough(),
});

/**
 * Populated-upgrade cutover for the Inbox item types `targetDatabase` select (issue #1973): appends the option of each
 * database in `INBOX_TYPE_MODULE_TARGET_DATABASES` that `seedInboxPipeline.ts` now declares for fresh installs. The Inbox
 * item types database is schema-locked once seeded, so only this code-level migration may change it. It never reorders
 * or removes an option, adds only the keys that are absent, and is a no-op when the tenant has no Inbox item types
 * database yet (the seed then creates the target shape). An Inbox item types database whose `targetDatabase` property is
 * missing or malformed is an invariant violation and fails the tenant's step.
 *
 * Runs once per tenant, in that tenant's scope, via `runTenantCutoverMigrations`.
 */
export async function runInboxTypeTargetOptionsCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const inboxItemTypes = await getDatabaseByModuleId(client, INBOX_ITEM_TYPES_MODULE_ID);
    if (!inboxItemTypes) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const { rows } = await client.query<Record<string, unknown>>(
      "SELECT id, config FROM properties WHERE database_id = $1 AND key = 'targetDatabase'",
      [inboxItemTypes.id],
    );
    if (!rows[0]) throw new Error("The Inbox item types database has no 'targetDatabase' property");
    const property = targetDatabasePropertySchema.parse(rows[0]);
    const missing = INBOX_TYPE_MODULE_TARGET_DATABASES.filter(
      (key) => !property.config.options.some((option) => option.key === key),
    );
    if (missing.length === 0) return;
    const result = await client.query(
      "UPDATE properties SET config = jsonb_set(config, '{options}', $2::jsonb) WHERE id = $1",
      [property.id, JSON.stringify([...property.config.options, ...missing.map((key) => ({ key }))])],
    );
    requireAffectedRows(result, "properties.inboxItemTypes.targetDatabase option backfill");
  });
}
