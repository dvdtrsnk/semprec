import type { PoolClient } from "pg";
import sanitizeHtml from "sanitize-html";
import { createItemWithClient, createRelationWithClient } from "../chokePoint/chokePoint.js";
import { resolveThreadId } from "./threading.js";
import { getMailMessageMetaByMessageId, upsertMailMessageMeta, type MailEnvelope, type MailEnvelopeAddress } from "./mailMessageMetaStore.js";
import { ingestAttachments, type ClassifiedAttachment } from "./attachments.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import { reindexItemSearch } from "./search.js";
import { resolveDeliveredToAddress } from "./deliveredTo.js";

function formatAddress(address: MailEnvelopeAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

function formatAddressList(list: MailEnvelopeAddress[] | undefined): string {
  return (list ?? []).map(formatAddress).join(", ");
}

/** Plain-text approximation of an HTML-only body for the search index (search.ts) — an HTML-only message has no `bodyText` at all, so indexing only the subject would silently miss every word that's only in the visible body. */
function htmlToSearchText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
}

/** Every Emails property this issue defines is `owner: 'system'` (see seedEmailModule.ts) — the sync worker mirrors the real mailbox, so nothing here is user-editable. */
export const EMAIL_INGEST_ALLOWED_SYSTEM_KEYS = ["name", "sender", "recipients", "body", "date"];

export interface IngestEmailMessageInput {
  emailsDatabaseId: string;
  filesDatabaseId: string;
  folderRelationPropertyId: string;
  attachmentsRelationPropertyId: string;
  folderItemId: string;
  /** IMAP adapter only — the UID this message has *in this folder*; lives on the relation edge, not the item (see the migration's header note). */
  folderUid?: number;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  subject?: string;
  envelope: MailEnvelope;
  bodyText?: string;
  bodyHtml?: string;
  date?: Date;
  providerThreadId?: string | null;
  providerMessageId?: string | null;
  attachments: ClassifiedAttachment[];
  storage: BlobStorageWriter;
  storageKeyPrefix: string;
  /** This mailbox's registered addresses (`Mailboxes.addresses`) — the alias-fallback and primary-address steps of deliveredToAddress's precedence rule (mail/deliveredTo.ts). Defaults to `[]` for direct test calls that don't exercise that fallback. */
  mailboxAliases?: string[];
  /** Raw deliveredToAddress candidates (mail/deliveredTo.ts) — see FetchedMessage's header note (providerTypes.ts). */
  deliveredToHeaders?: string[];
  xOriginalTo?: string | null;
  envelopeTo?: string | null;
  /** True for a multipart/report;report-type=delivery-status DSN/bounce (mail/dsn.ts) — distinguished from an ordinary human reply. */
  isDsn?: boolean;
}

export interface IngestEmailMessageResult {
  itemId: string;
  /** false when this call converged onto an already-ingested message (dedup by Message-ID/provider id) instead of creating a new item. */
  created: boolean;
}

/**
 * The single writer shared by all three sync adapters (imap/gmail/graph) — see the
 * migration's and mail/threading.ts's header notes for why this is the one place messages
 * become Emails items. Dedups by `Message-ID` (an optimistic outgoing insert from issue #27
 * or a re-observed message on a second sync pass both converge onto the same item instead of
 * duplicating), resolves/updates the conversation thread, links the message into the given
 * folder (always — even for an already-known message, since the same message can appear in
 * a newly-observed folder), ingests attachments, and reindexes full-text search. Must be
 * called inside a transaction: the Emails item write and the `mail_message_meta` write need
 * to commit together for the onItemEvent person-linking trigger (personLinkingActions.ts) to
 * see a consistent envelope once its enqueued job actually runs.
 */
export async function ingestEmailMessage(client: PoolClient, input: IngestEmailMessageInput): Promise<IngestEmailMessageResult> {
  const existing = await getMailMessageMetaByMessageId(client, input.messageId);
  let itemId: string;
  let created = false;

  if (existing) {
    itemId = existing.itemId;
  } else {
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
          body: input.bodyHtml ?? input.bodyText ?? "",
          ...(input.date ? { date: input.date.toISOString() } : {}),
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

    // RFC 3464: a DSN's own References/In-Reply-To name the outgoing message it reports on —
    // the same ancestor threading.ts just resolved from, reused here as "the original message"
    // rather than a second parsing rule for the identical header.
    const dsnOriginalMessageId = input.isDsn ? (input.inReplyTo ?? input.references?.[input.references.length - 1] ?? null) : null;

    await upsertMailMessageMeta(client, {
      itemId,
      messageId: input.messageId,
      inReplyTo: input.inReplyTo,
      references: input.references,
      threadId,
      providerThreadId: input.providerThreadId,
      providerMessageId: input.providerMessageId,
      envelope: input.envelope,
      deliveredToAddress: deliveredToAddress ?? null,
      messageKind: input.isDsn ? "dsn" : "message",
      dsnOriginalMessageId,
    });

    const { extractedTexts } = await ingestAttachments(client, {
      messageItemId: itemId,
      filesDatabaseId: input.filesDatabaseId,
      attachmentsRelationPropertyId: input.attachmentsRelationPropertyId,
      attachments: input.attachments,
      storage: input.storage,
      storageKeyPrefix: input.storageKeyPrefix,
    });

    // PDF/DOCX attachment text (issue #26: "the output goes into the same index table") is
    // folded into the owning message's own search text rather than indexed as a separate
    // item — there is no per-attachment search surface in this issue's scope, only "search my
    // mail," which a PDF invoice's contents should still match.
    const bodyForSearch = input.bodyText ?? (input.bodyHtml ? htmlToSearchText(input.bodyHtml) : "");
    await reindexItemSearch(client, {
      itemId,
      databaseId: input.emailsDatabaseId,
      text: [input.subject ?? "", bodyForSearch, ...extractedTexts].join("\n\n"),
    });
  }

  await createRelationWithClient(client, {
    relationPropertyId: input.folderRelationPropertyId,
    itemId,
    targetItemId: input.folderItemId,
    metadata: input.folderUid !== undefined ? { uid: input.folderUid } : {},
  });

  return { itemId, created };
}
