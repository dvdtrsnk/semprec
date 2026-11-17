// Turns the iMIP `REQUEST`/`CANCEL` of a new email into invitation writes. Mail ingest writes nothing to the
// Invitations database: the calendar module reacts to the new Emails item instead, as `mail.linkPeopleByEmail` does.
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getTenantUserId } from "../auth/usersStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { withClient, withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { getMailMessageMetaByItemId } from "../mail/mailMessageMetaStore.js";
import { normalizeEmailAddress } from "../mail/personEmailIndexStore.js";
import { resolveNotificationsBySource } from "../notifications/notificationsStore.js";
import { writeNotification } from "../notifications/notify.js";
import { createActionQueueAffinity, type ActionHandler } from "../scheduler/actions.js";
import type { CreateHeartbeatInput } from "../scheduler/schedulerStore.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { assertValidTimezone } from "../timezone.js";
import type { ItemRow } from "../types.js";
import { CALENDAR_MODULE_ID } from "./calendarModuleId.js";
import { readCalendarPartsOfEmail } from "./emailCalendarParts.js";
import { deriveEventTimeProperties } from "./eventTime.js";
import { parseICalendar, type ICalendarEvent } from "./icalendarParser.js";
import { invitationEventFields } from "./invitationEventFields.js";
import { logger } from "./logger.js";

export const CALENDAR_INGEST_INVITATION_ACTION_ID = "calendar.ingestInvitation";

/** Both database ids are resolved once at seed time. */
const configSchema = z.object({ emailsDatabaseId: z.uuid(), invitationsDatabaseId: z.uuid() });

/** `projectItemId` is the system project of the Invitations database. */
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

/** The keys the calendar module writes as the owner process. */
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
const CANCEL_KEYS = ["status", "sequence"] as const;

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

/** Locked `FOR SHARE`; the lowest id wins when several calendars are marked default. */
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

interface MessageContext {
  invitationsDatabaseId: string;
  emailItemId: string;
  mailboxItemId: string | null;
  /** `envelope.from`, normalized. */
  senderAddress: string | null;
  timeZone: string;
}

async function linkInvitation(
  client: PoolClient,
  context: MessageContext,
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

const NOTIFICATION_TITLE_MAX_CHARACTERS = 120;

/**
 * Runs in the caller's transaction, so the notification commits or rolls back with the invitation. `link_href` is
 * `null`: the app opens the invitation from `payload.invitationId`.
 */
async function notifyNewInvitation(
  client: PoolClient,
  emailItemId: string,
  invitationItemId: string,
  event: ICalendarEvent,
): Promise<void> {
  const userId = await getTenantUserId(client);
  if (userId === null) {
    logger.warn({ emailItemId, invitationItemId, reason: "no_tenant_user" }, "calendar invitation not notified");
    return;
  }
  await writeNotification(client, {
    userId,
    kind: "calendar_invitation",
    titleParams: {
      organizer: event.organizer?.name ?? event.organizer?.address ?? "",
      title: Array.from(event.summary ?? "")
        .slice(0, NOTIFICATION_TITLE_MAX_CHARACTERS)
        .join(""),
    },
    linkHref: null,
    sourceTable: "items",
    sourceId: invitationItemId,
    transitionInstance: "created",
    payload: { invitationId: invitationItemId },
  });
}

async function createInvitation(client: PoolClient, context: MessageContext, event: ICalendarEvent): Promise<void> {
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
  await notifyNewInvitation(client, context.emailItemId, invitation.id, event);
  logger.info({ emailItemId: context.emailItemId, invitationItemId: invitation.id }, "calendar invitation created");
}

/** Organizer-only changes (a cancellation, an update of an answered invitation) require this. */
function isFromOrganizer(context: MessageContext, invitation: ItemRow): boolean {
  const { organizerEmail } = invitation.properties;
  return (
    context.senderAddress !== null &&
    typeof organizerEmail === "string" &&
    normalizeEmailAddress(organizerEmail) === context.senderAddress
  );
}

function storedSequenceOf(invitation: ItemRow): number {
  return typeof invitation.properties.sequence === "number" ? invitation.properties.sequence : 0;
}

async function updateInvitationFromRequest(
  client: PoolClient,
  context: MessageContext,
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

/** Locks the linked Event `FOR UPDATE`, trashed or live. Reads the first edge, as the respond route does. */
async function lockLinkedEvent(
  client: PoolClient,
  invitationsDatabaseId: string,
  invitationItemId: string,
): Promise<ItemRow | null> {
  const propertyId = await requireRelationPropertyId(client, invitationsDatabaseId, "event");
  const definition = await relationsStore.getRelationDefinitionByPropertyId(client, propertyId);
  if (!definition) throw new Error("The invitations 'event' relation has no definition");
  const [edge] = await relationsStore.listRelationsForItem(client, definition.id, invitationItemId);
  if (!edge) return null;
  const events = await databasesStore.getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  if (!events) throw new Error("The tenant has no Events database");
  return itemsStore.lockItemById(client, events.id, relationsStore.otherSide(edge, invitationItemId));
}

/**
 * A field is adopted only while the Event still holds what the previous invitation fields produced (as stored by
 * the Events time rules), so a field the user changed is never overwritten. The title is never cleared: the system
 * writer is not held to the non-blank title rule a user write is, and an Event must keep a title.
 */
function eventPatchOfUpdate(
  invitation: ItemRow,
  event: ICalendarEvent,
  linked: ItemRow,
  timeZone: string,
): Record<string, unknown> {
  const asStored = (properties: Record<string, unknown>) =>
    deriveEventTimeProperties(null, invitationEventFields({ id: invitation.id, properties }, timeZone), timeZone);
  const previous = asStored(invitation.properties);
  const next = asStored(parsedFields(event));
  const patch: Record<string, unknown> = {};
  // `time` is derived from the start and the end, which the Events write recomputes when the patch names one of them.
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (key === "time") continue;
    if (key === "name" && (typeof next.name !== "string" || next.name.trim() === "")) continue;
    const previousValue = previous[key] ?? null;
    const nextValue = next[key] ?? null;
    if (nextValue !== previousValue && (linked.properties[key] ?? null) === previousValue) patch[key] = nextValue;
  }
  return patch;
}

/**
 * The invitation keeps `status` and `respondedAt`; a trashed or missing Event is not touched. A refused Event
 * write is rethrown so the whole message's transaction rolls back. The caller has checked `isFromOrganizer`.
 */
async function updateAnsweredInvitation(
  client: PoolClient,
  context: MessageContext,
  invitation: ItemRow,
  event: ICalendarEvent,
): Promise<void> {
  const linked = await lockLinkedEvent(client, context.invitationsDatabaseId, invitation.id);
  const patch =
    linked !== null && linked.deletedAt === null
      ? eventPatchOfUpdate(invitation, event, linked, context.timeZone)
      : null;
  await updateInvitationFromRequest(client, context, invitation.id, event);
  if (linked === null || patch === null || Object.keys(patch).length === 0) return;
  try {
    await updateItemWithClient(client, {
      databaseId: linked.databaseId,
      itemId: linked.id,
      propertiesPatch: patch,
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      logger.warn(
        { emailItemId: context.emailItemId, invitationItemId: invitation.id, reason: "event_validation_failed" },
        "calendar invitation update refused",
      );
    }
    throw error;
  }
}

/** The advisory lock serializes deliveries of one `UID`; trashed invitations count. */
async function lockInvitationOfUid(client: PoolClient, context: MessageContext, uid: string): Promise<ItemRow | null> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('invitationUid:' || app_tenant_default()::text || ':' || $1::text, 0))",
    [uid],
  );
  const [existing] = await itemsStore.listItemsByTextProperty(client, context.invitationsDatabaseId, "uid", uid, true);
  return existing ?? null;
}

/**
 * The advisory lock comes first so two deliveries of one `UID` cannot both find no invitation and both insert.
 * Only the create branch notifies, so the user is notified once.
 */
async function applyRequest(client: PoolClient, context: MessageContext, event: ICalendarEvent): Promise<void> {
  const existing = await lockInvitationOfUid(client, context, event.uid);
  if (!existing) {
    await createInvitation(client, context, event);
    return;
  }
  if (existing.deletedAt !== null || storedSequenceOf(existing) >= event.sequence) return;
  const { status } = existing.properties;
  if (status === "pending") {
    await updateInvitationFromRequest(client, context, existing.id, event);
  } else if (status === "accepted" || status === "tentative" || status === "declined") {
    // An answered invitation's Event is the user's own: only the stored organizer may move it.
    if (!isFromOrganizer(context, existing)) {
      logger.warn(
        { emailItemId: context.emailItemId, invitationItemId: existing.id, reason: "sender_not_organizer" },
        "calendar invitation update ignored",
      );
      return;
    }
    await updateAnsweredInvitation(client, context, existing, event);
  }
}

/** The linked Event is trashed, not deleted, so the user can restore it. */
async function applyCancel(client: PoolClient, context: MessageContext, event: ICalendarEvent): Promise<void> {
  const invitation = await lockInvitationOfUid(client, context, event.uid);
  if (!invitation || invitation.deletedAt !== null) return;
  const ignore = (reason: string) =>
    logger.warn(
      { emailItemId: context.emailItemId, invitationItemId: invitation.id, reason },
      "calendar cancellation ignored",
    );
  if (!isFromOrganizer(context, invitation)) return ignore("sender_not_organizer");
  if (event.sequence < storedSequenceOf(invitation)) return ignore("stale_sequence");
  if (invitation.properties.status === "cancelled") return;

  const linked = await lockLinkedEvent(client, context.invitationsDatabaseId, invitation.id);
  if (linked !== null && linked.deletedAt === null) {
    await itemDeleteWithClient(client, linked.databaseId, linked.id, { queueAffinity: createActionQueueAffinity() });
  }
  await updateItemWithClient(
    client,
    {
      databaseId: context.invitationsDatabaseId,
      itemId: invitation.id,
      propertiesPatch: { status: "cancelled", sequence: event.sequence },
    },
    { allowedSystemKeys: CANCEL_KEYS, systemOwnerProcess: CALENDAR_MODULE_ID },
  );
  await resolveNotificationsBySource(client, { sourceTable: "items", sourceId: invitation.id });
  logger.info({ emailItemId: context.emailItemId, invitationItemId: invitation.id }, "calendar invitation cancelled");
}

/**
 * Of a part's events only the first without a `RECURRENCE-ID` is used; an `RRULE` is ignored. The whole message is
 * handled in one transaction. Unusable input is skipped without failing; storage and write failures fail the action.
 * Logs never carry the invitation's content. The parts are read before the transaction opens, so no transaction
 * waits on storage.
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
      const sender = normalizeEmailAddress(meta.envelope.from?.address ?? "");
      return {
        mailboxItemId: meta.mailboxItemId,
        senderAddress: sender === "" ? null : sender,
        texts,
        fallbackTimeZone,
      };
    });
    if (prepared === null) return;

    const instructions: Array<{ method: "REQUEST" | "CANCEL"; event: ICalendarEvent }> = [];
    for (const text of prepared.texts) {
      const parsed = parseICalendar(text, { fallbackTimeZone: prepared.fallbackTimeZone });
      if (!parsed.ok) {
        logger.warn({ emailItemId, reason: parsed.reason }, "calendar part rejected");
        continue;
      }
      if (parsed.method !== "REQUEST" && parsed.method !== "CANCEL") continue;
      const event = parsed.events.find((candidate) => !candidate.hasRecurrenceId);
      if (!event) continue;
      if (event.timeZoneFallback) logger.warn({ emailItemId, reason: "unknown_tzid" }, "calendar time zone fell back");
      instructions.push({ method: parsed.method, event });
    }
    if (instructions.length === 0) return;

    await withTransaction(pool, async (client) => {
      const email = await itemsStore.lockItemById(client, config.data.emailsDatabaseId, emailItemId);
      if (!email || email.deletedAt !== null) {
        logger.info({ emailItemId, reason: "email_gone" }, "calendar invitation skipped");
        return;
      }
      const messageContext: MessageContext = {
        invitationsDatabaseId: config.data.invitationsDatabaseId,
        emailItemId,
        mailboxItemId: prepared.mailboxItemId,
        senderAddress: prepared.senderAddress,
        timeZone: prepared.fallbackTimeZone,
      };
      for (const { method, event } of instructions) {
        if (method === "REQUEST") await applyRequest(client, messageContext, event);
        else await applyCancel(client, messageContext, event);
      }
    });
  };
}
