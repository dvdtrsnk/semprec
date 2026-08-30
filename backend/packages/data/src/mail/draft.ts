import type { PoolClient } from "pg";
import { createItemWithClient, createRelationWithClient } from "../chokePoint/chokePoint.js";
import type { ItemRow } from "../types.js";
import { EMAIL_INGEST_ALLOWED_SYSTEM_KEYS, formatAddress, formatAddressList } from "./ingest.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";

export interface CreateEmailDraftInput {
  emailsDatabaseId: string;
  folderRelationPropertyId: string;
  draftsFolderItemId: string;
  subject?: string;
  from?: MailEnvelopeAddress;
  to?: MailEnvelopeAddress[];
  bodyText?: string;
  bodyHtml?: string;
}

/**
 * `email.draft.create` (issue #95): the generic item-create path, with no authorization check
 * at all — "drafting is safe for agents," unlike `email.send` (mail/send.ts), which is gated
 * on `capabilities.email.send.autonomous`. Reuses ingest.ts's `EMAIL_INGEST_ALLOWED_SYSTEM_KEYS`:
 * a draft populates the exact same owner:'system' display fields a synced message does, this
 * function is just a second declared writer of those fields (see seedEmailModule.ts). Carries
 * no Message-ID/mail_message_meta row — that's only generated once the draft is actually sent
 * (mail/send.ts), matching real Message-ID semantics.
 */
export async function createEmailDraft(client: PoolClient, input: CreateEmailDraftInput): Promise<ItemRow> {
  const item = await createItemWithClient(
    client,
    {
      databaseId: input.emailsDatabaseId,
      properties: {
        name: input.subject ?? "(no subject)",
        sender: input.from ? formatAddress(input.from) : "",
        recipients: formatAddressList(input.to),
        body: input.bodyHtml ?? input.bodyText ?? "",
      },
    },
    { allowedSystemKeys: EMAIL_INGEST_ALLOWED_SYSTEM_KEYS },
  );

  await createRelationWithClient(client, {
    relationPropertyId: input.folderRelationPropertyId,
    itemId: item.id,
    targetItemId: input.draftsFolderItemId,
  });

  return item;
}
