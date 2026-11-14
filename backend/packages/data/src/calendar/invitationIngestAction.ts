// The heartbeat action that turns the iMIP `REQUEST` of a new email into a pending invitation (issue gh-1929). Mail
// ingest writes nothing to the Invitations database: the calendar module reacts to the new Emails item instead, the way
// `mail.linkPeopleByEmail` does.
// Constrained by: docs/adr/2026-09-10-single-writer-ownership-model.md,
// docs/adr/2026-09-10-choke-point-api-for-state-writes.md
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { withClient, withTransaction } from "../db/pool.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { getMailMessageMetaByItemId } from "../mail/mailMessageMetaStore.js";
import type { ActionHandler } from "../scheduler/actions.js";
import type { CreateHeartbeatInput } from "../scheduler/schedulerStore.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { assertValidTimezone } from "../timezone.js";
import { CALENDAR_MODULE_ID } from "./calendarModuleId.js";
import { readCalendarPartsOfEmail } from "./emailCalendarParts.js";
import { parseICalendar, type ICalendarEvent } from "./icalendarParser.js";
import { logger } from "./logger.js";

export const CALENDAR_INGEST_INVITATION_ACTION_ID = "calendar.ingestInvitation";

/** The `action_config` of the heartbeat: the two databases the action reads and writes, resolved once at seed time. */
const configSchema = z.object({ emailsDatabaseId: z.uuid(), invitationsDatabaseId: z.uuid() });

/**
 * The ingest's heartbeat, shared by `seedInvitationsDatabaseInTransaction` (fresh install) and
 * `runInvitationIngestHeartbeatCutoverMigration` (populated upgrade) so both create the same one: an `onItemEvent`
 * create rule on the Emails database, owned by `projectItemId`, the system project of the Invitations database.
 */
export function invitationIngestHeartbeat(input: {
  projectItemId: string;
  emailsDatabaseId: string;
  invitationsDatabaseId: string;
}): CreateHeartbeatInput {
  return {
    projectItemId: input.projectItemId,
    name: "Ingest calendar invitations",
    rule: { kind: "onItemEvent", databaseId: input.emailsDatabaseId, event: "create" },
    actionId: CALENDAR_INGEST_INVITATION_ACTION_ID,
    actionConfig: { emailsDatabaseId: input.emailsDatabaseId, invitationsDatabaseId: input.invitationsDatabaseId },
  };
}

const CALENDAR_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: CALENDAR_MODULE_ID };

/** The invitation properties a parsed event fills, and so the keys the calendar module writes as the owner process. */
const PARSED_KEYS = [
  "title",
  "startsAt",
  "endsAt",
  "timeZone",
  "allDay",
  "place",
  "organizerName",
  "organizerEmail",
  "sequence",
] as const;
const CREATE_KEYS = [...PARSED_KEYS, "status", "kind", "uid"] as const;

/** The invitation properties of a parsed event, an absent value as `null`. */
function parsedFields(event: ICalendarEvent): Record<(typeof PARSED_KEYS)[number], unknown> {
  return {
    title: event.summary,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timeZone: event.timeZone,
    allDay: event.allDay,
    place: event.location,
    organizerName: event.organizer?.name ?? null,
    organizerEmail: event.organizer?.address ?? null,
    sequence: event.sequence,
  };
}

async function requireRelationPropertyId(client: PoolClient, databaseId: string, key: string): Promise<string> {
  const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
  if (!property) throw new Error(`The invitations database has no '${key}' relation`);
  return property.id;
}

/** The id of the live calendar marked `isDefault` (the lowest id of several), its row locked `FOR SHARE`; `null` when there is none. */
async function lockDefaultCalendarId(client: PoolClient): Promise<string | null> {
  const calendars = await databasesStore.getDatabaseByModuleId(client, CALENDARS_MODULE_ID);
  if (!calendars) return null;
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
      WHERE database_id = $1 AND deleted_at IS NULL AND properties->'isDefault' = 'true'::jsonb
      ORDER BY id LIMIT 1
      FOR SHARE`,
    [calendars.id],
  );
  return rows[0]?.id ?? null;
}

interface RequestContext {
  invitationsDatabaseId: string;
  emailItemId: string;
  mailboxItemId: string | null;
}

async function linkInvitation(
  client: PoolClient,
  context: RequestContext,
  invitationItemId: string,
  key: string,
  targetItemId: string,
): Promise<void> {
  await createRelationWithClient(
    client,
    {
      relationPropertyId: await requireRelationPropertyId(client, context.invitationsDatabaseId, key),
      callerItemId: invitationItemId,
      targetItemId,
    },
    CALENDAR_RELATION_CONTEXT,
  );
}

async function createInvitation(client: PoolClient, context: RequestContext, event: ICalendarEvent): Promise<void> {
  const properties = Object.fromEntries(
    Object.entries({ ...parsedFields(event), status: "pending", kind: "invite", uid: event.uid }).filter(
      ([, value]) => value !== null,
    ),
  );
  const invitation = await createItemWithClient(
    client,
    { databaseId: context.invitationsDatabaseId, properties },
    { allowedSystemKeys: CREATE_KEYS, systemOwnerProcess: CALENDAR_MODULE_ID },
  );
  await linkInvitation(client, context, invitation.id, "sourceEmail", context.emailItemId);
  if (context.mailboxItemId !== null) {
    await linkInvitation(client, context, invitation.id, "mailbox", context.mailboxItemId);
  }
  const calendarId = await lockDefaultCalendarId(client);
  if (calendarId === null) {
    logger.warn({ emailItemId: context.emailItemId, invitationItemId: invitation.id }, "default_calendar_missing");
  } else {
    await linkInvitation(client, context, invitation.id, "suggestedCalendar", calendarId);
  }
  logger.info({ emailItemId: context.emailItemId, invitationItemId: invitation.id }, "calendar invitation created");
}

async function updatePendingInvitation(
  client: PoolClient,
  context: RequestContext,
  invitationItemId: string,
  event: ICalendarEvent,
): Promise<void> {
  await updateItemWithClient(
    client,
    { databaseId: context.invitationsDatabaseId, itemId: invitationItemId, propertiesPatch: parsedFields(event) },
    { allowedSystemKeys: PARSED_KEYS, systemOwnerProcess: CALENDAR_MODULE_ID },
  );
  const propertyId = await requireRelationPropertyId(client, context.invitationsDatabaseId, "sourceEmail");
  const definition = await relationsStore.getRelationDefinitionByPropertyId(client, propertyId);
  if (!definition) throw new Error("The invitations 'sourceEmail' relation has no definition");
  for (const edge of await relationsStore.listRelationsForItem(client, definition.id, invitationItemId)) {
    await deleteRelationWithClient(
      client,
      {
        relationPropertyId: propertyId,
        callerItemId: invitationItemId,
        targetItemId: relationsStore.otherSide(edge, invitationItemId),
      },
      CALENDAR_RELATION_CONTEXT,
    );
  }
  await linkInvitation(client, context, invitationItemId, "sourceEmail", context.emailItemId);
  logger.info({ emailItemId: context.emailItemId, invitationItemId }, "calendar invitation updated");
}

/**
 * Applies one parsed `REQUEST` event inside the caller's transaction. The transaction-scoped advisory lock on the
 * tenant and `UID` comes first, so two deliveries of one `UID` cannot both find no invitation and both insert; the
 * invitation read after it is row-locked, so the update below acts on the row it read.
 *
 * - No invitation (trashed ones count) has the `UID`: creates a pending one.
 * - One exists, is live and `pending`, and has a lower `sequence`: updates its parsed fields and its `sourceEmail`.
 *   A stored `sequence` that is not a number reads as `0`.
 * - Otherwise (an equal or higher `sequence`, an answered invitation, a trashed one): changes nothing.
 */
async function applyRequest(client: PoolClient, context: RequestContext, event: ICalendarEvent): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('invitationUid:' || app_tenant_default()::text || ':' || $1::text, 0))",
    [event.uid],
  );
  const [existing] = await itemsStore.listItemsByTextProperty(
    client,
    context.invitationsDatabaseId,
    "uid",
    event.uid,
    true,
  );
  if (!existing) {
    await createInvitation(client, context, event);
    return;
  }
  const storedSequence = typeof existing.properties.sequence === "number" ? existing.properties.sequence : 0;
  if (existing.deletedAt === null && existing.properties.status === "pending" && storedSequence < event.sequence) {
    await updatePendingInvitation(client, context, existing.id, event);
  }
}

/**
 * Registered as the `onItemEvent` ('create') heartbeat action `calendar.ingestInvitation` on the Emails database: reads
 * the calendar parts of the new message and, for each iMIP `REQUEST` among them, creates a pending invitation or
 * updates the one of the same `UID`, as `applyRequest` describes. Of a part's events it takes the first that has no
 * `RECURRENCE-ID`; an `RRULE` is ignored. All writes go through the choke point as the calendar module's system owner
 * process, and the whole message is handled in one transaction.
 *
 * Nothing is written, and the action does not fail, for a message of kind `dsn`, one without a calendar part, a part
 * the parser rejects (over its limits or malformed), a calendar with another `METHOD` (`CANCEL`, `REPLY`, none) and a
 * message that is trashed or gone by the time the transaction locks it. A failure of the storage read or of a write
 * does fail the action, and so does a tenant time zone setting that is not an IANA zone. Logs carry the email and invitation ids and a reason code, never the invitation's content.
 *
 * The parts are read, and the tenant's time zone, before the transaction opens, so no transaction waits on storage.
 * Runs in the firing heartbeat's tenant.
 */
export function createInvitationIngestAction(
  pool: Pool,
  deps: { storage: Pick<BlobStorageWriter, "readStream"> },
): ActionHandler {
  return async (actionConfig, context) => {
    const emailItemId = context.itemId;
    if (!emailItemId) return;
    const config = configSchema.safeParse(actionConfig);
    if (!config.success) {
      throw new Error(`Malformed action config for ${CALENDAR_INGEST_INVITATION_ACTION_ID}: ${config.error.message}`);
    }

    const prepared = await withClient(pool, async (client) => {
      const meta = await getMailMessageMetaByItemId(client, emailItemId);
      if (!meta || meta.messageKind === "dsn") return null;
      const texts = await readCalendarPartsOfEmail(client, deps.storage, emailItemId);
      if (texts.length === 0) return null;
      const fallbackTimeZone = await getSystemTimezone(client);
      assertValidTimezone(fallbackTimeZone);
      return { mailboxItemId: meta.mailboxItemId, texts, fallbackTimeZone };
    });
    if (prepared === null) return;

    const requests: ICalendarEvent[] = [];
    for (const text of prepared.texts) {
      const parsed = parseICalendar(text, { fallbackTimeZone: prepared.fallbackTimeZone });
      if (!parsed.ok) {
        logger.warn({ emailItemId, reason: parsed.reason }, "calendar part rejected");
        continue;
      }
      if (parsed.method !== "REQUEST") continue;
      const event = parsed.events.find((candidate) => !candidate.hasRecurrenceId);
      if (!event) continue;
      if (event.timeZoneFallback) logger.warn({ emailItemId, reason: "unknown_tzid" }, "calendar time zone fell back");
      requests.push(event);
    }
    if (requests.length === 0) return;

    await withTransaction(pool, async (client) => {
      const email = await itemsStore.lockItemById(client, config.data.emailsDatabaseId, emailItemId);
      if (!email || email.deletedAt !== null) {
        logger.info({ emailItemId, reason: "email_gone" }, "calendar invitation skipped");
        return;
      }
      const requestContext: RequestContext = {
        invitationsDatabaseId: config.data.invitationsDatabaseId,
        emailItemId,
        mailboxItemId: prepared.mailboxItemId,
      };
      for (const event of requests) await applyRequest(client, requestContext, event);
    });
  };
}
