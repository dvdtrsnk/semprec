import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { CAPTURE_CHANNELS } from "./captureSource.js";

/**
 * The properties this cutover adds, with the owner, owner process and config `seed/seedInboxPipeline.ts` gives them
 * for a fresh install; keep the two lists identical (`__tests__/tenantCutoverMigrations.test.ts` compares the shapes).
 */
const CAPTURE_PROPERTIES = [
  {
    key: "captureChannel",
    name: "Capture channel",
    type: "select",
    owner: "user",
    ownerProcess: null,
    config: { options: CAPTURE_CHANNELS.map((key) => ({ key })) },
  },
  { key: "sourceApp", name: "Source app", type: "text", owner: "user", ownerProcess: null, config: {} },
  {
    key: "addedAt",
    name: "Added at",
    type: "date",
    owner: "system",
    ownerProcess: INBOX_MODULE_ID,
    config: { includeTime: true },
  },
] as const;

/**
 * The cutover of the Inbox capture properties (issue gh-1964): the user-owned select `captureChannel`, the user-owned
 * text `sourceApp` and the system-owned date `addedAt` that the Inbox module writes. A populated tenant's Inbox
 * database is `schema_locked`, so the normal property writer refuses to add to it and this step inserts each missing
 * property with raw SQL, with the owner and owner process of the seed. It takes the same `EXCLUSIVE` lock on
 * `properties` for the length of the tenant's transaction, so the existence check cannot race an insert from another
 * session. The step is idempotent: a property that exists is left as it is, and no Inbox item is touched, so items that
 * exist keep the three properties empty. No-ops when the Inbox database does not exist yet.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via `runTenantCutoverMigrations`.
 */
export async function runInboxCapturePropertiesCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const inbox = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
    if (!inbox) return; // not seeded yet; the fresh-install seed ships the target shape

    await client.query(`LOCK TABLE properties IN EXCLUSIVE MODE`);
    const { rows } = await client.query<{ key: string }>(`SELECT key FROM properties WHERE database_id = $1`, [
      inbox.id,
    ]);
    const existing = new Set(rows.map((row) => row.key));
    for (const property of CAPTURE_PROPERTIES) {
      if (existing.has(property.key)) continue;
      // Raw SQL, not `propertiesStore.createProperty`: that refuses a schema-locked database, which is exactly the
      // database this cutover exists to change.
      await client.query(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
         VALUES ($1, $2, $3, $4, $5::jsonb, false, $6, $7)`,
        [
          inbox.id,
          property.key,
          property.name,
          property.type,
          JSON.stringify(property.config),
          property.owner,
          property.ownerProcess,
        ],
      );
    }
  });
}
