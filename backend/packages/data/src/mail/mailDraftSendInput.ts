// Reads one saved Semprec draft into the input `sendDraftEmail` takes (issue gh-1896), in the caller's transaction and
// tenant. The send route (mail/mailDraftSend.ts) and the approval of an agent's send (mail/mailSendApproval.ts, issue
// gh-1913) both build what is sent, or what is approved, from here, so that the two cannot describe different drafts.
// Constrained by: docs/adr/2026-11-13-a-discarded-mail-draft-loses-its-row-and-draft-writers-lock-the-item-before-the-row.md
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

/** What `sendDraftEmail` is given for a draft, the ids of the mail module it needs, and the mailbox the draft leaves from. */
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
 * The thread a sent draft's message is in: its `mail_message_meta` row's thread, translated to the live thread when it
 * was merged away, and the draft's own thread for a draft whose row says it was sent but has no such message (a
 * draft marked sent by something other than `sendDraftEmail`). `null` when neither exists.
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
 * The reply headers of a draft in mode `reply` or `replyAll`: `In-Reply-To` is the Message-ID of its source message
 * and `References` that message's own references followed by it. The provider's conversation id comes along only
 * from a source message of the draft's own mailbox, since another mailbox's id names a conversation this one does
 * not have. A draft in another mode, without a source message or whose source has no `mail_message_meta` row carries
 * none of them.
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
 * `sendDraftEmail` needs, in the caller's transaction and tenant. The refusals are, in this order: 404 for an id that
 * names no live Emails item (another tenant's included), 409 `mail_draft_not_editable` for an item without a row,
 * 409 `mail_draft_already_sent` with `{ emailId, threadId }` for a sent draft, 400 for a draft with no recipient in
 * To, Cc or Bcc, 404 for a mailbox that is gone. The sender, the mailbox's state and its Sent folder are checked by
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
      // The keys the email module seeds (seed/seedEmailModule.ts).
      senderPeopleKey: "senderPeople",
      recipientsPeopleKey: "recipientsPeople",
    },
    input: {
      mailboxItemId: draft.mailboxItemId,
      draftItemId,
      // The send route is for the user; an agent's send goes through approval (issue gh-1913).
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
