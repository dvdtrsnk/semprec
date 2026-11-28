import { hasUnsettledMailMove } from "./mailMessageMoveSyncStore.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";
import { touchMailThreads } from "./mailThreadChanges.js";
import type { PoolClient } from "pg";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { resolveThreadId } from "./threading.js";
import { buildMailPreview, buildMailPreviewFromBody } from "./mailPlainText.js";
import {
  getMailMessageMetaByMailboxAndMessageId,
  getMailMessageMetaByProviderMessageId,
  getMailThreadItemId,
  isProviderMessageIdConflict,
  upsertMailMessageMeta,
  type MailEnvelope,
  type MailEnvelopeAddress,
} from "./mailMessageMetaStore.js";
import {
  ingestAttachments,
  recordIndexedAttachments,
  type ClassifiedAttachment,
  type IndexedAttachment,
} from "./attachments.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import { reindexItemSearch } from "./search.js";
import { buildMailSearchText } from "./mailSearchText.js";
import { detectBulkMail, type BulkMailHeaders } from "./bulkMail.js";
import { resolveDeliveredToAddress } from "./deliveredTo.js";
import { retireSupersededSempDrafts } from "./draftRetirement.js";
import { normalizeEmailAddress } from "./personEmailIndexStore.js";
import { messageFlagProperties } from "./messageFlags.js";
import { recordObservedMailMessageFlags } from "./mailMessageFlagSyncStore.js";
import { applyObservedMailMessageFlags } from "./mailFlagObservation.js";
import { enqueueThreadLinkRulesForFirstInbound } from "./threadLinkRules.js";
import { enqueueThreadProjectTriage } from "./threadProjectTriage.js";
import type { MailArrival } from "./mailArrival.js";

export function formatAddress(address: MailEnvelopeAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

export function formatAddressList(list: MailEnvelopeAddress[] | undefined): string {
  return (list ?? []).map(formatAddress).join(", ");
}

/** System-owned Emails properties mirrored from the mailbox; `read`/`flagged` are user-owned and need no exemption. */
export const EMAIL_INGEST_ALLOWED_SYSTEM_KEYS = ["name", "sender", "recipients", "body", "date"];

/**
 * What of a message's content ingest stores: a `full` message its body and attachment bytes, an `index` message a
 * plain-text snippet for its preview and search, and its attachments' metadata. Stored on a new message only; one
 * already ingested keeps its own content and content state.
 */
export type IngestedMailContent =
  | { contentState: "full"; bodyText?: string; bodyHtml?: string; attachments: ClassifiedAttachment[] }
  | { contentState: "index"; snippet?: string; attachments: IndexedAttachment[] };

export type IngestEmailMessageInput = IngestEmailMessageEnvelope & IngestedMailContent;

export interface IngestEmailMessageEnvelope {
  emailsDatabaseId: string;
  filesDatabaseId: string;
  folderRelationPropertyId: string;
  attachmentsRelationPropertyId: string;
  folderItemId: string;
  /** Dedup scope: the same `Message-ID` in two mailboxes is two items. */
  mailboxItemId: string;
  protectedMoveMessageIds?: ReadonlySet<string>;
  /** IMAP only: the UID in this folder, stored on the relation edge. */
  folderUid?: number;
  messageId: string;
  /** Stored on a new message only; one already ingested keeps its own. */
  arrival: MailArrival;
  inReplyTo?: string | null;
  references?: string[];
  subject?: string;
  envelope: MailEnvelope;
  date?: Date;
  providerThreadId?: string | null;
  providerMessageId?: string | null;
  storage: BlobStorageWriter;
  storageKeyPrefix: string;
  /** This mailbox's registered addresses, used as deliveredToAddress's alias fallback. Defaults to `[]`. */
  mailboxAliases?: string[];
  deliveredToHeaders?: string[];
  xOriginalTo?: string | null;
  envelopeTo?: string | null;
  bulkHeaders?: BulkMailHeaders;
  /** A delivery-status report (bounce), not a human reply. */
  isDsn?: boolean;
  flags?: string[];
}

/**
 * A sent message of the user's own: in the Sent folder or from a registered address. Drafts
 * folder messages never count; they are unsent work from another client.
 */
async function isOwnMessage(client: PoolClient, input: IngestEmailMessageInput): Promise<boolean> {
  const [folder] = await getItemsByIds(client, [input.folderItemId]);
  const specialPurpose = folder?.properties.specialPurpose;
  if (specialPurpose === "drafts") return false;
  if (specialPurpose === "sent") return true;
  const sender = input.envelope.from?.address;
  if (sender === undefined) return false;
  return (input.mailboxAliases ?? []).map(normalizeEmailAddress).includes(normalizeEmailAddress(sender));
}

export interface IngestEmailMessageResult {
  itemId: string;
  /** false when the call converged onto an already-ingested message. */
  created: boolean;
}

/**
 * The single writer turning synced messages into Emails items, for all adapters. Dedups by
 * Message-ID per mailbox (so read/flag state never leaks across mailboxes), resolves the thread,
 * always links the folder (a known message can appear in a new folder), ingests attachments and
 * reindexes search. Only a newly created message announces its thread after commit, triggers
 * first-inbound thread rules, and (if the user's own) retires outdated Semp drafts; only a new live one
 * also queues thread project triage.
 *
 * Must run in a transaction: the item and `mail_message_meta` writes must commit together so
 * person linking sees a consistent envelope.
 */
export async function ingestEmailMessage(
  client: PoolClient,
  input: IngestEmailMessageInput,
): Promise<IngestEmailMessageResult> {
  await lockMailThreadMutation(client);
  const existing = await getMailMessageMetaByMailboxAndMessageId(client, input.mailboxItemId, input.messageId);
  let itemId: string;
  let created = false;
  /** Unset for a converged message or one that lost a provider-id conflict. */
  let newMessageThreadId: string | null = null;

  if (existing) {
    itemId = existing.itemId;
  } else {
    // Two passes can race to ingest different Message-IDs naming the same provider message. The
    // loser's writes run under a SAVEPOINT, roll back on the unique-index conflict and converge
    // onto the winner; the folder relation below is still linked.
    await client.query("SAVEPOINT ingest_provider_msg_conflict");
    try {
      const threadId = await resolveThreadId(client, {
        messageId: input.messageId,
        inReplyTo: input.inReplyTo,
        references: input.references,
        subjectHint: input.subject,
      });

      const item = await createItemWithClient(
        client,
        {
          databaseId: input.emailsDatabaseId,
          properties: {
            name: input.subject ?? "(no subject)",
            sender: input.envelope.from ? formatAddress(input.envelope.from) : "",
            recipients: formatAddressList(input.envelope.to),
            body: input.contentState === "full" ? (input.bodyHtml ?? input.bodyText ?? "") : "",
            ...(input.date ? { date: input.date.toISOString() } : {}),
            // Seeded from the server only at creation; later passes must not overwrite user changes.
            ...messageFlagProperties(input.flags),
          },
        },
        { allowedSystemKeys: EMAIL_INGEST_ALLOWED_SYSTEM_KEYS },
      );
      itemId = item.id;
      created = true;

      const deliveredToAddress = resolveDeliveredToAddress({
        candidates: {
          deliveredToHeaders: input.deliveredToHeaders ?? [],
          xOriginalTo: input.xOriginalTo,
          envelopeTo: input.envelopeTo,
        },
        structuredTo: input.envelope.to ?? [],
        structuredCc: input.envelope.cc ?? [],
        mailboxAliases: input.mailboxAliases ?? [],
      });

      // RFC 3464: a DSN's References/In-Reply-To name the original outgoing message.
      const dsnOriginalMessageId = input.isDsn
        ? (input.inReplyTo ?? input.references?.[input.references.length - 1] ?? null)
        : null;

      await upsertMailMessageMeta(client, {
        itemId,
        mailboxItemId: input.mailboxItemId,
        messageId: input.messageId,
        inReplyTo: input.inReplyTo,
        references: input.references,
        threadId,
        providerThreadId: input.providerThreadId,
        providerMessageId: input.providerMessageId,
        envelope: input.envelope,
        deliveredToAddress: deliveredToAddress ?? null,
        messageKind: input.isDsn ? "dsn" : "message",
        // First ingest only: the upsert's DO UPDATE never touches is_bulk.
        isBulk: detectBulkMail({ ...input.bulkHeaders, senderAddress: input.envelope.from?.address }),
        dsnOriginalMessageId,
        previewText:
          input.contentState === "full"
            ? buildMailPreviewFromBody(input.bodyText, input.bodyHtml)
            : buildMailPreview(input.snippet ?? ""),
        ingestedAt: new Date(),
        arrival: input.arrival,
        contentState: input.contentState,
      });

      const searchedEnvelope = {
        subject: input.subject,
        senderName: input.envelope.from?.name,
        senderAddress: input.envelope.from?.address,
      };
      if (input.contentState === "full") {
        const { extractedTexts } = await ingestAttachments(client, {
          messageItemId: itemId,
          threadItemId: await getMailThreadItemId(client, threadId),
          filesDatabaseId: input.filesDatabaseId,
          attachmentsRelationPropertyId: input.attachmentsRelationPropertyId,
          attachments: input.attachments,
          storage: input.storage,
          storageKeyPrefix: input.storageKeyPrefix,
        });
        // Attachment text is folded into the message's own search text; there is no per-attachment index.
        await reindexItemSearch(client, {
          itemId,
          databaseId: input.emailsDatabaseId,
          text: buildMailSearchText({
            ...searchedEnvelope,
            bodyText: input.bodyText,
            bodyHtml: input.bodyHtml,
            extractedTexts,
          }),
        });
      } else {
        await recordIndexedAttachments(client, itemId, input.attachments);
        await reindexItemSearch(client, {
          itemId,
          databaseId: input.emailsDatabaseId,
          text: buildMailSearchText({
            ...searchedEnvelope,
            bodyText: input.snippet ?? "",
            extractedTexts: input.attachments.map((attachment) => attachment.filename),
          }),
        });
      }

      await client.query("RELEASE SAVEPOINT ingest_provider_msg_conflict");
      // Publishes the thread's tenant-wide `mailThread` invalidation after commit; a converged provider-id conflict
      // never reaches here.
      touchMailThreads(client, [threadId]);
      newMessageThreadId = threadId;
    } catch (err) {
      if (!isProviderMessageIdConflict(err)) throw err;
      await client.query("ROLLBACK TO SAVEPOINT ingest_provider_msg_conflict");
      await client.query("RELEASE SAVEPOINT ingest_provider_msg_conflict");

      // The constraint that just fired guarantees a winning row exists under this provider id.
      if (input.providerMessageId == null) throw err;
      const winner = await getMailMessageMetaByProviderMessageId(client, input.providerMessageId);
      if (!winner) throw err;
      itemId = winner.itemId;
      created = false;
    }
  }

  // A new message of the user's own answers the thread, outdating Semp drafts written for older messages.
  if (newMessageThreadId !== null && (await isOwnMessage(client, input))) {
    await retireSupersededSempDrafts(client, {
      threadId: newMessageThreadId,
      ownMessageDate: input.date ?? new Date(),
    });
  }

  if (!created && (input.protectedMoveMessageIds?.has(itemId) || (await hasUnsettledMailMove(client, itemId))))
    return { itemId, created };

  // Observations never replace a desired user value awaiting write-back. A new message gets
  // matching desired and current state; a known one goes through applyObservedMailMessageFlags.
  if (input.flags) {
    if (created) {
      const flags = messageFlagProperties(input.flags);
      await recordObservedMailMessageFlags(client, itemId, {
        read: flags.read ?? false,
        flagged: flags.flagged ?? false,
      });
    } else {
      await applyObservedMailMessageFlags(client, {
        emailsDatabaseId: input.emailsDatabaseId,
        messageItemId: itemId,
        folderItemId: input.folderItemId,
        flags: input.flags,
      });
    }
  }

  await createRelationWithClient(
    client,
    {
      relationPropertyId: input.folderRelationPropertyId,
      callerItemId: itemId,
      targetItemId: input.folderItemId,
      metadata: input.folderUid !== undefined ? { uid: input.folderUid } : {},
    },
    EMAILS_RELATION_CONTEXT,
  );

  // Needs the folder edge to tell inbound mail from own mail and drafts. Triage is delayed so the
  // inherited company/project is set first, and is a model call, so backfilled history gets none.
  if (created) {
    const firstInboundThreadItemId = await enqueueThreadLinkRulesForFirstInbound(client, itemId);
    if (firstInboundThreadItemId !== null && input.arrival === "live")
      await enqueueThreadProjectTriage(client, firstInboundThreadItemId);
  }

  return { itemId, created };
}
