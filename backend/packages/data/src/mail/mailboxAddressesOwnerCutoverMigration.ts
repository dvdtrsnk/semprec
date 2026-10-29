import type { Pool } from "pg";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";

/**
 * One-time populated-upgrade cutover for issue #1454: flips `Mailboxes.addresses` from `owner: 'user'`
 * to `owner: 'system'` in a tenant seeded before that change, following
 * `transcriptsCatalogCutoverMigration.ts`. A fresh seed already declares the system owner
 * (seedEmailModule.ts). A tenant without a Mailboxes database is skipped. A Mailboxes database
 * without an `addresses` property fails the tenant rather than being passed over silently.
 *
 * Runs once per tenant, in that tenant's scope, via `runTenantCutoverMigrations`. Idempotent: a
 * property that is already system-owned is left alone, so a second run changes no row.
 */
export async function runMailboxAddressesOwnerCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const mailboxes = await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID);
    if (!mailboxes) return; // not seeded yet; the fresh-install seed declares the system owner

    // Blocks concurrent writes and row locks on the properties table for the cutover's duration; plain
    // SELECTs still run, and the owner read below happens after the lock is held.
    await client.query(`LOCK TABLE properties IN EXCLUSIVE MODE`);

    const { rows } = await client.query<{ owner: string }>(
      `SELECT owner FROM properties WHERE database_id = $1 AND key = 'addresses'`,
      [mailboxes.id],
    );
    const addresses = rows[0];
    if (!addresses) throw new Error(`Mailboxes database ${mailboxes.id} has no addresses property`);
    if (addresses.owner === "system") return;

    const result = await client.query(
      `UPDATE properties SET owner = 'system' WHERE database_id = $1 AND key = 'addresses' AND owner = 'user'`,
      [mailboxes.id],
    );
    requireAffectedRows(result, "Mailboxes.addresses owner cutover");
  });
}
