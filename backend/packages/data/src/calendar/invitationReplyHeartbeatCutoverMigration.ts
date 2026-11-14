import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { INVITATIONS_MODULE_ID } from "../seed/invitationsKeys.js";
import { EVENTS_MODULE_ID, PEOPLE_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID, invitationReplyHeartbeat } from "./invitationReplyAction.js";

/**
 * Populated-upgrade cutover for issue gh-1950 (docs/adr/2026-09-10-app-code-post-migration-steps.md): a tenant that
 * has the invitations database of gh-1901 but no `calendar.applyInvitationReply` heartbeat gets the one the fresh seed
 * (`seedInvitationsDatabaseInTransaction`) creates, on the system project item that owns the Invitations database.
 * Registered after the cutovers of gh-1901 and gh-1929, which create the database and the ingest heartbeat it sits
 * beside.
 *
 * Idempotent: it does nothing when the tenant has the heartbeat, has no Invitations database, or lacks the Emails,
 * Events or People database the heartbeat names. In one transaction under a share-row-exclusive lock on
 * `project_heartbeats`, which serializes two concurrent runs so neither sees the other's heartbeat missing and both
 * insert it.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via `runTenantCutoverMigrations`.
 */
export async function runInvitationReplyHeartbeatCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("LOCK TABLE project_heartbeats IN SHARE ROW EXCLUSIVE MODE");
    const existing = await client.query("SELECT 1 FROM project_heartbeats WHERE action_id = $1", [
      CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID,
    ]);
    if ((existing.rowCount ?? 0) > 0) return;
    const invitations = await getDatabaseByModuleId(client, INVITATIONS_MODULE_ID);
    const projectItemId = invitations?.ownerProjectItemId ?? null;
    if (!invitations || projectItemId === null) return;
    const emails = await getDatabaseByModuleId(client, EMAILS_MODULE_ID);
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    const people = await getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
    if (!emails || !events || !people) return;
    await createHeartbeat(
      client,
      invitationReplyHeartbeat({
        projectItemId,
        emailsDatabaseId: emails.id,
        eventsDatabaseId: events.id,
        peopleDatabaseId: people.id,
      }),
    );
  });
}
