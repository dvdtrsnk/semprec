import type { PoolClient } from "pg";
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
import { getMailMessageMetaByItemId, resolveMergedThreadId, type MailEnvelopeAddress } from "./mailMessageMetaStore.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { findFolderBySpecialPurpose } from "./folderDiscovery.js";
import {
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
import { listDraftAttachments, type DraftAttachment } from "./mailDraftAttachmentFiles.js";
import { trashLockedDraft } from "./mailDraftTrash.js";
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
  /** Defaults to now. */
  date?: Date;
  /**
   * When given, the `mail_drafts` row is written on the same client, so the caller must run in one
   * transaction. Without it the draft stays a plain Email, read-only for Semprec.
   */
  metadata?: Omit<InsertMailDraftInput, "emailItemId">;
  /** Defaults to the system writer. */
  writer?: WriterIdentity;
  actingUserId?: string;
  /** Set only for a human writer; read by hooks that confine a write to humans. */
  humanWriterUserId?: string;
  queueAffinity?: ActionQueueAffinity;
}

/**
 * No authorization check: drafting is safe for agents, unlike sending, which needs approval. Writes
 * the same system display fields as ingest. The Message-ID and `mail_message_meta` row only exist
 * once the draft is sent. Created `read: true` because the user wrote it and sending keeps the item.
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

export interface MailDraftSentDetails {
  emailId: string;
  threadId: string | null;
}

/**
 * The draft is sent (`sent_at` set) or being sent (a `mail_message_meta` claim exists). `details`
 * lets a client whose first call timed out see where the message went.
 */
export class MailDraftAlreadySentError extends ChokePointError {
  constructor(details?: MailDraftSentDetails) {
    super(409, "mail_draft_already_sent", "The draft was sent already", details);
    this.name = "MailDraftAlreadySentError";
  }
}

/** The draft's total attachment size would exceed the provider's limit; `details` are in bytes. */
export class MailAttachmentTooLargeError extends ChokePointError {
  constructor(limitBytes: number, totalBytes: number) {
    super(413, "mail_attachment_too_large", "The attachments of the draft would be larger than the mailbox allows", {
      limitBytes,
      totalBytes,
    });
    this.name = "MailAttachmentTooLargeError";
  }
}

/** No `mail_drafts` row: a provider-held draft is read-only here, like any other message. */
export class MailDraftNotEditableError extends ChokePointError {
  constructor() {
    super(409, "mail_draft_not_editable", "The draft has no Semprec draft row and cannot be changed");
    this.name = "MailDraftNotEditableError";
  }
}

/** `writerKind` is also the actor the draft row records. */
export type MailDraftWriter = WriterIdentity & { writerKind: MailDraftActor };

export interface MailDraftWriteContext {
  writer: MailDraftWriter;
  actingUserId?: string;
  queueAffinity?: ActionQueueAffinity;
  /** The Semp conversation of the agent run; recorded on the draft row at create. */
  conversationId?: string;
}

export interface EmailDraftFields {
  /** Must be one of the mailbox's addresses. */
  from: string;
  to: MailDraftRecipient[];
  cc: MailDraftRecipient[];
  bcc: MailDraftRecipient[];
  subject: string;
  /** Plain text; sent as `text/plain`. */
  body: string;
}

export interface CreateEmailDraftInMailboxInput extends EmailDraftFields {
  mailboxItemId: string;
  threadId: string | null;
  mode: MailDraftMode;
  sourceEmailItemId: string | null;
  inReplyTo?: string | null;
  references?: string[];
}

export interface UpdateEmailDraftInput extends Partial<EmailDraftFields> {
  draftItemId: string;
  /** The `updatedAt` the caller read. */
  ifVersion: string;
  /** A value other than the draft's own is refused. */
  mailboxItemId?: string;
  /** A value other than the draft's own is refused. */
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
  /** Oldest first. */
  attachments: DraftAttachment[];
  createdBy: MailDraftActor;
  lastEditedBy: MailDraftActor;
  /** Sent back as `ifVersion` on a later `PATCH`. */
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

/** Without this a draft could name any sender, guarded only by the send step's SMTP credentials. */
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

/** No-op for a draft without a thread or whose thread is gone. */
export async function announceDraftThreadChanged(client: PoolClient, threadId: string | null): Promise<void> {
  if (threadId === null) return;
  const live = await resolveMergedThreadId(client, threadId);
  if (live !== null) announceMailThreadChanged(client, live);
}

/**
 * Unknown references (including another tenant's) are 404; a merged-away thread id is stored as
 * the absorbing thread. A mailbox without a discovered Drafts folder is 400. A second unsent agent
 * draft for a thread fails with `MailDraftThreadConflictError` (409); the caller must roll back.
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
      inReplyTo: input.inReplyTo,
      references: input.references,
      fromAddress: input.from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      createdBy: context.writer.writerKind,
      agentRunId: context.writer.writerKind === "agent" ? (context.writer.agentRunId ?? null) : null,
      conversationId: context.conversationId ?? null,
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

/** Missing, foreign-tenant and non-Semprec (no `mail_drafts` row) drafts all give the same 404. */
export async function readEmailDraft(client: PoolClient, draftItemId: string): Promise<EmailDraftView> {
  const ids = await resolveMailModuleIds(client);
  const item = await getItemById(client, ids.emailsDatabaseId, draftItemId);
  const draft = item && !item.deletedAt ? await getMailDraft(client, draftItemId) : null;
  if (!item || !draft) throw new NotFoundError("Draft not found");
  return toEmailDraftView(item, draft, await listDraftAttachments(client, ids, draftItemId));
}

/**
 * Locks the Emails item, then the `mail_drafts` row. A draft claimed by an in-progress send (its
 * `mail_message_meta` row exists before the provider call) is refused like a sent one: its content
 * is what the send delivers. A failed send undoes the claim.
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
  const claim = await getMailMessageMetaByItemId(client, draftItemId);
  if (claim !== null) {
    throw new MailDraftAlreadySentError({
      emailId: draftItemId,
      threadId: claim.threadId === null ? null : await resolveMergedThreadId(client, claim.threadId),
    });
  }
  return { item, draft };
}

/**
 * The item's display fields are always rewritten so `updatedAt` moves. Item and row are locked
 * before the checks, so the version and `sentAt` checked are the ones written over.
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

export async function discardEmailDraft(
  client: PoolClient,
  draftItemId: string,
  context: MailDraftWriteContext,
): Promise<void> {
  const ids = await resolveMailModuleIds(client);
  const { draft } = await lockUnsentDraft(client, ids.emailsDatabaseId, draftItemId);
  await trashLockedDraft(client, ids, draftItemId, {
    writer: context.writer,
    actingUserId: context.actingUserId,
    queueAffinity: context.queueAffinity ?? createActionQueueAffinity(),
  });
  await announceDraftThreadChanged(client, draft.threadId);
}
