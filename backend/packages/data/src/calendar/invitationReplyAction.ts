// The heartbeat action that applies the iMIP `REPLY` of a new email to the invitation on a participant edge of an Event
// (issue gh-1950). Mail ingest writes nothing to calendar data: the calendar module reacts to the new Emails item
// instead, the way `calendar.ingestInvitation` does. The `invitation` object of an edge is the calendar module's to
// write, with the system writer kind.
// Constrained by: docs/adr/2026-09-10-single-writer-ownership-model.md,
// docs/adr/2026-09-10-choke-point-api-for-state-writes.md,
// docs/adr/2026-11-11-event-participant-invitations-are-written-by-system-writers.md
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { updateRelationWithClient } from "../chokePoint/relationOps.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { withClient, withTransaction } from "../db/pool.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { getMailMessageMetaByItemId } from "../mail/mailMessageMetaStore.js";
import { lookupPersonIdByEmail, normalizeEmailAddress } from "../mail/personEmailIndexStore.js";
import type { ActionHandler } from "../scheduler/actions.js";
import type { CreateHeartbeatInput } from "../scheduler/schedulerStore.js";
import { readCalendarPartsOfEmail } from "./emailCalendarParts.js";
import { EVENT_PEOPLE_PROPERTY_KEY, readEventParticipantMetadata } from "./eventParticipantEdgeHook.js";
import { parseICalendar } from "./icalendarParser.js";
import { logger } from "./logger.js";

export const CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID = "calendar.applyInvitationReply";

/** The `action_config` of the heartbeat: the three databases the action reads, resolved once at seed time. */
const configSchema = z.object({
  emailsDatabaseId: z.uuid(),
  eventsDatabaseId: z.uuid(),
  peopleDatabaseId: z.uuid(),
});

/**
 * The reply heartbeat, shared by `seedInvitationsDatabaseInTransaction` (fresh install) and
 * `runInvitationReplyHeartbeatCutoverMigration` (populated upgrade) so both create the same one: an `onItemEvent`
 * create rule on the Emails database, owned by `projectItemId`, the system project of the Invitations database.
 */
export function invitationReplyHeartbeat(input: {
  projectItemId: string;
  emailsDatabaseId: string;
  eventsDatabaseId: string;
  peopleDatabaseId: string;
}): CreateHeartbeatInput {
  return {
    projectItemId: input.projectItemId,
    name: "Apply calendar invitation replies",
    rule: { kind: "onItemEvent", databaseId: input.emailsDatabaseId, event: "create" },
    actionId: CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID,
    actionConfig: {
      emailsDatabaseId: input.emailsDatabaseId,
      eventsDatabaseId: input.eventsDatabaseId,
      peopleDatabaseId: input.peopleDatabaseId,
    },
  };
}

/** Logs that a reply, or part of one, was left unapplied: the email item id and a reason code, nothing of its content. */
function logIgnored(emailItemId: string, reason: string): void {
  logger.info({ emailItemId, reason }, "calendar invitation reply ignored");
}

type InvitationStatus = "accepted" | "tentative" | "declined";

/** The `PARTSTAT` values that change a status; `NEEDS-ACTION`, `DELEGATED` and every other value are ignored. */
const STATUS_OF_PARTSTAT: ReadonlyMap<string, InvitationStatus> = new Map([
  ["ACCEPTED", "accepted"],
  ["TENTATIVE", "tentative"],
  ["DECLINED", "declined"],
]);

/** One answer a message carries: the Event `UID`, the address that answered and what it answered. */
interface Reply {
  uid: string;
  attendeeAddress: string;
  status: InvitationStatus;
}

/**
 * The answers in the calendar parts `texts` of a message that may be applied: one per `ATTENDEE` of a `METHOD:REPLY`
 * event whose address is the message's sender and whose `PARTSTAT` is one of the three that change a status.
 * Everything else is logged with a reason code and left out. An event with a `RECURRENCE-ID` answers one occurrence of a series, which the
 * Event's single participant edge cannot record, so it is left out as well.
 */
function collectReplies(emailItemId: string, senderAddress: string | null, texts: readonly string[]): Reply[] {
  const replies: Reply[] = [];
  for (const text of texts) {
    // A reply reads no time, so the zone that floating times would be read in does not matter.
    const parsed = parseICalendar(text, { fallbackTimeZone: "UTC" });
    if (!parsed.ok) {
      logger.warn({ emailItemId, reason: parsed.reason }, "calendar part rejected");
      continue;
    }
    if (parsed.method !== "REPLY") continue;
    for (const event of parsed.events) {
      if (event.hasRecurrenceId) {
        logIgnored(emailItemId, "recurrence_instance");
        continue;
      }
      const fromSender = event.attendees.filter(
        (attendee) => senderAddress !== null && normalizeEmailAddress(attendee.address) === senderAddress,
      );
      if (fromSender.length === 0) logIgnored(emailItemId, "sender_mismatch");
      for (const attendee of fromSender) {
        const status = attendee.partStat === null ? undefined : STATUS_OF_PARTSTAT.get(attendee.partStat);
        if (status === undefined) logIgnored(emailItemId, "partstat_ignored");
        else replies.push({ uid: event.uid, attendeeAddress: attendee.address, status });
      }
    }
  }
  return replies;
}

interface ApplyContext {
  emailItemId: string;
  eventsDatabaseId: string;
  peopleDatabaseId: string;
  respondedAt: string;
}

/**
 * Applies one answer inside the caller's transaction. The Event row is locked first, as every participant edge write
 * does, then the person's row, so the edge read below is the edge the write replaces. Writes nothing, with the reason
 * code logged, when:
 *
 * - no live Event has the `UID` (`unknown_uid`), or more than one has (`ambiguous_uid`);
 * - no live person has the address (`unknown_attendee`);
 * - the person has no edge to the Event, or the edge has no invitation (`not_invited`);
 * - the invitation already has the status (`unchanged`), which keeps its `respondedAt` and makes a second run of the
 *   same message a no-op. The check compares the status only, so a later, different message that repeats the status
 *   keeps the first `respondedAt` too: `respondedAt` is the time the current status was first recorded, and only a
 *   change of status moves it.
 *
 * Otherwise the edge's metadata is replaced with itself, the invitation changed only in `status` and `respondedAt`.
 */
async function applyReply(client: PoolClient, context: ApplyContext, reply: Reply): Promise<void> {
  const ignore = (reason: string): void => logIgnored(context.emailItemId, reason);
  const events = (
    await itemsStore.listItemsByTextProperty(client, context.eventsDatabaseId, "icalUid", reply.uid, true)
  ).filter((candidate) => candidate.deletedAt === null);
  const [event, ...others] = events;
  if (event === undefined) {
    ignore("unknown_uid");
    return;
  }
  if (others.length > 0) {
    ignore("ambiguous_uid");
    return;
  }

  const personId = await lookupPersonIdByEmail(client, reply.attendeeAddress);
  const person = personId === null ? null : await itemsStore.lockItemById(client, context.peopleDatabaseId, personId);
  if (person === null || person.deletedAt !== null) {
    ignore("unknown_attendee");
    return;
  }

  const property = await getPropertyByKey(client, context.eventsDatabaseId, EVENT_PEOPLE_PROPERTY_KEY);
  const definition = property === null ? null : await getRelationDefinitionByPropertyId(client, property.id);
  if (property === null || definition === null) throw new Error("The Events database has no 'people' relation");
  const edge = (await listRelationsForItem(client, definition.id, event.id)).find(
    (candidate) => otherSide(candidate, event.id) === person.id,
  );
  const invitation = edge === undefined ? null : readEventParticipantMetadata(edge.metadata).invitation;
  if (edge === undefined || invitation === null) {
    ignore("not_invited");
    return;
  }
  if (invitation.status === reply.status) {
    ignore("unchanged");
    return;
  }

  await updateRelationWithClient(
    client,
    {
      relationPropertyId: property.id,
      callerItemId: event.id,
      targetItemId: person.id,
      metadata: {
        ...edge.metadata,
        invitation: { ...invitation, status: reply.status, respondedAt: context.respondedAt },
      },
    },
    undefined,
    SYSTEM_WRITER,
  );
  logger.info({ emailItemId: context.emailItemId }, "calendar invitation reply applied");
}

/**
 * Registered as the `onItemEvent` ('create') heartbeat action `calendar.applyInvitationReply` on the Emails database:
 * reads the calendar parts of the new message and, for each `METHOD:REPLY` event among them, sets `status` and
 * `respondedAt` of the invitation on the participant edge of the answering person, as `applyReply` describes.
 *
 * A reply is applied only when the `ATTENDEE` address and the message's own sender (`envelope.from`) are the same
 * address in any letter case, the address belongs to a person who has an edge with an invitation to the Event with the
 * `UID`, and the `PARTSTAT` is `ACCEPTED`, `TENTATIVE` or `DECLINED` (stored as `accepted`, `tentative`, `declined`).
 * The `SEQUENCE` is not compared, so the latest reply processed wins; a reply that repeats the stored status leaves
 * the invitation, `respondedAt` included, as it is. Delivery authenticity (SPF, DKIM) is not
 * checked. The edge is written with the system writer kind through the choke point's relation write, in one transaction
 * per message that also holds the Emails row lock.
 *
 * Nothing is written, and the action does not fail, for a message of kind `dsn`, one without a calendar part, a part
 * the parser rejects, a calendar with another `METHOD`, a message that is trashed or gone by the time the transaction
 * locks it, and every case `applyReply` and `collectReplies` list. A failure of the storage read or of a write does
 * fail the action. Logs carry the email item id and a reason code only, never calendar content or addresses.
 *
 * The parts are read before the transaction opens, so no transaction waits on storage. Runs in the firing heartbeat's
 * tenant, so every read and write is confined to its rows.
 */
export function createInvitationReplyAction(
  pool: Pool,
  deps: { storage: Pick<BlobStorageWriter, "readStream"> },
): ActionHandler {
  return async (actionConfig, context) => {
    const emailItemId = context.itemId;
    if (!emailItemId) return;
    const config = configSchema.safeParse(actionConfig);
    if (!config.success) {
      throw new Error(
        `Malformed action config for ${CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID}: ${config.error.message}`,
      );
    }

    const replies = await withClient(pool, async (client) => {
      const meta = await getMailMessageMetaByItemId(client, emailItemId);
      if (!meta || meta.messageKind === "dsn") return [];
      const texts = await readCalendarPartsOfEmail(client, deps.storage, emailItemId);
      const from = meta.envelope.from?.address;
      return collectReplies(emailItemId, from === undefined ? null : normalizeEmailAddress(from), texts);
    });
    if (replies.length === 0) return;

    await withTransaction(pool, async (client) => {
      const email = await itemsStore.lockItemById(client, config.data.emailsDatabaseId, emailItemId);
      if (!email || email.deletedAt !== null) {
        logIgnored(emailItemId, "email_gone");
        return;
      }
      const applyContext: ApplyContext = {
        emailItemId,
        eventsDatabaseId: config.data.eventsDatabaseId,
        peopleDatabaseId: config.data.peopleDatabaseId,
        respondedAt: new Date().toISOString(),
      };
      for (const reply of replies) await applyReply(client, applyContext, reply);
    });
  };
}
