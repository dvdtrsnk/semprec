// Adds a file to a mail draft and removes it again (issue gh-1895). The edge is the relation `Emails.attachments`, which
// the Emails module owns, so it is written with `EMAILS_RELATION_CONTEXT`; a Files item belongs to one email only, so
// a file that another email holds is copied into a new Files item over the same blob. The view of a draft and the
// cleanup of a discarded one are in `mailDraftAttachmentFiles.ts`, which `draft.ts` shares.
// Constrained by: docs/adr/2026-09-10-choke-point-api-for-state-writes.md,
// docs/adr/2026-09-10-side-effects-follow-the-commit.md,
// docs/adr/2026-11-13-a-discarded-mail-draft-loses-its-row-and-draft-writers-lock-the-item-before-the-row.md,
// docs/adr/2026-11-14-a-mail-draft-attaches-copies-of-held-files-and-trashes-the-files-that-are-its-own.md
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
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";

const MEBIBYTE = 1024 * 1024;

/**
 * The most a draft's attachments may weigh in total, by the `provider` of its mailbox (the Mailboxes select values
 * of `seedEmailModule.ts`): Gmail 25 MB, Outlook.com 20 MB and iCloud 20 MB, a megabyte counted as 1024 * 1024
 * bytes like `MAX_FILE_SIZE_MB`. A generic mailbox, and a provider that is none of these, has the upload limit of
 * `POST /api/files` instead (`attachFileToDraft`'s `uploadLimitBytes`).
 */
const PROVIDER_ATTACHMENT_LIMIT_BYTES: Readonly<Record<string, number>> = {
  gmail: 25 * MEBIBYTE,
  outlook: 20 * MEBIBYTE,
  icloud: 20 * MEBIBYTE,
};

export interface AttachFileToDraftInput {
  draftItemId: string;
  fileItemId: string;
  /** The limit for a mailbox without a provider limit: `MAX_FILE_SIZE_MB` of the composition root, in bytes. */
  uploadLimitBytes: number;
}

export interface DetachFileFromDraftInput {
  draftItemId: string;
  fileItemId: string;
}

const fileContent = z.object({ blobId: z.uuid() });
/** The name a Files item has; a file without one is copied with an empty name. */
const fileName = z.string().catch("");

/** The blob a Files item holds and its size, or a 400 for a file that has none stored. */
async function readFileBlob(client: PoolClient, file: ItemRow): Promise<{ blobId: string; byteSize: number }> {
  const content = fileContent.safeParse(file.properties.file);
  const blob = content.success ? await getBlob(client, content.data.blobId) : null;
  if (!blob) throw new ValidationError("The file has no stored content", { field: "fileItemId" });
  return { blobId: blob.id, byteSize: Number(blob.byteSize) };
}

/** The attachments relation property of Emails, which both the attach and the detach write through. */
async function attachmentsPropertyId(client: PoolClient, emailsDatabaseId: string): Promise<string> {
  const property = await getPropertyByKey(client, emailsDatabaseId, "attachments");
  if (!property) throw new Error("Email module schema is missing the attachments relation property");
  return property.id;
}

/**
 * Attaches the Files item `input.fileItemId` to the unsent draft `input.draftItemId` in the caller's transaction and
 * tenant, and returns the draft's view. The refusals are, in order: the draft's own (`lockUnsentDraft`: 404, 409
 * `mail_draft_not_editable`, 409 `mail_draft_already_sent`), a 404 for a file that is not a live Files item of the
 * tenant (another tenant's item included), a 400 for a file with no stored content, a 404 for a mailbox that is
 * gone, and a 413 `mail_attachment_too_large` when the draft's attachments and the file together would weigh more
 * than the limit of the mailbox's provider. Nothing is written for a refusal.
 *
 * A file that is attached to the draft already changes nothing. A file that another email holds stays with that
 * email: a new Files item over the same blob is created and attached instead, so the other message keeps its
 * attachment. Posting such a file again changes nothing either, once the draft lists a file of its name over its
 * blob, so a retry does not add a second copy or count its size twice. A file that no email holds is attached
 * itself. The draft, then its row, then the file are locked, in the order `discardEmailDraft` takes them, so two
 * attaches of one file to two drafts do not both take it.
 *
 * After the commit it announces the change on the draft's thread, when it has one.
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
  // A file that another email holds is copied on every post, so a retry of the post must not copy it again: the draft
  // that lists a file of the same name over the same blob has the copy already.
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
  await announceDraftThreadChanged(client, draft.threadId);
  return readEmailDraft(client, input.draftItemId);
}

/**
 * Removes the attachment edge between the unsent draft `input.draftItemId` and the Files item `input.fileItemId` in
 * the caller's transaction and tenant, and returns the draft's view. The Files item itself stays. The refusals are
 * those of `lockUnsentDraft` and a 404 for a file that is not attached to the draft, which is the answer for an
 * unknown id, another tenant's item and a file of another email alike. After the commit it announces the change
 * on the draft's thread, when it has one.
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
  await announceDraftThreadChanged(client, draft.threadId);
  return readEmailDraft(client, input.draftItemId);
}
