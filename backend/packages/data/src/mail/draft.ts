import type { PoolClient } from "pg";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { getItemById, lockItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { ChokePointError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { createActionQueueAffinity, type ActionQueueAffinity } from "../scheduler/actions.js";
import type { ItemRow } from "../types.js";
import { parseAddressListProperty } from "./addressListParsing.js";
import { EMAIL_INGEST_ALLOWED_SYSTEM_KEYS, formatAddress, formatAddressList } from "./ingest.js";
import { resolveMergedThreadId, type MailEnvelopeAddress } from "./mailMessageMetaStore.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { findFolderBySpecialPurpose } from "./folderDiscovery.js";
import {
  deleteMailDraft,
  getMailDraft,
  insertMailDraft,
  updateMailDraft,
  type InsertMailDraftInput,
  type MailDraft,
  type MailDraftActor,
  type MailDraftMode,
  type MailDraftRecipient,
} from "./mailDraftsStore.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import { deleteFilesOfDiscardedDraft, listDraftAttachments, type DraftAttachment } from "./mailDraftAttachmentFiles.js";
import { announceMailThreadChanged } from "./mailThreadActions.js";
import { normalizeEmailAddress } from "./personEmailIndexStore.js";

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
  /** Who writes the Emails item; defaults to the system writer, as for a synced message. */
  writer?: WriterIdentity;
  /** The user whose write this is: the item's create invalidation is addressed to them. Absent for a system caller. */
  actingUserId?: string;
  /** Set only for a human writer; read by the domain hooks that confine a write to humans. */
  humanWriterUserId?: string;
  queueAffinity?: ActionQueueAffinity;
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
    {
      allowedSystemKeys: EMAIL_INGEST_ALLOWED_SYSTEM_KEYS,
      writer: input.writer,
      actingUserId: input.actingUserId,
      humanWriterUserId: input.humanWriterUserId,
      queueAffinity: input.queueAffinity,
    },
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

/** Raised when a draft was sent already (`mail_drafts.sent_at` is set), so it can no longer be edited or discarded. */
export class MailDraftAlreadySentError extends ChokePointError {
  constructor() {
    super(409, "mail_draft_already_sent", "The draft was sent already");
    this.name = "MailDraftAlreadySentError";
  }
}

/**
 * Raised when a file would bring the total size of a draft's attachments over the limit of its mailbox's provider
 * (issue gh-1895). `details` carries the limit and the total the draft would have, both in bytes.
 */
export class MailAttachmentTooLargeError extends ChokePointError {
  constructor(limitBytes: number, totalBytes: number) {
    super(413, "mail_attachment_too_large", "The attachments of the draft would be larger than the mailbox allows", {
      limitBytes,
      totalBytes,
    });
    this.name = "MailAttachmentTooLargeError";
  }
}

/**
 * Raised when an Emails item has no `mail_drafts` row: a draft a mail provider holds is read-only here, as is
 * any other message.
 */
export class MailDraftNotEditableError extends ChokePointError {
  constructor() {
    super(409, "mail_draft_not_editable", "The draft has no Semprec draft row and cannot be changed");
    this.name = "MailDraftNotEditableError";
  }
}

/** Who makes a draft write: the user, or an agent acting for one. `writerKind` is also the actor the draft row records. */
export type MailDraftWriter = WriterIdentity & { writerKind: MailDraftActor };

export interface MailDraftWriteContext {
  writer: MailDraftWriter;
  /** The user whose session or run makes the write; the item invalidations are addressed to them. */
  actingUserId?: string;
  queueAffinity?: ActionQueueAffinity;
}

/** What a draft shows and sends: the fields of the draft routes' bodies that every write carries. */
export interface EmailDraftFields {
  /** The sending address; it must be one of the mailbox's addresses. */
  from: string;
  to: MailDraftRecipient[];
  cc: MailDraftRecipient[];
  bcc: MailDraftRecipient[];
  subject: string;
  /** Plain text: the outgoing MIME part is `text/plain`. */
  body: string;
}

export interface CreateEmailDraftInMailboxInput extends EmailDraftFields {
  mailboxItemId: string;
  threadId: string | null;
  mode: MailDraftMode;
  sourceEmailItemId: string | null;
}

export interface UpdateEmailDraftInput extends Partial<EmailDraftFields> {
  draftItemId: string;
  /** The `updatedAt` of the draft the caller read. */
  ifVersion: string;
  /** A draft stays in its mailbox: a value other than the draft's own is refused. */
  mailboxItemId?: string;
  /** A draft stays in its thread: a value other than the draft's own is refused. */
  threadId?: string | null;
  mode?: MailDraftMode;
  sourceEmailItemId?: string | null;
}

export interface EmailDraftView {
  id: string;
  mailboxId: string;
  from: string;
  to: MailDraftRecipient[];
  cc: MailDraftRecipient[];
  bcc: MailDraftRecipient[];
  subject: string;
  body: string;
  threadId: string | null;
  mode: MailDraftMode;
  sourceEmailId: string | null;
  /** The files attached to the draft, oldest first (issue gh-1895). */
  attachments: DraftAttachment[];
  createdBy: MailDraftActor;
  lastEditedBy: MailDraftActor;
  /** The Emails item's `updatedAt`: the value a later `PATCH` sends as `ifVersion`. */
  updatedAt: string;
  sentAt: string | null;
}

function textProperty(item: ItemRow, key: string): string {
  const value = item.properties[key];
  return typeof value === "string" ? value : "";
}

function toEmailDraftView(item: ItemRow, draft: MailDraft, attachments: DraftAttachment[]): EmailDraftView {
  return {
    id: item.id,
    mailboxId: draft.mailboxItemId,
    from: draft.fromAddress,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: textProperty(item, "name"),
    body: textProperty(item, "body"),
    threadId: draft.threadId,
    mode: draft.mode,
    sourceEmailId: draft.sourceEmailItemId,
    attachments,
    createdBy: draft.createdBy,
    lastEditedBy: draft.lastEditedBy,
    updatedAt: item.updatedAt,
    sentAt: draft.sentAt === null ? null : draft.sentAt.toISOString(),
  };
}

/**
 * Throws `from_address_not_registered` (403) unless `from` is one of the addresses of the Mailboxes item. Without
 * the check a draft could name any sender, and the send step would be the only thing between it and the mailbox's
 * SMTP credentials.
 */
function assertFromAddressRegistered(mailbox: ItemRow, from: string): void {
  const registered = parseAddressListProperty(mailbox.properties.addresses).map(normalizeEmailAddress);
  if (!registered.includes(normalizeEmailAddress(from))) {
    throw new ForbiddenError(
      `The from address is not a registered address of mailbox ${mailbox.id}`,
      { field: "from" },
      "from_address_not_registered",
    );
  }
}

/** Announces the draft's change on its thread. A draft without a thread, or whose thread is gone, announces nothing. */
export async function announceDraftThreadChanged(client: PoolClient, threadId: string | null): Promise<void> {
  if (threadId === null) return;
  const live = await resolveMergedThreadId(client, threadId);
  if (live !== null) announceMailThreadChanged(client, live);
}

/**
 * Creates a draft of mailbox `input.mailboxItemId` in the caller's transaction and tenant: the Emails item, its
 * edge to the mailbox's Drafts folder and its `mail_drafts` row (`createEmailDraft`). Every reference is checked
 * first, and each unknown one (another tenant's included) is a 404: the mailbox, the thread (a merged-away id is
 * stored as the thread that absorbed it) and the source message. A `from` the mailbox does not have is a 403
 * `from_address_not_registered`. A mailbox without a Drafts folder, which no sync pass has discovered yet, is a
 * 400. A second unsent agent draft for a thread makes the insert of the row fail with
 * `MailDraftThreadConflictError` (409); the caller's transaction must roll back with it.
 *
 * The Emails item is created as `context.writer` for `context.actingUserId`, so its create invalidation is
 * addressed to that user like those of an update and a discard.
 *
 * After the commit it announces the change on the draft's thread, when it has one.
 */
export async function createEmailDraftInMailbox(
  client: PoolClient,
  input: CreateEmailDraftInMailboxInput,
  context: MailDraftWriteContext,
): Promise<EmailDraftView> {
  const ids = await resolveMailModuleIds(client);
  const mailbox = await getItemById(client, ids.mailboxesDatabaseId, input.mailboxItemId);
  if (!mailbox || mailbox.deletedAt) throw new NotFoundError("Mailbox not found");
  assertFromAddressRegistered(mailbox, input.from);
  const threadId = input.threadId === null ? null : await resolveMergedThreadId(client, input.threadId);
  if (input.threadId !== null && threadId === null) throw new NotFoundError("Thread not found");
  if (input.sourceEmailItemId !== null) await assertLiveEmail(client, ids.emailsDatabaseId, input.sourceEmailItemId);

  const [folderProperty, mailboxFolderProperty] = await Promise.all([
    getPropertyByKey(client, ids.emailsDatabaseId, "folder"),
    getPropertyByKey(client, ids.foldersDatabaseId, "mailbox"),
  ]);
  if (!folderProperty || !mailboxFolderProperty)
    throw new Error("Email module schema is missing an expected relation property");
  const draftsFolderItemId = await findFolderBySpecialPurpose(client, {
    foldersDatabaseId: ids.foldersDatabaseId,
    mailboxRelationPropertyId: mailboxFolderProperty.id,
    mailboxItemId: input.mailboxItemId,
    specialPurpose: "drafts",
  });
  if (!draftsFolderItemId) {
    throw new ValidationError(
      `Mailbox ${input.mailboxItemId} has no Drafts folder yet - sync the account before drafting`,
      { field: "mailboxId" },
    );
  }

  const item = await createEmailDraft(client, {
    emailsDatabaseId: ids.emailsDatabaseId,
    folderRelationPropertyId: folderProperty.id,
    draftsFolderItemId,
    subject: input.subject,
    from: { name: "", address: input.from },
    bodyText: input.body,
    metadata: {
      mailboxItemId: input.mailboxItemId,
      threadId,
      mode: input.mode,
      sourceEmailItemId: input.sourceEmailItemId,
      fromAddress: input.from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      createdBy: context.writer.writerKind,
    },
    writer: context.writer,
    actingUserId: context.actingUserId,
    humanWriterUserId: context.writer.writerKind === "user" ? context.actingUserId : undefined,
    queueAffinity: context.queueAffinity,
  });
  await announceDraftThreadChanged(client, threadId);
  return readEmailDraft(client, item.id);
}

async function assertLiveEmail(client: PoolClient, emailsDatabaseId: string, itemId: string): Promise<void> {
  const email = await getItemById(client, emailsDatabaseId, itemId);
  if (!email || email.deletedAt) throw new NotFoundError("Source message not found");
}

/**
 * The draft with id `draftItemId`, read in the caller's transaction and tenant. An id that names no live Emails
 * item, another tenant's item and an Emails item without a `mail_drafts` row (a provider draft, a received
 * message) all give the same 404. A sent draft is returned, with its `sentAt`.
 */
export async function readEmailDraft(client: PoolClient, draftItemId: string): Promise<EmailDraftView> {
  const ids = await resolveMailModuleIds(client);
  const item = await getItemById(client, ids.emailsDatabaseId, draftItemId);
  const draft = item && !item.deletedAt ? await getMailDraft(client, draftItemId) : null;
  if (!item || !draft) throw new NotFoundError("Draft not found");
  return toEmailDraftView(item, draft, await listDraftAttachments(client, ids, draftItemId));
}

/**
 * Locks the draft's Emails item and then its `mail_drafts` row, for a write that decides on what it reads
 * (the version, `sentAt`). An id that names no live Emails item is a 404; an item without a row is a
 * `MailDraftNotEditableError` and a sent draft a `MailDraftAlreadySentError`, both 409.
 */
export async function lockUnsentDraft(
  client: PoolClient,
  emailsDatabaseId: string,
  draftItemId: string,
): Promise<{ item: ItemRow; draft: MailDraft }> {
  const item = await lockItemById(client, emailsDatabaseId, draftItemId);
  if (!item || item.deletedAt) throw new NotFoundError("Draft not found");
  const draft = await getMailDraft(client, draftItemId, true);
  if (!draft) throw new MailDraftNotEditableError();
  if (draft.sentAt !== null) throw new MailDraftAlreadySentError();
  return { item, draft };
}

/**
 * Updates an unsent draft in the caller's transaction and tenant: its `mail_drafts` row (`last_edited_by` is the
 * writer's kind) and the Emails item's subject, sender, recipients and body, which the write always rewrites so
 * that `updatedAt` moves. The order of the refusals is: 404 for an id that names no live Emails item, 409
 * `mail_draft_not_editable` for an item without a row, 409 `mail_draft_already_sent`, 409 `version_conflict` for
 * an `ifVersion` that is not the item's current `updatedAt` (its details carry the current item), 400 for a
 * `mailboxItemId` or `threadId` that differs from the draft's, 403 `from_address_not_registered`, 404 for a
 * source message that does not exist.
 *
 * The Emails item and the draft row are locked before they are read, so the version and `sentAt` the checks see
 * are the ones the writes act on. After the commit it announces the change on the draft's thread, when it has one.
 */
export async function updateEmailDraft(
  client: PoolClient,
  input: UpdateEmailDraftInput,
  context: MailDraftWriteContext,
): Promise<EmailDraftView> {
  const ids = await resolveMailModuleIds(client);
  const { emailsDatabaseId, mailboxesDatabaseId } = ids;
  const { item, draft } = await lockUnsentDraft(client, emailsDatabaseId, input.draftItemId);
  if (input.ifVersion !== item.updatedAt) {
    throw new ConflictError("Draft was modified since ifVersion was read", { current: item });
  }
  if (input.mailboxItemId !== undefined && input.mailboxItemId !== draft.mailboxItemId) {
    throw new ValidationError("A draft cannot move to another mailbox", { field: "mailboxId" });
  }
  if (input.threadId !== undefined && input.threadId !== draft.threadId) {
    throw new ValidationError("A draft cannot move to another thread", { field: "threadId" });
  }
  if (input.from !== undefined) {
    const mailbox = await getItemById(client, mailboxesDatabaseId, draft.mailboxItemId);
    if (!mailbox || mailbox.deletedAt) throw new NotFoundError("Mailbox not found");
    assertFromAddressRegistered(mailbox, input.from);
  }
  if (input.sourceEmailItemId) await assertLiveEmail(client, emailsDatabaseId, input.sourceEmailItemId);

  const updated = await updateMailDraft(client, input.draftItemId, {
    lastEditedBy: context.writer.writerKind,
    fromAddress: input.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    mode: input.mode,
    sourceEmailItemId: input.sourceEmailItemId,
  });
  const written = await updateItemWithClient(
    client,
    {
      databaseId: emailsDatabaseId,
      itemId: input.draftItemId,
      propertiesPatch: {
        name: input.subject ?? textProperty(item, "name"),
        sender: updated.fromAddress,
        recipients: formatAddressList(updated.to),
        body: input.body ?? textProperty(item, "body"),
      },
    },
    {
      allowedSystemKeys: EMAIL_INGEST_ALLOWED_SYSTEM_KEYS,
      writer: context.writer,
      actingUserId: context.actingUserId,
      humanWriterUserId: context.writer.writerKind === "user" ? context.actingUserId : undefined,
      queueAffinity: context.queueAffinity,
    },
  );
  await announceDraftThreadChanged(client, updated.threadId);
  return toEmailDraftView(written, updated, await listDraftAttachments(client, ids, input.draftItemId));
}

/**
 * Discards an unsent draft in the caller's transaction and tenant: the files attached to it that were made for it
 * and belong to it alone go to the trash (`deleteFilesOfDiscardedDraft`, issue gh-1895; a file that is older than
 * the draft stays), the Emails item goes to the trash and its `mail_drafts` row is deleted, which frees the thread
 * for a new agent draft. The refusals before it are those of `updateEmailDraft` up to `mail_draft_already_sent`.
 * After the commit it announces the change on the draft's thread, when it has one.
 */
export async function discardEmailDraft(
  client: PoolClient,
  draftItemId: string,
  context: MailDraftWriteContext,
): Promise<void> {
  const ids = await resolveMailModuleIds(client);
  const { emailsDatabaseId } = ids;
  const { draft } = await lockUnsentDraft(client, emailsDatabaseId, draftItemId);
  const queueAffinity = context.queueAffinity ?? createActionQueueAffinity();
  await deleteFilesOfDiscardedDraft(client, ids, draftItemId, {
    writer: context.writer,
    actingUserId: context.actingUserId,
    queueAffinity,
  });
  const trashed = await itemDeleteWithClient(client, emailsDatabaseId, draftItemId, {
    queueAffinity,
    actingUserId: context.actingUserId,
    writer: context.writer,
  });
  // The item is locked and was live a statement ago, so the trash finds it.
  if (trashed === null) throw new Error(`Draft ${draftItemId} disappeared while it was discarded`);
  await deleteMailDraft(client, draftItemId);
  await announceDraftThreadChanged(client, draft.threadId);
}
