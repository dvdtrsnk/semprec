import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { INVITATIONS_MODULE_ID } from "../seed/invitationsKeys.js";
import { seedInvitationsDatabaseInTransaction } from "../seed/seedInvitationsDatabase.js";
import { lockTenantSeedInTransaction } from "../seed/seedSystem.js";

/**
 * Populated-upgrade cutover for issue gh-1901, registered after the Calendars cutover of #1600
 * (docs/adr/2026-09-10-app-code-post-migration-steps.md): `seedSystem` creates the `invitations` database
 * only for a new tenant, since it finishes with `already-seeded` for an existing one. In one transaction under
 * the tenant's structural seed lock (the lock `seedSystem` and the calendars cutover use), it creates the
 * database through the same `seedInvitationsDatabaseInTransaction` the fresh seed calls.
 *
 * Idempotent: a tenant that already has the database is left unchanged, and so is a tenant without a
 * Calendars database (the calendars cutover skips a tenant without an Events database).
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via
 * `runTenantCutoverMigrations`.
 */
export async function runInvitationsDatabaseCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockTenantSeedInTransaction(client, "runInvitationsDatabaseCutoverMigration");
    const calendars = await getDatabaseByModuleId(client, CALENDARS_MODULE_ID);
    if (!calendars) return;
    if (await getDatabaseByModuleId(client, INVITATIONS_MODULE_ID)) return;
    await seedInvitationsDatabaseInTransaction(client, calendars);
  });
}
