import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { ChokePointError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { getItemById, lockItemById } from "../chokePoint/itemsStore.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import type { ApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { EMAIL_INGEST_ALLOWED_SYSTEM_KEYS, formatAddress, formatAddressList } from "./ingest.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { findFolderBySpecialPurpose } from "./folderDiscovery.js";
import { linkEmailEnvelopeToPeople } from "./personLinkingActions.js";
import { retireSupersededSempDrafts } from "./draftRetirement.js";
import { requestMailSendApproval } from "./mailSendApproval.js";
import { getMailDraft, markMailDraftSent } from "./mailDraftsStore.js";
import { announceMailThreadChanged } from "./mailThreadActions.js";
import {
  deleteMailMessageMetaByItemId,
  getMailMessageMetaByItemId,
  upsertMailMessageMeta,
  type MailEnvelope,
  type MailEnvelopeAddress,
} from "./mailMessageMetaStore.js";
import { getMailAccountSyncState, defaultSyncModeForProvider } from "./mailAccountSyncStateStore.js";
import { resolveThreadId } from "./threading.js";
import { buildMailPreviewFromBody } from "./mailPlainText.js";
import { parseAddressListProperty } from "./addressListParsing.js";
import { normalizeEmailAddress } from "./personEmailIndexStore.js";
import {
  buildOutgoingMime,
  generateOutgoingMessageId,
  type OutgoingAttachmentInput,
  type OutgoingMimeDeps,
} from "./outgoingMime.js";
import type { MailTransportFactory } from "./mailTransport.js";

/**
 * An agent run (or an MCP client holding a run credential). An agent never sends directly: `sendDraftEmail`
 * creates an approval request instead, whatever `emailSendAutonomous` permission applies. `toolCallId`
 * makes a repeated call return the request it created.
 */
export interface SendEmailAgentActor {
  type: "ai_agent";
  agentRunId: string;
  toolCallId?: string | null;
}
export type SendEmailUserActor = { type: "user" };
export type SendEmailActor = SendEmailUserActor | SendEmailAgentActor;

/** Real transports are injected by the composition root; the default is a stub that throws. */
export interface MailSendAdapterFactory {
  transports?: MailTransportFactory;
  attachmentStorage?: Pick<OutgoingMimeDeps, "files" | "mailAttachments">;
}

export const noopMailSendAdapterFactory: MailSendAdapterFactory = {};

/** Raised before the claim: a sent draft would have nowhere to move. 409 `mail_sent_folder_missing`. */
export class MailSentFolderMissingError extends ChokePointError {
  constructor(mailboxItemId: string) {
    super(409, "mail_sent_folder_missing", "The mailbox has no Sent folder yet; sync the account before sending", {
      mailboxId: mailboxItemId,
    });
    this.name = "MailSentFolderMissingError";
  }
}

/** Raised before the claim; the draft is untouched and nothing is queued. 409 `mail_reauthorization_required`. */
export class MailboxNeedsReauthorizationError extends ChokePointError {
  constructor(mailboxItemId: string) {
    super(409, "mail_reauthorization_required", "The mailbox must be reauthorized before it can send", {
      mailboxId: mailboxItemId,
    });
    this.name = "MailboxNeedsReauthorizationError";
  }
}

/** Another call holds the claim: the draft is being sent or was sent already. */
export class MailSendClaimLostError extends ConflictError {
  constructor(draftItemId: string) {
    super(`Draft ${draftItemId} is already being sent or was already sent`);
    this.name = "MailSendClaimLostError";
  }
}

export interface SendEmailOptions {
  /**
   * Runs in the claim transaction after the draft is locked and found live and unsent, before the claim
   * is written. A guard that throws means nothing is claimed or sent.
   */
  beforeClaim?: (client: PoolClient) => Promise<void>;
}

export interface SendEmailModuleIds {
  emailsDatabaseId: string;
  foldersDatabaseId: string;
  mailboxesDatabaseId: string;
  folderRelationPropertyId: string;
  mailboxFolderRelationPropertyId: string;
  senderPeopleKey: string;
  recipientsPeopleKey: string;
}

export interface SendEmailInput {
  mailboxItemId: string;
  draftItemId: string;
  actor: SendEmailActor;
  from: MailEnvelopeAddress;
  to: MailEnvelopeAddress[];
  cc?: MailEnvelopeAddress[];
  bcc?: MailEnvelopeAddress[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: OutgoingAttachmentInput[];
  /** Only the Gmail transport uses it. */
  providerThreadId?: string;
}

/** The only input that reaches a provider from `sendDraftEmail` itself. */
export type UserSendEmailInput = SendEmailInput & { actor: SendEmailUserActor };
/** `sendDraftEmail` reads only `draftItemId` and `actor`. */
export type AgentSendEmailInput = SendEmailInput & { actor: SendEmailAgentActor };

export interface SendEmailResult {
  itemId: string;
  messageId: string;
  threadId: string;
  sentAt: Date;
}

/** The `mail_message_meta` primary-key (item_id) violation. */
function isItemAlreadyClaimedError(err: unknown): boolean {
  const pgErr = err as { code?: string; constraint?: string };
  return pgErr?.code === "23505" && pgErr?.constraint === "mail_message_meta_pkey";
}

/** Removes the Drafts edge once a draft becomes Sent. */
async function unlinkFromFoldersWithSpecialPurpose(
  client: PoolClient,
  input: { foldersDatabaseId: string; folderRelationPropertyId: string; itemId: string; specialPurpose: string },
): Promise<void> {
  const reldef = await getRelationDefinitionByPropertyId(client, input.folderRelationPropertyId);
  if (!reldef) return;
  const { rows } = await client.query<{ folder_id: string }>(
    `SELECT CASE WHEN r.item_a = $2 THEN r.item_b ELSE r.item_a END AS folder_id
     FROM item_relations r
     JOIN items f ON f.id = CASE WHEN r.item_a = $2 THEN r.item_b ELSE r.item_a END
     WHERE r.relation_definition_id = $1 AND (r.item_a = $2 OR r.item_b = $2)
       AND f.database_id = $3 AND f.properties ->> 'specialPurpose' = $4`,
    [reldef.id, input.itemId, input.foldersDatabaseId, input.specialPurpose],
  );
  for (const row of rows) {
    await deleteRelationWithClient(
      client,
      { relationPropertyId: input.folderRelationPropertyId, callerItemId: input.itemId, targetItemId: row.folder_id },
      EMAILS_RELATION_CONTEXT,
    );
  }
}

/**
 * `email.send`. The actor is checked first: an `ai_agent` never sends, and its call creates and returns
 * an approval request read from the stored draft; the approval executor later calls again as `user`.
 * For a user, `needsReauthorization` and a missing Sent folder are refused before the claim.
 *
 * The claim transaction locks the Emails item and then its `mail_drafts` row, refuses a trashed or sent
 * draft, runs `beforeClaim`, and writes the claim. While held, draft writers refuse the draft as sent,
 * so no edit or discard commits before finalization. After a successful send one transaction moves the
 * draft to Sent, links People, sets `sent_at`, announces the thread and retires outdated Semp drafts.
 * A failure before or during delivery undoes the claim so a genuine retry can still send.
 *
 * The claim is the `mail_message_meta` row written before the transport's `send`. Its `item_id` primary
 * key arbitrates (each `message_id` is fresh, so `ON CONFLICT (mailbox_item_id, message_id)` never
 * fires): a concurrent loser or a retry after a downstream failure gets `MailSendClaimLostError` instead
 * of resending with a new Message-ID. Ingest dedups on the same table per mailbox, so the synced Sent
 * copy converges onto this item.
 */
export async function sendDraftEmail(
  pool: Pool,
  input: AgentSendEmailInput,
  moduleIds: SendEmailModuleIds,
  adapters: MailSendAdapterFactory,
  options?: SendEmailOptions,
): Promise<ApprovalRequest>;
export async function sendDraftEmail(
  pool: Pool,
  input: UserSendEmailInput,
  moduleIds: SendEmailModuleIds,
  adapters: MailSendAdapterFactory,
  options?: SendEmailOptions,
): Promise<SendEmailResult>;
export async function sendDraftEmail(
  pool: Pool,
  input: SendEmailInput,
  moduleIds: SendEmailModuleIds,
  adapters: MailSendAdapterFactory,
  options: SendEmailOptions = {},
): Promise<SendEmailResult | ApprovalRequest> {
  if (input.actor.type === "ai_agent") return requestMailSendApproval(pool, input.draftItemId, input.actor);

  const [draft, mailbox] = await withTransaction(pool, async (client) => [
    await getItemById(client, moduleIds.emailsDatabaseId, input.draftItemId),
    await getItemById(client, moduleIds.mailboxesDatabaseId, input.mailboxItemId),
  ]);
  if (!draft) throw new NotFoundError(`Draft ${input.draftItemId} not found`);
  // `getItemById` does not filter `deleted_at`, so a removed mailbox is a row with `deletedAt` set.
  if (!mailbox || mailbox.deletedAt) throw new NotFoundError(`Mailbox ${input.mailboxItemId} not found`);
  if (mailbox.properties.syncStatus === "needsReauthorization") {
    throw new MailboxNeedsReauthorizationError(input.mailboxItemId);
  }

  // Prevents From-header spoofing over this mailbox's real credentials: the address must be one of
  // `Mailboxes.addresses`.
  const mailboxAliases = parseAddressListProperty(mailbox.properties.addresses).map(normalizeEmailAddress);
  if (!mailboxAliases.includes(normalizeEmailAddress(input.from.address))) {
    throw new ForbiddenError(
      `From address ${input.from.address} is not a registered address for mailbox ${input.mailboxItemId}`,
      { field: "from.address" },
      "from_address_not_registered",
    );
  }

  const sentFolderItemId = await withTransaction(pool, (client) =>
    findFolderBySpecialPurpose(client, {
      foldersDatabaseId: moduleIds.foldersDatabaseId,
      mailboxRelationPropertyId: moduleIds.mailboxFolderRelationPropertyId,
      mailboxItemId: input.mailboxItemId,
      specialPurpose: "sent",
    }),
  );
  if (!sentFolderItemId) throw new MailSentFolderMissingError(input.mailboxItemId);

  const { transports, attachmentStorage } = adapters;
  if (!transports || !attachmentStorage) throw new Error("No SMTP adapter configured for this composition root");
  // A never-synced mailbox takes its provider's default mode, the one its first sync would use.
  const syncState = await getMailAccountSyncState(pool, input.mailboxItemId);
  const syncMode =
    syncState?.syncMode ??
    defaultSyncModeForProvider(
      typeof mailbox.properties.provider === "string" ? mailbox.properties.provider : "generic",
    );

  const messageId = generateOutgoingMessageId(input.from.address);
  const envelope: MailEnvelope = { from: input.from, to: input.to, cc: input.cc, bcc: input.bcc };

  try {
    await withTransaction(pool, async (client) => {
      // Draft writers lock the Emails item then its `mail_drafts` row; deciding under both locks sees any
      // discard or edit committed since the checks above, and later ones find the claim.
      const draftItem = await lockItemById(client, moduleIds.emailsDatabaseId, input.draftItemId);
      if (!draftItem || draftItem.deletedAt) throw new NotFoundError(`Draft ${input.draftItemId} not found`);
      const draftRow = await getMailDraft(client, input.draftItemId, true);
      if (draftRow !== null && draftRow.sentAt !== null) throw new MailSendClaimLostError(input.draftItemId);
      await options.beforeClaim?.(client);
      // Resolved before the claim row exists, so a rolled-back claim also rolls back any thread created here.
      const claimThreadId = await resolveThreadId(client, {
        messageId,
        inReplyTo: input.inReplyTo,
        references: input.references,
        subjectHint: input.subject,
      });
      await upsertMailMessageMeta(client, {
        itemId: input.draftItemId,
        mailboxItemId: input.mailboxItemId,
        messageId,
        threadId: claimThreadId,
        envelope,
        inReplyTo: input.inReplyTo,
        references: input.references,
        previewText: buildMailPreviewFromBody(input.bodyText, input.bodyHtml),
        ingestedAt: new Date(),
      });
    });
  } catch (err) {
    if (isItemAlreadyClaimedError(err)) {
      throw new MailSendClaimLostError(input.draftItemId);
    }
    throw err;
  }

  // Any failure here, including building the transport, undoes the claim.
  try {
    const transport = await transports.forMailbox(input.mailboxItemId, syncMode);
    const mime = await buildOutgoingMime(
      {
        from: input.from,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        text: input.bodyText ?? "",
        html: input.bodyHtml,
        messageId,
        inReplyTo: input.inReplyTo,
        references: input.references,
        attachments: input.attachments,
      },
      { client: pool, files: attachmentStorage.files, mailAttachments: attachmentStorage.mailAttachments },
    );
    await transport.send({
      raw: mime.raw,
      envelope: { from: input.from.address, recipients: mime.envelopeRecipients },
      ...(input.providerThreadId === undefined ? {} : { providerThreadId: input.providerThreadId }),
    });
  } catch (err) {
    // Best-effort: the send failure in `err` must surface even if the compensating delete fails, which
    // leaves the claim in place (a retry then sees a conflict until it is cleared directly).
    await withTransaction(pool, (client) => deleteMailMessageMetaByItemId(client, input.draftItemId)).catch(() => {});
    throw err;
  }

  return withTransaction(pool, async (client) => {
    const sentAt = new Date();
    await updateItemWithClient(
      client,
      {
        databaseId: moduleIds.emailsDatabaseId,
        itemId: input.draftItemId,
        propertiesPatch: {
          name: input.subject,
          sender: formatAddress(input.from),
          recipients: formatAddressList(input.to),
          body: input.bodyHtml ?? input.bodyText ?? "",
          date: sentAt.toISOString(),
        },
      },
      { allowedSystemKeys: EMAIL_INGEST_ALLOWED_SYSTEM_KEYS },
    );

    await unlinkFromFoldersWithSpecialPurpose(client, {
      foldersDatabaseId: moduleIds.foldersDatabaseId,
      folderRelationPropertyId: moduleIds.folderRelationPropertyId,
      itemId: input.draftItemId,
      specialPurpose: "drafts",
    });
    await createRelationWithClient(
      client,
      {
        relationPropertyId: moduleIds.folderRelationPropertyId,
        callerItemId: input.draftItemId,
        targetItemId: sentFolderItemId,
      },
      EMAILS_RELATION_CONTEXT,
    );
    // Same transaction: a link failure rolls back body, folder move and people edges together.
    await linkEmailEnvelopeToPeople(client, {
      itemId: input.draftItemId,
      envelope,
      emailsDatabaseId: moduleIds.emailsDatabaseId,
      senderPeopleKey: moduleIds.senderPeopleKey,
      recipientsPeopleKey: moduleIds.recipientsPeopleKey,
    });

    // Only Semprec-written drafts have a `mail_drafts` row. The item is already locked, so the row follows
    // the lock order.
    if ((await getMailDraft(client, input.draftItemId)) !== null) {
      await markMailDraftSent(client, input.draftItemId, sentAt);
    }
    // The claim row is the message's own: a thread merge since the claim moved it onto the live thread.
    const threadId = (await getMailMessageMetaByItemId(client, input.draftItemId))?.threadId;
    if (!threadId) throw new Error(`The claim of draft ${input.draftItemId} has no thread`);
    announceMailThreadChanged(client, threadId);
    // The user's own message makes the thread's Semp draft outdated, unless the Semp draft is the message.
    await retireSupersededSempDrafts(client, {
      threadId,
      ownMessageDate: sentAt,
      excludeDraftItemId: input.draftItemId,
    });

    return { itemId: input.draftItemId, messageId, threadId, sentAt };
  });
}
