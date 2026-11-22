// Sends the iMIP `METHOD:REPLY` to the organizer from the mailbox that received the invitation. The respond route
// queues it in the answer's own transaction, so a rolled-back answer sends nothing.
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { enqueueJob } from "@semprec/queue";
import { resolveCatalogLabel } from "@semprec/module-registry";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { parseAddressListProperty } from "../mail/addressListParsing.js";
import {
  defaultSyncModeForProvider,
  getMailAccountSyncState,
  type SyncMode,
} from "../mail/mailAccountSyncStateStore.js";
import { getMailMessageMetaByItemId } from "../mail/mailMessageMetaStore.js";
import type { MailTransport, MailTransportFactory, MailTransportResult } from "../mail/mailTransport.js";
import { recordPendingSentCopyAfterSend } from "../mail/mailSentCopies.js";
import { buildOutgoingMime, generateOutgoingMessageId } from "../mail/outgoingMime.js";
import { MailRecipientRejectedError, MailTransportUnavailableError } from "../mail/providerTypes.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { INVITATIONS_MODULE_ID } from "../seed/invitationsKeys.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { getCatalogs, noAttachmentStorage } from "./eventInvitationJob.js";
import { buildItipReply, type ItipReplyPartstat } from "./icalendarWriter.js";
import { logger } from "./logger.js";

export const CALENDAR_SEND_INVITATION_REPLY_TASK = "calendarSendInvitationReply";

/** `acknowledged` (a notice of a shared calendar) and `pending` are not replied to. */
const REPLY_RESPONSES = ["accepted", "tentative", "declined"] as const;

export const calendarSendInvitationReplyPayloadSchema = z
  .object({
    invitationId: z.uuid(),
    response: z.enum(REPLY_RESPONSES),
    respondedAt: z.iso.datetime(),
  })
  .strict();

export type InvitationReplyPayload = z.infer<typeof calendarSendInvitationReplyPayloadSchema>;

const PARTSTATS: Readonly<Record<InvitationReplyPayload["response"], ItipReplyPartstat>> = {
  accepted: "ACCEPTED",
  tentative: "TENTATIVE",
  declined: "DECLINED",
};

/**
 * Queued in the caller's transaction, so the job exists only if it commits. The job key includes `respondedAt`:
 * a repeat of the same answer collapses onto the queued job, a changed answer gets its own.
 */
export async function enqueueInvitationReply(client: PoolClient, input: InvitationReplyPayload): Promise<void> {
  const payload = calendarSendInvitationReplyPayloadSchema.parse(input);
  await enqueueJob(client, CALENDAR_SEND_INVITATION_REPLY_TASK, payload, {
    jobKey: `invitation-reply:${payload.invitationId}:${payload.respondedAt}`,
  });
}

const storedInvitationSchema = z.object({
  uid: z.string().min(1),
  sequence: z.number().nullish(),
  title: z.string().nullish(),
  startsAt: z.string(),
  endsAt: z.string().nullish(),
  allDay: z.boolean().nullish(),
  organizerEmail: z.string().nullish(),
  respondedAt: z.string().nullish(),
});

export interface InvitationReplyDelivery {
  pool: Pool;
  transports: MailTransportFactory;
}

let delivery: InvitationReplyDelivery | null = null;

/** A module task handler receives only its payload, so the queue runtime binds its dependencies here first. */
export function setInvitationReplyDelivery(next: InvitationReplyDelivery | null): void {
  delivery = next;
}

type EndReason =
  | "invitationMissing"
  | "invitationUnreadable"
  | "superseded"
  | "noOrganizerAddress"
  | "mailboxMissing"
  | "noMailboxAddress"
  | "invalidMessage"
  | "noTransport"
  | "recipientRejected";

interface ReplyPlan {
  /** The first address of the receiving mailbox. */
  mailboxAddress: string;
  /** The address the invitation was delivered to. */
  attendeeEmail: string;
  organizerEmail: string;
  syncMode: SyncMode;
  locale: string;
  invitation: z.infer<typeof storedInvitationSchema>;
}

type Planned = { kind: "send"; mailboxId: string; plan: ReplyPlan } | { kind: "end"; reason: EndReason };

/** Addresses and the title stay out of the log. */
function endWithoutSending(payload: InvitationReplyPayload, reason: EndReason): void {
  const fields = { reason, invitationId: payload.invitationId, response: payload.response };
  // A superseded answer is the normal outcome of changing an answer twice, not a fault.
  if (reason === "superseded") logger.info(fields, "An invitation reply was not sent");
  else logger.warn(fields, "An invitation reply was not sent");
}

async function firstRelatedId(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  key: string,
): Promise<string | null> {
  const property = await getPropertyByKey(client, databaseId, key);
  if (!property) throw new Error(`The invitations database has no '${key}' relation`);
  const definition = await getRelationDefinitionByPropertyId(client, property.id);
  if (!definition) throw new Error(`The invitations '${key}' relation has no definition`);
  const [edge] = await listRelationsForItem(client, definition.id, itemId);
  return edge === undefined ? null : otherSide(edge, itemId);
}

/**
 * Runs in a short transaction before any network call. A `respondedAt` that differs from the payload's means the
 * answer changed again and that answer has its own job.
 */
async function planReply(client: PoolClient, payload: InvitationReplyPayload): Promise<Planned> {
  const invitations = await getDatabaseByModuleId(client, INVITATIONS_MODULE_ID);
  const row = invitations === null ? null : await getItemById(client, invitations.id, payload.invitationId);
  if (invitations === null || row === null || row.deletedAt !== null)
    return { kind: "end", reason: "invitationMissing" };
  const stored = storedInvitationSchema.safeParse(row.properties);
  if (!stored.success) return { kind: "end", reason: "invitationUnreadable" };
  const invitation = stored.data;
  if (
    invitation.respondedAt == null ||
    new Date(invitation.respondedAt).getTime() !== new Date(payload.respondedAt).getTime()
  ) {
    return { kind: "end", reason: "superseded" };
  }
  if (!invitation.organizerEmail) return { kind: "end", reason: "noOrganizerAddress" };

  const mailboxId = await firstRelatedId(client, invitations.id, row.id, "mailbox");
  const mailboxes = await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID);
  const mailbox = mailboxId === null || mailboxes === null ? null : await getItemById(client, mailboxes.id, mailboxId);
  if (mailboxId === null || mailbox === null || mailbox.deletedAt !== null) {
    return { kind: "end", reason: "mailboxMissing" };
  }
  const mailboxAddress = parseAddressListProperty(mailbox.properties.addresses)[0];
  if (mailboxAddress === undefined) return { kind: "end", reason: "noMailboxAddress" };

  const emailId = await firstRelatedId(client, invitations.id, row.id, "sourceEmail");
  const meta = emailId === null ? null : await getMailMessageMetaByItemId(client, emailId);
  // A mailbox that has never synced has no sync-state row; it takes the default mode of its provider, as a send does.
  const syncState = await getMailAccountSyncState(client, mailboxId);
  const provider = typeof mailbox.properties.provider === "string" ? mailbox.properties.provider : "generic";
  return {
    kind: "send",
    mailboxId,
    plan: {
      mailboxAddress,
      attendeeEmail: meta?.deliveredToAddress ?? mailboxAddress,
      organizerEmail: invitation.organizerEmail,
      syncMode: syncState?.syncMode ?? defaultSyncModeForProvider(provider),
      locale: (await getTenantUserLocale(client)) ?? "cs",
      invitation,
    },
  };
}

async function renderReplyText(
  response: InvitationReplyPayload["response"],
  locale: string,
  title: string,
): Promise<{ subject: string; text: string }> {
  const catalogs = await getCatalogs();
  const resolve = (part: "subject" | "text"): string =>
    resolveCatalogLabel(
      null,
      catalogs[toManifestLocale(locale)],
      catalogs.en,
      `calendar.invitation.reply.${response}.${part}`,
    );
  // A header takes no line break; a replacer function keeps `$` sequences in the title literal.
  const oneLine = title.replace(/\s+/g, " ").trim();
  return {
    subject: resolve("subject").replaceAll("{title}", () => oneLine),
    text: resolve("text").replaceAll("{title}", () => oneLine),
  };
}

/**
 * Permanent failures end the job with a reason code; every other failure is rethrown so the queue retries. A retry
 * resends with the same UID and SEQUENCE, which an iTIP client reads as the same answer. No transaction is open
 * while the message is built or sent.
 */
export async function sendInvitationReply(
  deps: InvitationReplyDelivery,
  payload: InvitationReplyPayload,
): Promise<void> {
  const planned = await withTransaction(deps.pool, (client) => planReply(client, payload));
  if (planned.kind === "end") return endWithoutSending(payload, planned.reason);
  const { mailboxId, plan } = planned;
  const { invitation } = plan;

  const messageId = generateOutgoingMessageId(plan.mailboxAddress);
  let raw: Buffer;
  let envelope: { from: string; recipients: string[] };
  try {
    const title = invitation.title ?? "";
    const { subject, text } = await renderReplyText(payload.response, plan.locale, title);
    const mime = await buildOutgoingMime(
      {
        from: { address: plan.mailboxAddress },
        to: [{ address: plan.organizerEmail }],
        subject,
        text,
        messageId,
        calendar: {
          method: "REPLY",
          content: buildItipReply({
            uid: invitation.uid,
            sequence: invitation.sequence ?? 0,
            organizerEmail: plan.organizerEmail,
            attendeeEmail: plan.attendeeEmail,
            partstat: PARTSTATS[payload.response],
            summary: title,
            startsAt: invitation.startsAt,
            endsAt: invitation.endsAt ?? null,
            allDay: invitation.allDay ?? false,
          }),
        },
      },
      { client: deps.pool, files: noAttachmentStorage, mailAttachments: noAttachmentStorage },
    );
    raw = mime.raw;
    envelope = { from: plan.mailboxAddress, recipients: mime.envelopeRecipients };
  } catch (error) {
    if (error instanceof ValidationError) return endWithoutSending(payload, "invalidMessage");
    throw error;
  }

  let transport: MailTransport;
  try {
    transport = await deps.transports.forMailbox(mailboxId, plan.syncMode);
  } catch (error) {
    if (error instanceof ValidationError || error instanceof MailTransportUnavailableError) {
      return endWithoutSending(payload, "noTransport");
    }
    throw error;
  }
  let sent: MailTransportResult;
  try {
    sent = await transport.send({ raw, envelope });
  } catch (error) {
    if (error instanceof MailRecipientRejectedError) return endWithoutSending(payload, "recipientRejected");
    throw error;
  }
  if (sent.needsSentCopy) await recordPendingSentCopyAfterSend(deps.pool, { mailboxItemId: mailboxId, messageId, raw });
}

/** Throws while nothing is bound, so the queue retries until a runtime that bound the delivery runs it. */
export async function handleCalendarSendInvitationReply(payload: unknown): Promise<void> {
  const parsed = calendarSendInvitationReplyPayloadSchema.parse(payload);
  if (delivery === null) throw new Error("No invitation reply delivery is configured for this composition root");
  await sendInvitationReply(delivery, parsed);
}
