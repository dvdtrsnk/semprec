import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { INVITATIONS_MODULE_ID } from "../seed/invitationsKeys.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { CALENDAR_INGEST_INVITATION_ACTION_ID, invitationIngestHeartbeat } from "./invitationIngestAction.js";

/**
 * Populated-upgrade cutover for issue gh-1929 (docs/adr/2026-09-10-app-code-post-migration-steps.md): a tenant that
 * has the invitations database of gh-1901 but no `calendar.ingestInvitation` heartbeat gets the one the fresh seed
 * (`seedInvitationsDatabaseInTransaction`) creates, on the system project item that owns the Invitations database.
 * Registered after the cutover of gh-1901, which also creates the heartbeat for a tenant it seeds the database for;
 * for that tenant this step finds it.
 *
 * Idempotent: it does nothing when the tenant has the heartbeat, has no Invitations database or has no Emails
 * database. In one transaction under a share-row-exclusive lock on `project_heartbeats`, which serializes two
 * concurrent runs so neither sees the other's heartbeat missing and both insert it.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via `runTenantCutoverMigrations`.
 */
export async function runInvitationIngestHeartbeatCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("LOCK TABLE project_heartbeats IN SHARE ROW EXCLUSIVE MODE");
    const existing = await client.query("SELECT 1 FROM project_heartbeats WHERE action_id = $1", [
      CALENDAR_INGEST_INVITATION_ACTION_ID,
    ]);
    if ((existing.rowCount ?? 0) > 0) return;
    const invitations = await getDatabaseByModuleId(client, INVITATIONS_MODULE_ID);
    const projectItemId = invitations?.ownerProjectItemId ?? null;
    if (!invitations || projectItemId === null) return;
    const emails = await getDatabaseByModuleId(client, EMAILS_MODULE_ID);
    if (!emails) return;
    await createHeartbeat(
      client,
      invitationIngestHeartbeat({
        projectItemId,
        emailsDatabaseId: emails.id,
        invitationsDatabaseId: invitations.id,
      }),
    );
  });
}
