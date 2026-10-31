import type { PoolClient } from "pg";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import type { ItemRow } from "../types.js";
import { EMAIL_INGEST_ALLOWED_SYSTEM_KEYS, formatAddress, formatAddressList } from "./ingest.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { insertMailDraft, type InsertMailDraftInput } from "./mailDraftsStore.js";

export interface CreateEmailDraftInput {
  emailsDatabaseId: string;
  folderRelationPropertyId: string;
  draftsFolderItemId: string;
  subject?: string;
  from?: MailEnvelopeAddress;
  to?: MailEnvelopeAddress[];
  bodyText?: string;
  bodyHtml?: string;
  /** The `date` of the Email item; defaults to now. */
  date?: Date;
  /**
   * Structured metadata. When given, the `mail_drafts` row is written on the same client as the
   * item and its Drafts folder edge, so the caller must run inside one transaction. Without it no
   * row is written and the draft stays a plain Email (read-only for Semprec).
   */
  metadata?: Omit<InsertMailDraftInput, "emailItemId">;
}

/**
 * `email.draft.create` (issue #95): the generic item-create path, with no authorization check
 * at all — "drafting is safe for agents," unlike `email.send` (mail/send.ts), which is gated
 * on `capabilities.email.send.autonomous`. Reuses ingest.ts's `EMAIL_INGEST_ALLOWED_SYSTEM_KEYS`:
 * a draft populates the exact same owner:'system' display fields a synced message does, this
 * function is just a second declared writer of those fields (see seedEmailModule.ts). Carries
 * no Message-ID/mail_message_meta row — that's only generated once the draft is actually sent
 * (mail/send.ts), matching real Message-ID semantics. The draft is created with `read: true` (issue #1461):
 * the user wrote it, and sending keeps this same item, so the item stays read. The `is:unread` search also
 * leaves Drafts and Sent messages out; see `DRAFTS_AND_SENT_SPECIAL_PURPOSES` in messageFlags.ts.
 */
export async function createEmailDraft(client: PoolClient, input: CreateEmailDraftInput): Promise<ItemRow> {
  const item = await createItemWithClient(
    client,
    {
      databaseId: input.emailsDatabaseId,
      properties: {
        name: input.subject ?? "(no subject)",
        sender: input.from ? formatAddress(input.from) : "",
        recipients: formatAddressList(input.to ?? input.metadata?.to),
        body: input.bodyHtml ?? input.bodyText ?? "",
        date: (input.date ?? new Date()).toISOString(),
        read: true,
      },
    },
    { allowedSystemKeys: EMAIL_INGEST_ALLOWED_SYSTEM_KEYS },
  );

  await createRelationWithClient(
    client,
    {
      relationPropertyId: input.folderRelationPropertyId,
      callerItemId: item.id,
      targetItemId: input.draftsFolderItemId,
    },
    EMAILS_RELATION_CONTEXT,
  );

  if (input.metadata) await insertMailDraft(client, { ...input.metadata, emailItemId: item.id });

  return item;
}
