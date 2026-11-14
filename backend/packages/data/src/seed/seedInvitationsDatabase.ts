import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationPropertyWithClient } from "../chokePoint/relationPropertyOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import { CALENDAR_MODULE_ID } from "../calendar/calendarModuleId.js";
import { invitationIngestHeartbeat } from "../calendar/invitationIngestAction.js";
import { invitationReplyHeartbeat } from "../calendar/invitationReplyAction.js";
import { requireAffectedRows } from "../db/pool.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import type { DatabaseRow, PropertyType } from "../types.js";
import { EMAILS_MODULE_ID, MAILBOXES_MODULE_ID } from "./emailModuleKeys.js";
import { INVITATIONS_MODULE_ID } from "./invitationsKeys.js";
import { CALENDARS_MODULE_ID } from "./calendarsKeys.js";
import { EVENTS_MODULE_ID, PEOPLE_MODULE_ID } from "./tenDatabaseKeys.js";

/** The `status` options of an invitation; `cancelled` means the organizer cancelled the meeting. */
const INVITATION_STATUSES = ["pending", "accepted", "tentative", "declined", "acknowledged", "cancelled"] as const;

/** The `kind` options of an invitation. */
const INVITATION_KINDS = ["invite", "sharedCalendarNotice"] as const;

interface PropSpec {
  key: string;
  type: PropertyType;
  config?: Record<string, unknown>;
}

const selectConfig = (options: readonly string[]): Record<string, unknown> => ({
  options: options.map((key) => ({ key })),
});

/** Every property is system-owned by the calendar module (`seedInvitationsDatabaseInTransaction`). */
const INVITATION_PROPERTIES: readonly PropSpec[] = [
  { key: "title", type: "title" },
  { key: "startsAt", type: "date", config: { includeTime: true } },
  { key: "endsAt", type: "date", config: { includeTime: true } },
  { key: "timeZone", type: "text" },
  { key: "allDay", type: "checkbox" },
  { key: "place", type: "text" },
  { key: "organizerName", type: "text" },
  { key: "organizerEmail", type: "text" },
  { key: "status", type: "select", config: selectConfig(INVITATION_STATUSES) },
  { key: "respondedAt", type: "date", config: { includeTime: true } },
  { key: "uid", type: "text" },
  { key: "sequence", type: "number" },
  { key: "kind", type: "select", config: selectConfig(INVITATION_KINDS) },
];

/** The one-directional relations, each to a database whose schema is already locked, as `[key, target module id]`. */
const INVITATION_RELATIONS: ReadonlyArray<readonly [string, string]> = [
  ["suggestedCalendar", CALENDARS_MODULE_ID],
  ["event", EVENTS_MODULE_ID],
  ["sourceEmail", EMAILS_MODULE_ID],
  ["mailbox", MAILBOXES_MODULE_ID],
];

const CALENDAR_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: CALENDAR_MODULE_ID };

/**
 * Seeds the system `invitations` database of the calendar module (issue gh-1901) into the caller's open
 * transaction, owned by the same system project item as `calendarsDatabase`: the incoming meeting
 * invitations that wait for the user's answer. Every property and relation is `owner: 'system'` with the
 * calendar module as owner process, so the generic write path refuses them. The four relations
 * (`suggestedCalendar`, `event`, `sourceEmail`, `mailbox`) are `many_to_many` and one-directional, because
 * the schemas of their targets are locked; the schema of the new database is locked once complete. It
 * creates no rows. It also creates the `calendar.ingestInvitation` heartbeat (issue gh-1929) on the same system project
 * item: it fires on every new Emails item and reads the message's calendar part. A populated tenant that already has
 * the database gets the heartbeat from `calendar/invitationIngestHeartbeatCutoverMigration.ts`. The
 * `calendar.applyInvitationReply` heartbeat (issue gh-1950) is created on the same project item and fires on every new
 * Emails item as well; a populated tenant gets it from `calendar/invitationReplyHeartbeatCutoverMigration.ts`.
 *
 * Not idempotent on its own: `seedSystem` calls it once for a new tenant, and
 * `calendar/invitationsDatabaseCutoverMigration.ts` calls it only for a tenant without an invitations
 * database. The Events, People, Emails and Mailboxes databases must already exist.
 */
export async function seedInvitationsDatabaseInTransaction(
  client: PoolClient,
  calendarsDatabase: DatabaseRow,
): Promise<void> {
  if (!calendarsDatabase.ownerProjectItemId) throw new Error("The calendars database has no owner project item");
  const database = await databasesStore.createDatabase(client, {
    name: null,
    key: INVITATIONS_MODULE_ID,
    system: true,
    ownerModuleId: INVITATIONS_MODULE_ID,
    ownerProjectItemId: calendarsDatabase.ownerProjectItemId,
  });
  for (const spec of INVITATION_PROPERTIES) {
    // `name` is null like every built-in property of a system database; labels come from the calendar catalog.
    await propertiesStore.createProperty(client, {
      databaseId: database.id,
      key: spec.key,
      name: null,
      type: spec.type,
      owner: "system",
      ownerProcess: CALENDAR_MODULE_ID,
      config: spec.config,
    });
  }
  for (const [key, targetModuleId] of INVITATION_RELATIONS) {
    const target = await databasesStore.getDatabaseByModuleId(client, targetModuleId);
    if (!target) throw new Error(`The ${targetModuleId} database has not been seeded`);
    await createRelationPropertyWithClient(
      client,
      {
        sourceDatabaseId: database.id,
        key,
        name: null,
        targetDatabaseId: target.id,
        cardinality: "many_to_many",
        owner: "system",
        ownerProcess: CALENDAR_MODULE_ID,
      },
      CALENDAR_RELATION_CONTEXT,
    );
  }
  requireAffectedRows(
    await client.query("UPDATE databases SET schema_locked = true WHERE id = $1", [database.id]),
    "invitations schema lock",
  );
  const emails = await databasesStore.getDatabaseByModuleId(client, EMAILS_MODULE_ID);
  if (!emails) throw new Error(`The ${EMAILS_MODULE_ID} database has not been seeded`);
  await createHeartbeat(
    client,
    invitationIngestHeartbeat({
      projectItemId: calendarsDatabase.ownerProjectItemId,
      emailsDatabaseId: emails.id,
      invitationsDatabaseId: database.id,
    }),
  );
  const people = await databasesStore.getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
  if (!people) throw new Error(`The ${PEOPLE_MODULE_ID} database has not been seeded`);
  const events = await databasesStore.getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  if (!events) throw new Error(`The ${EVENTS_MODULE_ID} database has not been seeded`);
  await createHeartbeat(
    client,
    invitationReplyHeartbeat({
      projectItemId: calendarsDatabase.ownerProjectItemId,
      emailsDatabaseId: emails.id,
      eventsDatabaseId: events.id,
      peopleDatabaseId: people.id,
    }),
  );
}
