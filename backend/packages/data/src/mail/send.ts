import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { createRelationWithClient, deleteRelationWithClient, updateItemWithClient } from "../chokePoint/chokePoint.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import type { PermissionManifest } from "../manifest/permissionManifest.js";
import { EMAIL_INGEST_ALLOWED_SYSTEM_KEYS, formatAddress, formatAddressList } from "./ingest.js";
import { findFolderBySpecialPurpose } from "./folderDiscovery.js";
import { upsertMailMessageMeta, type MailEnvelope, type MailEnvelopeAddress } from "./mailMessageMetaStore.js";
import type { MailSmtpClient } from "./smtpClient.js";

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
 * (mail/mailSyncJob.ts). A real composition root supplies its own factory (`NodemailerSmtpClient`,
 * mail/smtpClient.ts, wrapping an already-authenticated `nodemailer` transport).
 */
export interface MailSendAdapterFactory {
  createSmtpClient?: (mailboxItemId: string, credential: string) => MailSmtpClient | Promise<MailSmtpClient>;
}

export const noopMailSendAdapterFactory: MailSendAdapterFactory = {};

export interface SendEmailModuleIds {
  emailsDatabaseId: string;
  foldersDatabaseId: string;
  /** Emails.folder relation property id. */
  folderRelationPropertyId: string;
  /** Folders.mailbox relation property id. */
  mailboxFolderRelationPropertyId: string;
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

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "semprec.local" : address.slice(at + 1);
}

/** RFC 5322 §3.6.4: generated only at send time, never at draft creation — a draft has no Message-ID until it is actually submitted (epic #92). */
function generateOutgoingMessageId(fromAddress: string): string {
  return `<${randomUUID()}@${domainOf(fromAddress)}>`;
}

/** Drops this item's membership in any folder with the given `specialPurpose` — used to remove the Drafts edge once a draft becomes Sent. */
async function unlinkFromFoldersWithSpecialPurpose(
  client: PoolClient,
  input: { foldersDatabaseId: string; folderRelationPropertyId: string; itemId: string; specialPurpose: string },
): Promise<void> {
  const reldef = await getRelationDefinitionByPropertyId(client, input.folderRelationPropertyId);
  if (!reldef) return;
  const edges = await listRelationsForItem(client, reldef.id, input.itemId);
  for (const edge of edges) {
    const folderId = otherSide(edge, input.itemId);
    const folder = await getItemById(client, input.foldersDatabaseId, folderId);
    if (folder?.properties.specialPurpose === input.specialPurpose) {
      await deleteRelationWithClient(client, { relationPropertyId: input.folderRelationPropertyId, itemId: input.itemId, targetItemId: folderId });
    }
  }
}

/**
 * `email.send` (issue #95). Authorization is checked first, synchronously, before any SMTP
 * call or database write — see `assertEmailSendAuthorized`. Once authorized, submits over SMTP
 * exactly once, then optimistically finalizes the existing draft item into the mailbox's Sent
 * folder and gives it a real Message-ID via `upsertMailMessageMeta` — the same table/dedup key
 * `ingestEmailMessage` (mail/ingest.ts) checks first, so the next IMAP/Gmail/Graph reconcile
 * pass that later observes this same Message-ID in the real Sent folder converges onto this
 * item instead of duplicating it.
 */
export async function sendDraftEmail(
  pool: Pool,
  input: SendEmailInput,
  moduleIds: SendEmailModuleIds,
  adapters: MailSendAdapterFactory,
): Promise<SendEmailResult> {
  assertEmailSendAuthorized(input.actor);

  const draft = await withTransaction(pool, (client) => getItemById(client, moduleIds.emailsDatabaseId, input.draftItemId));
  if (!draft) throw new NotFoundError(`Draft ${input.draftItemId} not found`);

  const sentFolderItemId = await withTransaction(pool, (client) =>
    findFolderBySpecialPurpose(client, {
      foldersDatabaseId: moduleIds.foldersDatabaseId,
      mailboxRelationPropertyId: moduleIds.mailboxFolderRelationPropertyId,
      mailboxItemId: input.mailboxItemId,
      specialPurpose: "sent",
    }),
  );
  if (!sentFolderItemId) {
    throw new ValidationError(`Mailbox ${input.mailboxItemId} has no Sent folder yet — sync the account before sending`);
  }

  if (!adapters.createSmtpClient) throw new Error("No SMTP adapter configured for this composition root");
  // Passed `pool` directly, not wrapped in `withTransaction` (mirrors mailSyncJob.ts's own
  // credential fetch): the access-log insert inside getDecryptedCredential must survive even
  // if decryption itself fails.
  const credential = await getDecryptedCredential(pool, { itemId: input.mailboxItemId, actorType: "smtp_send", purpose: "email_send" });
  if (!credential) throw new Error(`Mailbox ${input.mailboxItemId} has no stored credential`);
  const smtp = await adapters.createSmtpClient(input.mailboxItemId, credential);

  const messageId = generateOutgoingMessageId(input.from.address);
  await smtp.sendMail({
    from: input.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.bodyText,
    html: input.bodyHtml,
    messageId,
    inReplyTo: input.inReplyTo,
    references: input.references,
  });

  const envelope: MailEnvelope = { from: input.from, to: input.to, cc: input.cc, bcc: input.bcc };

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
    await createRelationWithClient(client, {
      relationPropertyId: moduleIds.folderRelationPropertyId,
      itemId: input.draftItemId,
      targetItemId: sentFolderItemId,
    });

    await upsertMailMessageMeta(client, {
      itemId: input.draftItemId,
      messageId,
      envelope,
      inReplyTo: input.inReplyTo,
      references: input.references,
    });

    return { itemId: input.draftItemId, messageId };
  });
}
