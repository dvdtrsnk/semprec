// The invitations of an internet account with Calendars on come from its synced calendars, not from iMIP mail: a
// synced Event in which one of the account's addresses is an attendee still to answer (NEEDS-ACTION) and someone else
// is the organizer gets an Invitations row linked to it, and the provider's deletion of the Event cancels it. Runs in
// the sync's apply transaction, after its Event writes.
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { lockItemById } from "../../chokePoint/itemsStore.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { getPropertyByKey } from "../../chokePoint/propertiesStore.js";
import type { SystemRelationWriteContext } from "../../chokePoint/relationEdgeContext.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../../chokePoint/relationsStore.js";
import { wallClockToInstant } from "../../calendarTime.js";
import { parseAddressListProperty } from "../../mail/addressListParsing.js";
import { getMailServerSettings } from "../../mail/mailServerSettingsStore.js";
import { normalizeEmailAddress } from "../../mail/personEmailIndexStore.js";
import { resolveNotificationsBySource } from "../../notifications/notificationsStore.js";
import { INVITATIONS_MODULE_ID } from "../../seed/invitationsKeys.js";
import { getSystemTimezone } from "../../systemSettings.js";
import { assertValidTimezone } from "../../timezone.js";
import type { ItemRow } from "../../types.js";
import { CALENDAR_MODULE_ID } from "../calendarModuleId.js";
import { lockInvitationOfUid, notifyInvitation } from "../invitationRows.js";
import { logger } from "../logger.js";
import type { RemoteEvent } from "./adapter.js";

const CALENDAR_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: CALENDAR_MODULE_ID };

/** The keys this module writes from the provider's Event; the ingest of an iMIP request writes the same ones. */
const FIELD_KEYS = [
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
const CREATE_KEYS = [...FIELD_KEYS, "status", "kind", "uid"] as const;
const UPDATE_KEYS = [...FIELD_KEYS, "status", "respondedAt"] as const;

/** The account's own attendance, as the providers' values map onto it; any other value is no invitation. */
type SelfStatus = "needsAction" | "accepted" | "tentative" | "declined";

const SELF_STATUSES: ReadonlyMap<string, SelfStatus> = new Map([
  // CalDAV `PARTSTAT`, Google `responseStatus`, Graph `responseStatus.response`, lower-cased.
  ["needs-action", "needsAction"],
  ["needsaction", "needsAction"],
  ["notresponded", "needsAction"],
  ["accepted", "accepted"],
  ["tentative", "tentative"],
  ["tentativelyaccepted", "tentative"],
  ["declined", "declined"],
]);

/** An Event the apply wrote, or whose provider snapshot changed, in this pass. */
export interface RestatedEvent {
  eventItemId: string;
  calendarItemId: string;
  event: RemoteEvent;
}

/**
 * The account's addresses: every line of `Mailboxes.addresses` and a password account's login name when it is an
 * address, normalized.
 */
export async function accountOwnAddresses(
  client: PoolClient,
  accountItemId: string,
  properties: Record<string, unknown>,
): Promise<string[]> {
  const addresses = parseAddressListProperty(properties.addresses);
  const username = (await getMailServerSettings(client, accountItemId))?.username;
  if (username !== undefined && username.includes("@")) addresses.push(username);
  return [...new Set(addresses.map(normalizeEmailAddress))];
}

/**
 * The provider's own report first (Google `self`, Graph `responseStatus`), else the attendee with one of the
 * account's addresses; an attendee without a status is NEEDS-ACTION, the iCalendar default. `null`: the account is
 * no attendee, or its status is none of the four (`DELEGATED`, Graph `none` or `organizer`).
 */
function selfStatusOf(event: RemoteEvent, ownAddresses: ReadonlySet<string>): SelfStatus | null {
  const reported = event.selfStatus ?? null;
  if (reported !== null) return SELF_STATUSES.get(reported.toLowerCase()) ?? null;
  const own = event.attendees.find(
    (attendee) => attendee.email !== null && ownAddresses.has(normalizeEmailAddress(attendee.email)),
  );
  if (own === undefined) return null;
  return own.status === null ? "needsAction" : (SELF_STATUSES.get(own.status.toLowerCase()) ?? null);
}

/** The invitation an Event stands for: a master or single Event with someone else as its organizer. */
function invitationOf(event: RemoteEvent, ownAddresses: ReadonlySet<string>): SelfStatus | null {
  if (event.seriesRemoteId !== null) return null;
  const organizer = event.organizer?.email ?? null;
  if (organizer === null || ownAddresses.has(normalizeEmailAddress(organizer))) return null;
  return selfStatusOf(event, ownAddresses);
}

/**
 * The Invitations properties of the Event, as the ingest of an iMIP request stores them: instants in UTC, an all-day
 * day as its midnight UTC and `endsAt` its last day (none for one day). The apply has validated the times.
 */
type InvitationFields = Record<Exclude<(typeof FIELD_KEYS)[number], "allDay" | "sequence">, string | null> & {
  allDay: boolean;
  sequence: number;
};

function invitationFields(event: RemoteEvent, tenantZone: string): InvitationFields {
  const { fields } = event;
  const zone = fields.timeZone ?? tenantZone;
  const allDay = fields.timeFrom === null;
  const lastDay = fields.endDate ?? fields.date;
  let startsAt: string | null;
  let endsAt: string | null;
  if (fields.timeFrom === null) {
    startsAt = `${fields.date}T00:00:00.000Z`;
    endsAt = lastDay === fields.date ? null : `${lastDay}T00:00:00.000Z`;
  } else {
    startsAt = wallClockToInstant(fields.date, fields.timeFrom, zone).toUTC().toISO();
    endsAt = fields.timeTo === null ? null : wallClockToInstant(lastDay, fields.timeTo, zone).toUTC().toISO();
  }
  return {
    title: fields.name,
    startsAt,
    endsAt,
    timeZone: zone,
    allDay,
    place: fields.place,
    organizerName: event.organizer?.name ?? null,
    organizerEmail: event.organizer?.email ?? null,
    sequence: event.sequence ?? 0,
  };
}

function sequenceOf(invitation: ItemRow): number {
  return typeof invitation.properties.sequence === "number" ? invitation.properties.sequence : 0;
}

interface InvitationsContext {
  databaseId: string;
  tenantZone: string;
  relationPropertyIds: Map<string, string>;
}

async function relationPropertyId(client: PoolClient, context: InvitationsContext, key: string): Promise<string> {
  const known = context.relationPropertyIds.get(key);
  if (known !== undefined) return known;
  const property = await getPropertyByKey(client, context.databaseId, key);
  if (!property) throw new Error(`The invitations database has no '${key}' relation`);
  context.relationPropertyIds.set(key, property.id);
  return property.id;
}

/** The ids on the other side of `key` edges of `itemId`, trashed ones included. */
async function relatedIds(
  client: PoolClient,
  context: InvitationsContext,
  key: string,
  itemId: string,
): Promise<string[]> {
  const definition = await getRelationDefinitionByPropertyId(client, await relationPropertyId(client, context, key));
  if (!definition) throw new Error(`The invitations '${key}' relation has no definition`);
  return (await listRelationsForItem(client, definition.id, itemId)).map((edge) => otherSide(edge, itemId));
}

async function link(
  client: PoolClient,
  context: InvitationsContext,
  invitationItemId: string,
  key: string,
  targetItemId: string,
): Promise<void> {
  await createRelationWithClient(
    client,
    {
      relationPropertyId: await relationPropertyId(client, context, key),
      callerItemId: invitationItemId,
      targetItemId,
    },
    CALENDAR_RELATION_CONTEXT,
  );
}

/** The live invitation linked to the Event, locked; the lowest id when several are. */
async function lockLinkedInvitation(
  client: PoolClient,
  context: InvitationsContext,
  eventItemId: string,
): Promise<ItemRow | null> {
  for (const id of (await relatedIds(client, context, "event", eventItemId)).sort()) {
    const invitation = await lockItemById(client, context.databaseId, id);
    if (invitation !== null && invitation.deletedAt === null) return invitation;
  }
  return null;
}

async function writeInvitation(
  client: PoolClient,
  context: InvitationsContext,
  invitationItemId: string,
  propertiesPatch: Record<string, unknown>,
): Promise<void> {
  await updateItemWithClient(
    client,
    { databaseId: context.databaseId, itemId: invitationItemId, propertiesPatch },
    { allowedSystemKeys: UPDATE_KEYS, systemOwnerProcess: CALENDAR_MODULE_ID },
  );
}

/** The fields that differ from what the invitation holds. */
function changedFields(invitation: ItemRow, fields: InvitationFields): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => (invitation.properties[key] ?? null) !== value),
  );
}

/**
 * Finds or creates the invitation of the Event. An invitation of the same `UID` without a linked Event (one an
 * e-mail delivered before) is adopted; one linked to another Event, or trashed, is left alone and nothing is
 * created, so one meeting keeps one invitation. Returns the invitation and whether it was created here.
 */
async function invitationForEvent(
  client: PoolClient,
  context: InvitationsContext,
  accountItemId: string,
  restated: RestatedEvent,
  status: SelfStatus,
  notify: boolean,
): Promise<{ invitation: ItemRow; created: boolean } | null> {
  const { event, eventItemId } = restated;
  const linked = await lockLinkedInvitation(client, context, eventItemId);
  if (linked !== null) return { invitation: linked, created: false };
  const uid = event.icalUid ?? event.remoteId;
  const existing = await lockInvitationOfUid(client, context.databaseId, uid);
  if (existing !== null) {
    if (existing.deletedAt !== null || (await relatedIds(client, context, "event", existing.id)).length > 0) {
      logger.info({ eventItemId, invitationItemId: existing.id }, "Synced invitation left to its existing row");
      return null;
    }
    await link(client, context, existing.id, "event", eventItemId);
    return { invitation: existing, created: false };
  }
  // An answered meeting new to this account is no invitation to answer.
  if (status !== "needsAction") return null;
  const fields = invitationFields(event, context.tenantZone);
  const properties = Object.fromEntries(
    Object.entries({ ...fields, status: "pending", kind: "invite", uid }).filter(([, value]) => value !== null),
  );
  const invitation = await createItemWithClient(
    client,
    { databaseId: context.databaseId, properties },
    { allowedSystemKeys: CREATE_KEYS, systemOwnerProcess: CALENDAR_MODULE_ID },
  );
  await link(client, context, invitation.id, "event", eventItemId);
  await link(client, context, invitation.id, "mailbox", accountItemId);
  await link(client, context, invitation.id, "suggestedCalendar", restated.calendarItemId);
  if (notify) await notifyOf(client, eventItemId, invitation.id, fields);
  logger.info({ eventItemId, invitationItemId: invitation.id }, "Synced invitation created");
  return { invitation, created: true };
}

/** One notification per invitation and `SEQUENCE`. */
async function notifyOf(
  client: PoolClient,
  eventItemId: string,
  invitationItemId: string,
  fields: InvitationFields,
): Promise<void> {
  await notifyInvitation(client, {
    logIds: { eventItemId },
    invitationItemId,
    organizerName: fields.organizerName,
    organizerEmail: fields.organizerEmail,
    title: fields.title,
    transitionInstance: `sequence:${fields.sequence}`,
  });
}

/**
 * Brings an existing invitation to the provider's version. Its fields follow the Event. NEEDS-ACTION at a higher
 * `SEQUENCE` (the organizer changed the meeting and the provider asks again) makes an answered or cancelled
 * invitation pending again and notifies it; a pending invitation the account answered at the provider takes that
 * answer. An invitation answered here that the provider still shows unanswered keeps its answer, which its job is
 * sending. Returns whether it was notified.
 */
async function updateInvitation(
  client: PoolClient,
  context: InvitationsContext,
  invitation: ItemRow,
  { event, eventItemId }: RestatedEvent,
  status: SelfStatus,
  notify: boolean,
): Promise<boolean> {
  const fields = invitationFields(event, context.tenantZone);
  const patch = changedFields(invitation, fields);
  const current = invitation.properties.status;
  const asked = status === "needsAction" && fields.sequence > sequenceOf(invitation);
  if (asked && current !== "pending") {
    patch.status = "pending";
    patch.respondedAt = null;
  } else if (current === "pending" && status !== "needsAction") {
    patch.status = status;
    patch.respondedAt = new Date().toISOString();
  }
  if (Object.keys(patch).length === 0) return false;
  await writeInvitation(client, context, invitation.id, patch);
  if (patch.status !== undefined && patch.status !== "pending") {
    await resolveNotificationsBySource(client, { sourceTable: "items", sourceId: invitation.id });
  }
  if (!asked || !notify) return false;
  await notifyOf(client, eventItemId, invitation.id, fields);
  return true;
}

/**
 * Runs in the apply's transaction after its Event writes, which hold the Events' rows; each invitation is then
 * locked (after the `UID`'s advisory lock when it may be created). Nothing is notified in the account's initial
 * sync, whose Events are not news. Returns the Events whose invitation was notified.
 */
export async function reconcileSyncedInvitations(
  client: PoolClient,
  input: {
    accountItemId: string;
    ownAddresses: readonly string[];
    initialSync: boolean;
    events: readonly RestatedEvent[];
    cancelledEventItemIds: readonly string[];
  },
): Promise<Set<string>> {
  const notified = new Set<string>();
  const own = new Set(input.ownAddresses);
  const invited = input.events.flatMap((restated) => {
    const status = invitationOf(restated.event, own);
    return status === null ? [] : [{ restated, status }];
  });
  if (invited.length === 0 && input.cancelledEventItemIds.length === 0) return notified;
  const invitations = await getDatabaseByModuleId(client, INVITATIONS_MODULE_ID);
  if (!invitations) throw new Error("The tenant has no Invitations database");
  const tenantZone = await getSystemTimezone(client);
  assertValidTimezone(tenantZone);
  const context: InvitationsContext = { databaseId: invitations.id, tenantZone, relationPropertyIds: new Map() };
  const notify = !input.initialSync;

  for (const { restated, status } of invited) {
    const found = await invitationForEvent(client, context, input.accountItemId, restated, status, notify);
    if (found === null) continue;
    if (found.created) {
      if (notify) notified.add(restated.eventItemId);
      continue;
    }
    if (await updateInvitation(client, context, found.invitation, restated, status, notify)) {
      notified.add(restated.eventItemId);
    }
  }

  for (const eventItemId of input.cancelledEventItemIds) {
    const invitation = await lockLinkedInvitation(client, context, eventItemId);
    // A declined meeting may leave the account's calendar (Graph removes it): that is the answer, not a cancellation.
    if (invitation === null || !["pending", "accepted", "tentative"].includes(String(invitation.properties.status))) {
      continue;
    }
    await writeInvitation(client, context, invitation.id, { status: "cancelled" });
    await resolveNotificationsBySource(client, { sourceTable: "items", sourceId: invitation.id });
    logger.info({ eventItemId, invitationItemId: invitation.id }, "Synced invitation cancelled");
  }
  return notified;
}
