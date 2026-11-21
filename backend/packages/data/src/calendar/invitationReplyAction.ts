// Applies the iMIP `REPLY` of a new email to the invitation on an Event's participant edge. The edge's
// `invitation` object is the calendar module's to write, with the system writer kind.
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

import { CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID } from "./invitationActionKeys.js";

export { CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID } from "./invitationActionKeys.js";

/** The database ids are resolved once at seed time. */
const configSchema = z.object({
  emailsDatabaseId: z.uuid(),
  eventsDatabaseId: z.uuid(),
  peopleDatabaseId: z.uuid(),
});

/** `projectItemId` is the system project of the Invitations database. */
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

/** Logs nothing of the reply's content. */
function logIgnored(emailItemId: string, reason: string): void {
  logger.info({ emailItemId, reason }, "calendar invitation reply ignored");
}

type InvitationStatus = "accepted" | "tentative" | "declined";

/** Every other `PARTSTAT` (`NEEDS-ACTION`, `DELEGATED`, ...) is ignored. */
const STATUS_OF_PARTSTAT: ReadonlyMap<string, InvitationStatus> = new Map([
  ["ACCEPTED", "accepted"],
  ["TENTATIVE", "tentative"],
  ["DECLINED", "declined"],
]);

interface Reply {
  uid: string;
  attendeeAddress: string;
  status: InvitationStatus;
}

/**
 * Only `ATTENDEE`s whose address is the message's sender count. An event with a `RECURRENCE-ID` answers one
 * occurrence, which the Event's single participant edge cannot record, so it is skipped.
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
 * The Event row is locked first, as every participant edge write does, then the person's row, so the edge read
 * below is the edge the write replaces. An unchanged status is skipped, so `respondedAt` is when the current status
 * was first recorded and a rerun of the same message is a no-op.
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
 * `SEQUENCE` is not compared, so the latest reply processed wins. Delivery authenticity (SPF, DKIM) is not checked.
 * One transaction per message, holding the Emails row lock; the parts are read before it opens, so no transaction
 * waits on storage. Logs never carry calendar content or addresses.
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
