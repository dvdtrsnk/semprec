// The `calendarSendInvitationReply` task (issue gh-1953): after the user answered an incoming invitation, it sends the
// iMIP `METHOD:REPLY` message to the organizer from the mailbox that received the invitation. The respond route
// queues it in the answer's own transaction, so a rolled-back answer sends nothing.
// Constrained by: docs/adr/2026-11-12-module-queue-tasks-read-their-composition-root-dependencies-from-a-binding.md,
// docs/adr/2026-09-10-side-effects-follow-the-commit.md
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
import type { MailTransport, MailTransportFactory } from "../mail/mailTransport.js";
import { buildOutgoingMime, generateOutgoingMessageId } from "../mail/outgoingMime.js";
import { MailRecipientRejectedError, MailTransportUnavailableError } from "../mail/providerTypes.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { INVITATIONS_MODULE_ID } from "../seed/invitationsKeys.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { getCatalogs, noAttachmentStorage } from "./eventInvitationJob.js";
import { buildItipReply, type ItipReplyPartstat } from "./icalendarWriter.js";
import { logger } from "./logger.js";

/** The queue name of the task, as `calendarModuleManifest.ts` declares it. */
export const CALENDAR_SEND_INVITATION_REPLY_TASK = "calendarSendInvitationReply";

/** The answers that are replied to; `acknowledged` (a notice of a shared calendar) and `pending` are not. */
const REPLY_RESPONSES = ["accepted", "tentative", "declined"] as const;

/** The payload of the task: the invitation, the answer and the moment it was stored on the invitation. */
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
 * Queues the reply to one answer in the caller's open transaction, so the job exists only when that transaction
 * commits. The job key names the invitation and the moment of the answer: a repeat of the same answer collapses onto
 * the queued job, and a changed answer, which has its own `respondedAt`, gets a job of its own. The payload is
 * validated before it is queued; an input that does not fit it throws and rolls the caller back.
 */
export async function enqueueInvitationReply(client: PoolClient, input: InvitationReplyPayload): Promise<void> {
  const payload = calendarSendInvitationReplyPayloadSchema.parse(input);
  await enqueueJob(client, CALENDAR_SEND_INVITATION_REPLY_TASK, payload, {
    jobKey: `invitation-reply:${payload.invitationId}:${payload.respondedAt}`,
  });
}

/** The stored fields of an invitation that a reply is made from. */
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

/** What the task needs from the composition root that runs it. */
export interface InvitationReplyDelivery {
  pool: Pool;
  transports: MailTransportFactory;
}

let delivery: InvitationReplyDelivery | null = null;

/**
 * Binds the dependencies the task handler uses to the process (`null` unbinds). The API queue runtime binds them
 * before it starts its runner, because a module task handler is an export of the manifest module and receives only
 * its payload.
 */
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
  /** The address the message is sent from: the first address of the receiving mailbox. */
  mailboxAddress: string;
  /** The address the invitation was delivered to; the `ATTENDEE` of the reply. */
  attendeeEmail: string;
  organizerEmail: string;
  syncMode: SyncMode;
  locale: string;
  invitation: z.infer<typeof storedInvitationSchema>;
}

type Planned = { kind: "send"; mailboxId: string; plan: ReplyPlan } | { kind: "end"; reason: EndReason };

/** Logs why a job ended without sending, by reason code and id; the addresses and the title stay out of the log. */
function endWithoutSending(payload: InvitationReplyPayload, reason: EndReason): void {
  const fields = { reason, invitationId: payload.invitationId, response: payload.response };
  // A superseded answer is the normal outcome of changing an answer twice, not a fault.
  if (reason === "superseded") logger.info(fields, "An invitation reply was not sent");
  else logger.warn(fields, "An invitation reply was not sent");
}

/** The first item on the other end of the edges `itemId` holds on its relation `key`; `null` when it has none. */
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
 * Reads, in one short transaction and before any network call, everything the reply is made of. It ends the job when
 * the invitation is missing or trashed or does not read, when its `respondedAt` is no longer the payload's (the
 * answer was changed again, and that answer has its own job), when it has no organizer address, and when the mailbox
 * it was received by is missing, trashed or has no address.
 *
 * The attendee is the address the invitation's source email was delivered to (`mail_message_meta`), else the
 * mailbox's first address.
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

/** The subject and the plain-text body of the reply in the tenant user's language; the title stands in `{title}`. */
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
 * Sends the reply to one answer.
 *
 * - Ends without sending, logging a reason code: an invitation that is missing, trashed or unreadable, an answer
 *   that was changed since the job was queued, an invitation with no organizer address, a mailbox that is missing,
 *   trashed or has no address, a message the builders refuse, a transport factory that refuses the mailbox as
 *   `validation_failed` or as `MailTransportUnavailableError` (no OAuth client for the provider, no stored SMTP
 *   credential, a sync mode without a transport), and an organizer address the server refused.
 * - Rethrows every other failure of the factory, of the MIME build and of the transport, so the queue retries with
 *   backoff. A retry sends the same message once more with the same UID and SEQUENCE, which an iTIP client reads as
 *   the same answer.
 *
 * The job runs in the tenant scope of its envelope; the transaction that reads is separate from the send and no
 * transaction is open while the message is built or sent. A failure that outlasts the retries leaves the answer as
 * it is recorded.
 */
export async function sendInvitationReply(
  deps: InvitationReplyDelivery,
  payload: InvitationReplyPayload,
): Promise<void> {
  const planned = await withTransaction(deps.pool, (client) => planReply(client, payload));
  if (planned.kind === "end") return endWithoutSending(payload, planned.reason);
  const { mailboxId, plan } = planned;
  const { invitation } = plan;

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
        messageId: generateOutgoingMessageId(plan.mailboxAddress),
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
  try {
    await transport.send({ raw, envelope });
  } catch (error) {
    if (error instanceof MailRecipientRejectedError) return endWithoutSending(payload, "recipientRejected");
    throw error;
  }
}

/**
 * The handler the calendar manifest names for the `calendarSendInvitationReply` task. It runs `sendInvitationReply`
 * with the dependencies bound by `setInvitationReplyDelivery`; with none bound it throws, and the queue retries the
 * job until a runtime that bound them runs it.
 */
export async function handleCalendarSendInvitationReply(payload: unknown): Promise<void> {
  const parsed = calendarSendInvitationReplyPayloadSchema.parse(payload);
  if (delivery === null) throw new Error("No invitation reply delivery is configured for this composition root");
  await sendInvitationReply(delivery, parsed);
}
