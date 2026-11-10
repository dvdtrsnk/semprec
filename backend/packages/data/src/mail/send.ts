import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import type { PermissionManifest } from "../manifest/permissionManifest.js";
import { EMAIL_INGEST_ALLOWED_SYSTEM_KEYS, formatAddress, formatAddressList } from "./ingest.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { findFolderBySpecialPurpose } from "./folderDiscovery.js";
import { linkEmailEnvelopeToPeople } from "./personLinkingActions.js";
import {
  deleteMailMessageMetaByItemId,
  upsertMailMessageMeta,
  type MailEnvelope,
  type MailEnvelopeAddress,
} from "./mailMessageMetaStore.js";
import { getMailAccountSyncState, defaultSyncModeForProvider } from "./mailAccountSyncStateStore.js";
import { resolveThreadId } from "./threading.js";
import { buildMailPreviewFromBody } from "./mailPlainText.js";
import { parseAddressListProperty } from "./addressListParsing.js";
import { normalizeEmailAddress } from "./personEmailIndexStore.js";
import { buildOutgoingMime, generateOutgoingMessageId, type OutgoingMimeDeps } from "./outgoingMime.js";
import type { MailTransportFactory } from "./mailTransport.js";

/**
 * The choke point's actor distinction for `email.send` (issue #95, epic #92's "Enforcement
 * mechanics"): a server-derived authenticated user session always sends directly; an
 * `ai_agent` actor additionally needs the Email project's generated permission manifest to
 * carry `capabilities.email.send.autonomous`. Mirrors `assertViewWritable`'s `actor: CreatedBy`
 * shape (chokePoint.ts) rather than inventing a parallel vocabulary.
 */
export type SendEmailActor = { type: "user" } | { type: "ai_agent"; manifest: PermissionManifest };

/**
 * Checked before any SMTP call or draft mutation: without the grant, this throws and the
 * caller never reaches either — the draft is left exactly as it was, visible/sendable by the
 * user through the Mailbox UI, and no approval-queue row is created (that queue is for
 * per-instance decisions on risky calls, not a whole-project authorization already decided in
 * advance — epic #92).
 */
export function assertEmailSendAuthorized(actor: SendEmailActor): void {
  if (actor.type === "user") return;
  if (actor.manifest.capabilities.email.send.autonomous === true) return;
  throw new ForbiddenError(
    "Sending requires the Email project's permission manifest to grant capabilities.email.send.autonomous",
    { field: "capabilities.email.send.autonomous" },
    "email_send_not_autonomous",
  );
}

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
}

export interface SendEmailResult {
  itemId: string;
  messageId: string;
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
 * `email.send` (issue #95). Authorization is checked first, synchronously, before any SMTP
 * call or database write — see `assertEmailSendAuthorized`. Once authorized, this atomically
 * *claims* the draft for sending (see below) before ever calling SMTP, submits over SMTP, then
 * on success finalizes the draft item into the mailbox's Sent folder and links its addresses to
 * Persons (`linkEmailEnvelopeToPeople`, issue #1480) in that same transaction; on SMTP failure it
 * undoes the claim so a genuine retry can still send.
 *
 * The claim is `upsertMailMessageMeta` itself, moved to run *before* the transport's `send` instead of
 * after — `mail_message_meta.item_id` is this table's primary key (one row per Email item), so
 * two concurrent calls for the same draft can't both win it: the loser's INSERT fails with a
 * primary-key violation (each call's `message_id` is a fresh random UUID, so `ON CONFLICT
 * (mailbox_item_id, message_id)` never itself fires here — it's the `item_id` PK that arbitrates), which this
 * function turns into a `ConflictError` before ever reaching SMTP. This also closes the
 * sequential-retry version of the same race: a retry after a transient failure downstream of a
 * successful send (the finalize transaction failing, a network partition) still finds the claim
 * from the original call and is rejected, instead of re-sending with a brand-new Message-ID.
 * `ingestEmailMessage` (mail/ingest.ts) checks this same table/dedup key (per mailbox — hence
 * the claim carries `mailboxItemId`), so the next IMAP/Gmail/Graph reconcile pass of this mailbox that later observes this Message-ID in the real Sent folder
 * converges onto this item instead of duplicating it.
 */
export async function sendDraftEmail(
  pool: Pool,
  input: SendEmailInput,
  moduleIds: SendEmailModuleIds,
  adapters: MailSendAdapterFactory,
): Promise<SendEmailResult> {
  assertEmailSendAuthorized(input.actor);

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

  // Without this, any actor (including a granted-autonomous agent) could set an arbitrary
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
  if (!sentFolderItemId) {
    throw new ValidationError(
      `Mailbox ${input.mailboxItemId} has no Sent folder yet — sync the account before sending`,
    );
  }

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
      // Resolved in the claim transaction and before the claim row exists (see resolveThreadId),
      // so a rolled-back claim also rolls back any thread created here.
      const threadId = await resolveThreadId(client, {
        messageId,
        inReplyTo: input.inReplyTo,
        references: input.references,
        subjectHint: input.subject,
      });
      await upsertMailMessageMeta(client, {
        itemId: input.draftItemId,
        mailboxItemId: input.mailboxItemId,
        messageId,
        threadId,
        envelope,
        inReplyTo: input.inReplyTo,
        references: input.references,
        previewText: buildMailPreviewFromBody(input.bodyText, input.bodyHtml),
        ingestedAt: new Date(),
      });
    });
  } catch (err) {
    if (isItemAlreadyClaimedError(err)) {
      throw new ConflictError(`Draft ${input.draftItemId} is already being sent or was already sent`);
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
      },
      { client: pool, files: attachmentStorage.files, mailAttachments: attachmentStorage.mailAttachments },
    );
    await transport.send({
      raw: mime.raw,
      envelope: { from: input.from.address, recipients: mime.envelopeRecipients },
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
          date: new Date().toISOString(),
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

    return { itemId: input.draftItemId, messageId };
  });
}
