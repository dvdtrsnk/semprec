import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createRelationPropertyWithClient } from "../chokePoint/relationPropertyOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import { CALENDAR_MODULE_ID } from "../calendar/calendarModuleId.js";
import { invitationIngestHeartbeat } from "../calendar/invitationIngestAction.js";
import { invitationReplyHeartbeat } from "../calendar/invitationReplyAction.js";
import { requireAffectedRows } from "../db/pool.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import type { DatabaseRow } from "../types.js";
import { EMAILS_MODULE_ID, MAILBOXES_MODULE_ID } from "./emailModuleKeys.js";
import { INVITATIONS_MODULE_ID } from "./invitationsKeys.js";
import { CALENDARS_MODULE_ID } from "./calendarsKeys.js";
import { EVENTS_MODULE_ID, PEOPLE_MODULE_ID } from "./tenDatabaseKeys.js";
import { createProps, selectConfig, type PropSpec } from "./propSpecs.js";

/** The `status` options of an invitation; `cancelled` means the organizer cancelled the meeting. */
const INVITATION_STATUSES = ["pending", "accepted", "tentative", "declined", "acknowledged", "cancelled"] as const;

const INVITATION_KINDS = ["invite", "sharedCalendarNotice"] as const;

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

/** One-directional, since their targets' schemas are already locked; `[key, target module id]`. */
const INVITATION_RELATIONS: ReadonlyArray<readonly [string, string]> = [
  ["suggestedCalendar", CALENDARS_MODULE_ID],
  ["event", EVENTS_MODULE_ID],
  ["sourceEmail", EMAILS_MODULE_ID],
  ["mailbox", MAILBOXES_MODULE_ID],
];

const CALENDAR_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: CALENDAR_MODULE_ID };

/**
 * Seeds the `invitations` database (incoming meeting invitations awaiting an answer) under the calendar
 * system project, in the caller's transaction. Everything is system-owned by the calendar module, so the
 * generic write path refuses it. The four relations are `many_to_many` and one-directional because their
 * targets are locked. No rows. Also creates the `calendar.ingestInvitation` and
 * `calendar.applyInvitationReply` heartbeats, both firing on every new Emails item.
 *
 * Not idempotent: `seedSystem` calls it once per new tenant, after Events, People, Emails and Mailboxes exist.
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
  await createProps(
    client,
    database.id,
    INVITATION_PROPERTIES.map((spec) => ({ ...spec, owner: "system", ownerProcess: CALENDAR_MODULE_ID })),
  );
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
