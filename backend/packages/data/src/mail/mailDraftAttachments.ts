// Attaches files to and detaches them from a mail draft through the `Emails.attachments` relation, written with
// `EMAILS_RELATION_CONTEXT` because the Emails module owns it. A Files item belongs to one email only, so a file that
// another email holds is copied into a new Files item over the same blob.
import type { PoolClient } from "pg";
import { z } from "zod";
import { getBlob } from "../blobs/blobsStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getItemById, lockItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import {
  announceDraftThreadChanged,
  lockUnsentDraft,
  MailAttachmentTooLargeError,
  readEmailDraft,
  type EmailDraftView,
  type MailDraftWriteContext,
} from "./draft.js";
import { listAttachmentOwners, listDraftAttachments } from "./mailDraftAttachmentFiles.js";
import { updateMailDraft } from "./mailDraftsStore.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";

const MEBIBYTE = 1024 * 1024;

/**
 * Total attachment limit per mailbox `provider` (MB = 1024 * 1024 bytes, like `MAX_FILE_SIZE_MB`). Any other
 * provider falls back to `uploadLimitBytes`.
 */
const PROVIDER_ATTACHMENT_LIMIT_BYTES: Readonly<Record<string, number>> = {
  gmail: 25 * MEBIBYTE,
  outlook: 20 * MEBIBYTE,
  icloud: 20 * MEBIBYTE,
};

export interface AttachFileToDraftInput {
  draftItemId: string;
  fileItemId: string;
  uploadLimitBytes: number;
}

export interface DetachFileFromDraftInput {
  draftItemId: string;
  fileItemId: string;
}

const fileContent = z.object({ blobId: z.uuid() });
const fileName = z.string().catch("");

async function readFileBlob(client: PoolClient, file: ItemRow): Promise<{ blobId: string; byteSize: number }> {
  const content = fileContent.safeParse(file.properties.file);
  const blob = content.success ? await getBlob(client, content.data.blobId) : null;
  if (!blob) throw new ValidationError("The file has no stored content", { field: "fileItemId" });
  return { blobId: blob.id, byteSize: Number(blob.byteSize) };
}

async function attachmentsPropertyId(client: PoolClient, emailsDatabaseId: string): Promise<string> {
  const property = await getPropertyByKey(client, emailsDatabaseId, "attachments");
  if (!property) throw new Error("Email module schema is missing the attachments relation property");
  return property.id;
}

/**
 * Attaches a Files item to an unsent draft and returns the draft's view. Refusals (nothing written): those of
 * `lockUnsentDraft`, 404 for an unknown file or mailbox, 400 for a file with no stored content, 413
 * `mail_attachment_too_large` over the provider limit.
 *
 * A file another email holds is copied (new Files item over the same blob) so the other message keeps it. Locks the
 * draft, then its row, then the file, in the order `discardEmailDraft` takes them, so two drafts cannot both take one
 * file. Announces the change on the draft's thread after the commit.
 */
export async function attachFileToDraft(
  client: PoolClient,
  input: AttachFileToDraftInput,
  context: MailDraftWriteContext,
): Promise<EmailDraftView> {
  const ids = await resolveMailModuleIds(client);
  const { draft } = await lockUnsentDraft(client, ids.emailsDatabaseId, input.draftItemId);
  const file = await lockItemById(client, ids.filesDatabaseId, input.fileItemId);
  if (!file || file.deletedAt) throw new NotFoundError("File not found");
  const owners = await listAttachmentOwners(client, ids.emailsDatabaseId, file.id);
  if (owners.includes(input.draftItemId)) return readEmailDraft(client, input.draftItemId);

  const blob = await readFileBlob(client, file);
  const attached = await listDraftAttachments(client, ids, input.draftItemId);
  // A held file is copied on every post, so a retry must not copy it again: a listed file with the same name and
  // blob is the earlier copy.
  const name = fileName.parse(file.properties.name);
  if (owners.length > 0 && attached.some((a) => a.blobId === blob.blobId && a.filename === name))
    return readEmailDraft(client, input.draftItemId);
  const mailbox = await getItemById(client, ids.mailboxesDatabaseId, draft.mailboxItemId);
  if (!mailbox || mailbox.deletedAt) throw new NotFoundError("Mailbox not found");
  const provider = mailbox.properties.provider;
  const limitBytes =
    (typeof provider === "string" ? PROVIDER_ATTACHMENT_LIMIT_BYTES[provider] : undefined) ?? input.uploadLimitBytes;
  const totalBytes = attached.reduce((sum, attachment) => sum + attachment.byteSize, blob.byteSize);
  if (totalBytes > limitBytes) throw new MailAttachmentTooLargeError(limitBytes, totalBytes);

  const target =
    owners.length === 0
      ? file
      : await createItemWithClient(
          client,
          {
            databaseId: ids.filesDatabaseId,
            properties: { name, file: { blobId: blob.blobId } },
          },
          {
            writer: context.writer,
            actingUserId: context.actingUserId,
            humanWriterUserId: context.writer.writerKind === "user" ? context.actingUserId : undefined,
            queueAffinity: context.queueAffinity,
          },
        );
  await createRelationWithClient(
    client,
    {
      relationPropertyId: await attachmentsPropertyId(client, ids.emailsDatabaseId),
      callerItemId: input.draftItemId,
      targetItemId: target.id,
    },
    EMAILS_RELATION_CONTEXT,
    context.writer,
    context.actingUserId,
  );
  await updateMailDraft(client, input.draftItemId, { lastEditedBy: context.writer.writerKind });
  await announceDraftThreadChanged(client, draft.threadId);
  return readEmailDraft(client, input.draftItemId);
}

/**
 * Removes the attachment edge between an unsent draft and a Files item (the Files item stays) and returns the draft's
 * view. A file not attached to the draft is a 404, whatever the reason. Announces the change after the commit.
 */
export async function detachFileFromDraft(
  client: PoolClient,
  input: DetachFileFromDraftInput,
  context: MailDraftWriteContext,
): Promise<EmailDraftView> {
  const { emailsDatabaseId } = await resolveMailModuleIds(client);
  const { draft } = await lockUnsentDraft(client, emailsDatabaseId, input.draftItemId);
  const removed = await deleteRelationWithClient(
    client,
    {
      relationPropertyId: await attachmentsPropertyId(client, emailsDatabaseId),
      callerItemId: input.draftItemId,
      targetItemId: input.fileItemId,
    },
    EMAILS_RELATION_CONTEXT,
    context.writer,
    context.actingUserId,
  );
  if (removed === null) throw new NotFoundError("Attachment not found");
  await updateMailDraft(client, input.draftItemId, { lastEditedBy: context.writer.writerKind });
  await announceDraftThreadChanged(client, draft.threadId);
  return readEmailDraft(client, input.draftItemId);
}
