// Reads one saved draft into the input `sendDraftEmail` takes. The send route and the approval of an agent's send both
// build from here, so they cannot describe different drafts.
import type { PoolClient } from "pg";
import { getBlob } from "../blobs/blobsStore.js";
import { getItemById, lockItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { MailDraftAlreadySentError, MailDraftNotEditableError } from "./draft.js";
import { listDraftAttachments } from "./mailDraftAttachmentFiles.js";
import { getMailDraft, type MailDraft } from "./mailDraftsStore.js";
import { getMailMessageMetaByItemId, resolveMergedThreadId } from "./mailMessageMetaStore.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import { OutgoingAttachmentMissingError, type OutgoingAttachmentInput } from "./outgoingMime.js";
import type { SendEmailModuleIds, UserSendEmailInput } from "./send.js";

export interface PreparedSend {
  input: UserSendEmailInput;
  moduleIds: SendEmailModuleIds;
  mailbox: { id: string; name: string };
}

function textProperty(item: ItemRow, key: string): string {
  const value = item.properties[key];
  return typeof value === "string" ? value : "";
}

/**
 * The thread of a sent draft's message, translated to the live thread when merged away; falls back to the draft's own
 * thread when no such message exists (a draft marked sent elsewhere). `null` when neither exists.
 */
export async function sentThreadOf(
  client: PoolClient,
  draftItemId: string,
  draft: MailDraft | null,
): Promise<string | null> {
  const claimed = (await getMailMessageMetaByItemId(client, draftItemId))?.threadId ?? draft?.threadId ?? null;
  return claimed === null ? null : await resolveMergedThreadId(client, claimed);
}

interface ReplyContext {
  inReplyTo?: string;
  references?: string[];
  providerThreadId?: string;
}

/**
 * `In-Reply-To` and `References` of a `reply`/`replyAll` draft. The provider's conversation id is taken only from a
 * source of the draft's own mailbox, since another mailbox's id names a conversation this one does not have.
 */
async function replyContextOf(client: PoolClient, draft: MailDraft): Promise<ReplyContext> {
  if ((draft.mode !== "reply" && draft.mode !== "replyAll") || draft.sourceEmailItemId === null) return {};
  const source = await getMailMessageMetaByItemId(client, draft.sourceEmailItemId);
  if (source === null) return {};
  return {
    inReplyTo: source.messageId,
    references: [...new Set([...source.references, source.messageId])],
    ...(source.mailboxItemId === draft.mailboxItemId && source.providerThreadId !== null
      ? { providerThreadId: source.providerThreadId }
      : {}),
  };
}

/**
 * Locks the draft's Emails item and then its `mail_drafts` row (the order of every draft writer) and reads what
 * `sendDraftEmail` needs. Refusals, in order: 404 no live item, 409 `mail_draft_not_editable` without a row, 409
 * `mail_draft_already_sent`, 400 no recipient, 404 mailbox gone. Sender, mailbox state and Sent folder are checked by
 * `sendDraftEmail`.
 */
export async function prepareSend(client: PoolClient, draftItemId: string): Promise<PreparedSend> {
  const ids = await resolveMailModuleIds(client);
  const item = await lockItemById(client, ids.emailsDatabaseId, draftItemId);
  if (!item || item.deletedAt) throw new NotFoundError("Draft not found");
  const draft = await getMailDraft(client, draftItemId, true);
  if (!draft) throw new MailDraftNotEditableError();
  if (draft.sentAt !== null) {
    throw new MailDraftAlreadySentError({
      emailId: draftItemId,
      threadId: await sentThreadOf(client, draftItemId, draft),
    });
  }
  if (draft.to.length + draft.cc.length + draft.bcc.length === 0) {
    throw new ValidationError("The draft has no recipient", { field: "to" });
  }
  const mailbox = await getItemById(client, ids.mailboxesDatabaseId, draft.mailboxItemId);
  if (!mailbox || mailbox.deletedAt) throw new NotFoundError("Mailbox not found");

  const attachments: OutgoingAttachmentInput[] = [];
  for (const attachment of await listDraftAttachments(client, ids, draftItemId)) {
    const blob = await getBlob(client, attachment.blobId);
    if (!blob) throw new OutgoingAttachmentMissingError(attachment.blobId, attachment.filename);
    attachments.push({ filename: attachment.filename, contentType: blob.mimeType, blobId: attachment.blobId });
  }
  const reply = await replyContextOf(client, draft);
  const [folderProperty, mailboxFolderProperty] = await Promise.all([
    getPropertyByKey(client, ids.emailsDatabaseId, "folder"),
    getPropertyByKey(client, ids.foldersDatabaseId, "mailbox"),
  ]);
  if (!folderProperty || !mailboxFolderProperty) {
    throw new Error("Email module schema is missing an expected relation property");
  }

  return {
    mailbox: { id: mailbox.id, name: textProperty(mailbox, "name") },
    moduleIds: {
      emailsDatabaseId: ids.emailsDatabaseId,
      foldersDatabaseId: ids.foldersDatabaseId,
      mailboxesDatabaseId: ids.mailboxesDatabaseId,
      folderRelationPropertyId: folderProperty.id,
      mailboxFolderRelationPropertyId: mailboxFolderProperty.id,
      senderPeopleKey: "senderPeople",
      recipientsPeopleKey: "recipientsPeople",
    },
    input: {
      mailboxItemId: draft.mailboxItemId,
      draftItemId,
      // An agent's send goes through approval instead.
      actor: { type: "user" },
      from: { address: draft.fromAddress },
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: textProperty(item, "name"),
      bodyText: textProperty(item, "body"),
      attachments,
      ...reply,
    },
  };
}
