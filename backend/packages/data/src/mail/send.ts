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
 * Who sends (issue #95, issue gh-1913). A `user` is a server-derived authenticated user session, or an MCP client that
 * acts with a human session; it sends directly. An `ai_agent` is an agent run, or an MCP client holding a run
 * credential, which is a run too: `agentRunId` is that run, and the optional `toolCallId` is the model-runtime tool
 * call that asked, which makes a repeated call return the request it created. An agent never sends directly:
 * `sendDraftEmail` creates the approval request of its send instead (`requestMailSendApproval`). No project
 * permission changes that, neither `emailSendAutonomous` on the run's project, on the draft's thread nor on a heartbeat's.
 */
export interface SendEmailAgentActor {
  type: "ai_agent";
  agentRunId: string;
  toolCallId?: string | null;
}
export type SendEmailUserActor = { type: "user" };
export type SendEmailActor = SendEmailUserActor | SendEmailAgentActor;

/**
 * Real transport connections are out of `@semprec/data` — same "inject the real
 * implementation, default to a stub that throws" shape as `MailSyncAdapterFactory`
 * (mail/mailSyncJob.ts). A real composition root supplies `createMailTransportFactory(pool)`
 * (mail/mailTransport.ts) and the storage roots that attachment bytes are read from.
 */
export interface MailSendAdapterFactory {
  transports?: MailTransportFactory;
  attachmentStorage?: Pick<OutgoingMimeDeps, "files" | "mailAttachments">;
}

export const noopMailSendAdapterFactory: MailSendAdapterFactory = {};

/**
 * Raised before anything is claimed or sent when a mailbox has no Sent folder, which no sync pass has discovered
 * yet: a sent draft would have nowhere to move to. The answer is 409 `mail_sent_folder_missing`.
 */
export class MailSentFolderMissingError extends ChokePointError {
  constructor(mailboxItemId: string) {
    super(409, "mail_sent_folder_missing", "The mailbox has no Sent folder yet; sync the account before sending", {
      mailboxId: mailboxItemId,
    });
    this.name = "MailSentFolderMissingError";
  }
}

/**
 * Raised before anything is claimed or sent when the mailbox's `syncStatus` is `needsReauthorization`: its credential
 * was refused and the user has to sign in again. The draft is untouched and the message is not queued for later. The
 * answer is 409 `mail_reauthorization_required`.
 */
export class MailboxNeedsReauthorizationError extends ChokePointError {
  constructor(mailboxItemId: string) {
    super(409, "mail_reauthorization_required", "The mailbox must be reauthorized before it can send", {
      mailboxId: mailboxItemId,
    });
    this.name = "MailboxNeedsReauthorizationError";
  }
}

/**
 * Raised when another call holds the claim on the draft: it is being sent or was sent already. It is a
 * `ConflictError` (`version_conflict`) for a caller that does not tell the two apart; `sendMailDraft`
 * (mail/mailDraftSend.ts) answers it as `mail_draft_already_sent`.
 */
export class MailSendClaimLostError extends ConflictError {
  constructor(draftItemId: string) {
    super(`Draft ${draftItemId} is already being sent or was already sent`);
    this.name = "MailSendClaimLostError";
  }
}

/** What a caller of `sendDraftEmail` may add to it. */
export interface SendEmailOptions {
  /**
   * Runs in the claim transaction after the draft's Emails item and `mail_drafts` row are locked and found live and
   * unsent, and before the claim is written. A guard that throws means nothing is claimed and nothing is sent. The send
   * route (mail/mailDraftSend.ts) re-reads the draft here and refuses one that changed since it was read.
   */
  beforeClaim?: (client: PoolClient) => Promise<void>;
}

export interface SendEmailModuleIds {
  emailsDatabaseId: string;
  foldersDatabaseId: string;
  mailboxesDatabaseId: string;
  /** Emails.folder relation property id. */
  folderRelationPropertyId: string;
  /** Folders.mailbox relation property id. */
  mailboxFolderRelationPropertyId: string;
  /** Emails.senderPeople relation property key (seed: `senderPeople`). */
  senderPeopleKey: string;
  /** Emails.recipientsPeople relation property key (seed: `recipientsPeople`). */
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
  /** The files sent with the message; `buildOutgoingMime` reads their bytes from the adapters' attachment storage. */
  attachments?: OutgoingAttachmentInput[];
  /**
   * The provider's id of the conversation the message replies in. The Gmail transport files the message into it; the
   * SMTP and Microsoft Graph transports ignore it.
   */
  providerThreadId?: string;
}

/** The input of a send by a user, the only one that reaches a provider from `sendDraftEmail` itself. */
export type UserSendEmailInput = SendEmailInput & { actor: SendEmailUserActor };
/** The input of a send by an agent: `sendDraftEmail` reads its `draftItemId` and `actor` only. */
export type AgentSendEmailInput = SendEmailInput & { actor: SendEmailAgentActor };

export interface SendEmailResult {
  itemId: string;
  messageId: string;
  /** The Semprec thread the sent message is in. */
  threadId: string;
  /** When the message was finalized: the draft's new `date` and, for a draft with a `mail_drafts` row, its `sent_at`. */
  sentAt: Date;
}

/** True when a Postgres error is `mail_message_meta`'s primary-key (item_id) violation — mirrors chokePoint/viewsStore.ts's own `isUniqueViolation` helper. */
function isItemAlreadyClaimedError(err: unknown): boolean {
  const pgErr = err as { code?: string; constraint?: string };
  return pgErr?.code === "23505" && pgErr?.constraint === "mail_message_meta_pkey";
}

/** Drops this item's membership in any folder with the given `specialPurpose` — used to remove the Drafts edge once a draft becomes Sent. Filters by `specialPurpose` in SQL (like `findFolderBySpecialPurpose`) rather than fetching every linked folder item to check it in JS. */
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
 * `email.send` (issue #95). The actor is looked at first, before any SMTP call or write of the send: an `ai_agent`
 * actor never sends, whatever permission its project holds. Its call creates the approval request of the send
 * (`requestMailSendApproval`, issue gh-1913), returns it and reads nothing of `input` but `draftItemId` and `actor`;
 * what the request describes is read from the stored draft. The mail leaves only when its owner approves the request,
 * and the executor of the approval then calls this function again as a `user` actor. For a `user` actor, a mailbox
 * whose `syncStatus` is `needsReauthorization`
 * (`MailboxNeedsReauthorizationError`) and a mailbox without a Sent folder (`MailSentFolderMissingError`) are refused
 * before the claim, so the draft is left as it was. Otherwise this atomically
 * *claims* the draft for sending (see below) before ever calling the transport, submits the message, then
 * on success finalizes the draft item into the mailbox's Sent folder, links its addresses to
 * Persons (`linkEmailEnvelopeToPeople`, issue #1480), sets `mail_drafts.sent_at` when the draft has a row (issue
 * gh-1896), announces the thread and retires the thread's outdated Semp drafts (`retireSupersededSempDrafts`, issue
 * gh-1902), all in that same transaction; on a failure before or during delivery it
 * undoes the claim so a genuine retry can still send. A call that loses the claim throws `MailSendClaimLostError`.
 * The claim transaction locks the draft's Emails item and then its `mail_drafts` row and refuses a draft that is in
 * the trash or already sent (`MailSendClaimLostError` for a sent one), then runs `options.beforeClaim`. While the
 * claim is held, the draft's writers refuse the draft as sent (`lockUnsentDraft`), so an edit or a discard cannot
 * commit between the claim and the finalizing transaction.
 *
 * The claim is `upsertMailMessageMeta` itself, moved to run *before* the transport's `send` instead of
 * after — `mail_message_meta.item_id` is this table's primary key (one row per Email item), so
 * two concurrent calls for the same draft can't both win it: the loser's INSERT fails with a
 * primary-key violation (each call's `message_id` is a fresh random UUID, so `ON CONFLICT
 * (mailbox_item_id, message_id)` never itself fires here — it's the `item_id` PK that arbitrates), which this
 * function turns into a `MailSendClaimLostError` (a `ConflictError`) before ever reaching SMTP. This also closes the
 * sequential-retry version of the same race: a retry after a transient failure downstream of a
 * successful send (the finalize transaction failing, a network partition) still finds the claim
 * from the original call and is rejected, instead of re-sending with a brand-new Message-ID.
 * `ingestEmailMessage` (mail/ingest.ts) checks this same table/dedup key (per mailbox — hence
 * the claim carries `mailboxItemId`), so the next IMAP/Gmail/Graph reconcile pass of this mailbox that later observes this Message-ID in the real Sent folder
 * converges onto this item instead of duplicating it.
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
  // `deletedAt` half is deliberate: `itemsStore.getItemById` selects by id with no
  // `deleted_at IS NULL` filter, and nothing in this repository hard-deletes items
  // (`chokePoint.softDeleteItem` sets `deleted_at`), so a removed mailbox comes back as a row
  // with `deletedAt` set, not as `null` — a null-only guard would leave sending over a deleted
  // mailbox working.
  if (!mailbox || mailbox.deletedAt) throw new NotFoundError(`Mailbox ${input.mailboxItemId} not found`);
  if (mailbox.properties.syncStatus === "needsReauthorization") {
    throw new MailboxNeedsReauthorizationError(input.mailboxItemId);
  }

  // Without this, any actor could set an arbitrary
  // `from.address` and have it go out over this mailbox's real SMTP credentials — From-header
  // spoofing through a mailbox the caller doesn't actually control that address on. Checked
  // against `Mailboxes.addresses` (the same registered-alias list mail/deliveredTo.ts already
  // trusts for the inbound direction), not just the caller's say-so.
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
  // A mailbox that has never synced has no sync-state row. It takes the default mode of its provider, the
  // mode its first sync would use, so the transport is chosen the same way on either path.
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
      // The draft is decided on under the locks of every draft writer, the Emails item and then its `mail_drafts` row
      // ([[2026-11-13-a-discarded-mail-draft-loses-its-row-and-draft-writers-lock-the-item-before-the-row]]), so a
      // discard or an edit that committed since the checks above is seen here, and one that starts after the claim
      // commits finds the claim (`lockUnsentDraft`).
      const draftItem = await lockItemById(client, moduleIds.emailsDatabaseId, input.draftItemId);
      if (!draftItem || draftItem.deletedAt) throw new NotFoundError(`Draft ${input.draftItemId} not found`);
      const draftRow = await getMailDraft(client, input.draftItemId, true);
      if (draftRow !== null && draftRow.sentAt !== null) throw new MailSendClaimLostError(input.draftItemId);
      await options.beforeClaim?.(client);
      // Resolved in the claim transaction and before the claim row exists (see resolveThreadId),
      // so a rolled-back claim also rolls back any thread created here.
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

  // Any failure in this block undoes the claim, including a transport that cannot be built (no settings, no
  // credential). A failure after the server took the message is undone the same way, as the SMTP failure already was.
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
    // Best-effort: the SMTP failure in `err` is the cause this call must surface — if the
    // compensating delete itself also fails (DB down, timeout), that must not replace it, even
    // though it does mean the claim is left in place (a subsequent attempt sees `ConflictError`
    // rather than being able to resend immediately; a human can still clear it directly, the
    // same "direct DB access" escape hatch this table's other invariants already rely on).
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
    // Same transaction as the rest of the finalization: a link failure rolls back the draft's
    // body, its folder move and its people edges together (issue #1480).
    await linkEmailEnvelopeToPeople(client, {
      itemId: input.draftItemId,
      envelope,
      emailsDatabaseId: moduleIds.emailsDatabaseId,
      senderPeopleKey: moduleIds.senderPeopleKey,
      recipientsPeopleKey: moduleIds.recipientsPeopleKey,
    });

    // A draft written by Semprec has a `mail_drafts` row, which a sent draft keeps with its `sent_at` set (issue
    // gh-1896); a plain Emails draft has none. The item was locked by the update above, so the row follows its lock order.
    if ((await getMailDraft(client, input.draftItemId)) !== null) {
      await markMailDraftSent(client, input.draftItemId, sentAt);
    }
    // The claim row is the message's own: a thread merge since the claim moved it onto the live thread.
    const threadId = (await getMailMessageMetaByItemId(client, input.draftItemId))?.threadId;
    if (!threadId) throw new Error(`The claim of draft ${input.draftItemId} has no thread`);
    announceMailThreadChanged(client, threadId);
    // The user's own message makes the thread's Semp draft outdated, unless the Semp draft is the message (issue gh-1902).
    await retireSupersededSempDrafts(client, {
      threadId,
      ownMessageDate: sentAt,
      excludeDraftItemId: input.draftItemId,
    });

    return { itemId: input.draftItemId, messageId, threadId, sentAt };
  });
}
