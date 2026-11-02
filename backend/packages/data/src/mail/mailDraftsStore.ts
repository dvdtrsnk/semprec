import type { Queryable } from "../db/pool.js";
import { assertKnownValue, assertShape } from "../dbRowValidation.js";
import { ConflictError, NotFoundError } from "../errors.js";

export const MAIL_DRAFT_MODES = ["new", "reply", "replyAll", "forward"] as const;
export type MailDraftMode = (typeof MAIL_DRAFT_MODES)[number];
export const MAIL_DRAFT_ACTORS = ["user", "agent"] as const;
export type MailDraftActor = (typeof MAIL_DRAFT_ACTORS)[number];

/** One recipient of a draft; `name` is an empty string when the address has no display name. */
export interface MailDraftRecipient {
  name: string;
  address: string;
}

export interface MailDraft {
  emailItemId: string;
  mailboxItemId: string;
  threadId: string | null;
  mode: MailDraftMode;
  sourceEmailItemId: string | null;
  inReplyTo: string | null;
  references: string[];
  fromAddress: string;
  to: MailDraftRecipient[];
  cc: MailDraftRecipient[];
  bcc: MailDraftRecipient[];
  createdBy: MailDraftActor;
  lastEditedBy: MailDraftActor;
  agentRunId: string | null;
  conversationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
}

export interface InsertMailDraftInput {
  emailItemId: string;
  mailboxItemId: string;
  threadId?: string | null;
  mode: MailDraftMode;
  sourceEmailItemId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  fromAddress: string;
  to?: MailDraftRecipient[];
  cc?: MailDraftRecipient[];
  bcc?: MailDraftRecipient[];
  createdBy: MailDraftActor;
  agentRunId?: string | null;
  conversationId?: string | null;
}

/** A field left `undefined` is unchanged; `null` clears a nullable field. */
export interface UpdateMailDraftInput {
  lastEditedBy: MailDraftActor;
  mode?: MailDraftMode;
  sourceEmailItemId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  fromAddress?: string;
  to?: MailDraftRecipient[];
  cc?: MailDraftRecipient[];
  bcc?: MailDraftRecipient[];
  agentRunId?: string | null;
  conversationId?: string | null;
}

/**
 * Raised when an unsent agent draft already exists for the thread
 * (`mail_drafts_one_unsent_agent_per_thread_uq`), so callers can map it to their own response.
 */
export class MailDraftThreadConflictError extends ConflictError {
  constructor(threadId: string | null | undefined) {
    super("An unsent agent draft already exists for this thread", { threadId: threadId ?? null });
    this.name = "MailDraftThreadConflictError";
  }
}

const ONE_PER_THREAD_INDEX = "mail_drafts_one_unsent_agent_per_thread_uq";

type DraftDbRow = {
  email_item_id: string;
  mailbox_item_id: string;
  thread_id: string | null;
  mode: string;
  source_email_item_id: string | null;
  in_reply_to: string | null;
  references: string[];
  from_address: string;
  to_recipients: unknown;
  cc_recipients: unknown;
  bcc_recipients: unknown;
  created_by: string;
  last_edited_by: string;
  agent_run_id: string | null;
  conversation_id: string | null;
  created_at: Date;
  updated_at: Date;
  sent_at: Date | null;
};

const COLUMNS = `email_item_id, mailbox_item_id, thread_id, mode, source_email_item_id, in_reply_to,
  "references", from_address, to_recipients, cc_recipients, bcc_recipients, created_by, last_edited_by,
  agent_run_id, conversation_id, created_at, updated_at, sent_at`;

function toRecipients(value: unknown, column: string): MailDraftRecipient[] {
  assertShape(
    Array.isArray(value) &&
      value.every(
        (entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as Record<string, unknown>).name === "string" &&
          typeof (entry as Record<string, unknown>).address === "string",
      ),
    `mail_drafts.${column}`,
  );
  return (value as MailDraftRecipient[]).map(({ name, address }) => ({ name, address }));
}

function toDraft(row: DraftDbRow): MailDraft {
  return {
    emailItemId: row.email_item_id,
    mailboxItemId: row.mailbox_item_id,
    threadId: row.thread_id,
    mode: assertKnownValue(MAIL_DRAFT_MODES, row.mode, "mail_drafts.mode"),
    sourceEmailItemId: row.source_email_item_id,
    inReplyTo: row.in_reply_to,
    references: row.references,
    fromAddress: row.from_address,
    to: toRecipients(row.to_recipients, "to_recipients"),
    cc: toRecipients(row.cc_recipients, "cc_recipients"),
    bcc: toRecipients(row.bcc_recipients, "bcc_recipients"),
    createdBy: assertKnownValue(MAIL_DRAFT_ACTORS, row.created_by, "mail_drafts.created_by"),
    lastEditedBy: assertKnownValue(MAIL_DRAFT_ACTORS, row.last_edited_by, "mail_drafts.last_edited_by"),
    agentRunId: row.agent_run_id,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
  };
}

function isOnePerThreadViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    return Reflect.get(error, "code") === "23505" && Reflect.get(error, "constraint") === ONE_PER_THREAD_INDEX;
  } catch {
    // An arbitrary thrown value must not replace the original failure during classification.
    return false;
  }
}

export async function insertMailDraft(db: Queryable, input: InsertMailDraftInput): Promise<MailDraft> {
  try {
    const { rows } = await db.query<DraftDbRow>(
      `INSERT INTO mail_drafts
         (email_item_id, mailbox_item_id, thread_id, mode, source_email_item_id, in_reply_to, "references",
          from_address, to_recipients, cc_recipients, bcc_recipients, created_by, last_edited_by,
          agent_run_id, conversation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $12, $13, $14)
       RETURNING ${COLUMNS}`,
      [
        input.emailItemId,
        input.mailboxItemId,
        input.threadId ?? null,
        input.mode,
        input.sourceEmailItemId ?? null,
        input.inReplyTo ?? null,
        input.references ?? [],
        input.fromAddress,
        JSON.stringify(input.to ?? []),
        JSON.stringify(input.cc ?? []),
        JSON.stringify(input.bcc ?? []),
        input.createdBy,
        input.agentRunId ?? null,
        input.conversationId ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error(`Inserting mail draft ${input.emailItemId} returned no row`);
    return toDraft(row);
  } catch (error) {
    if (isOnePerThreadViolation(error)) throw new MailDraftThreadConflictError(input.threadId);
    throw error;
  }
}

export async function getMailDraft(db: Queryable, emailItemId: string): Promise<MailDraft | null> {
  const { rows } = await db.query<DraftDbRow>(`SELECT ${COLUMNS} FROM mail_drafts WHERE email_item_id = $1`, [
    emailItemId,
  ]);
  const row = rows[0];
  return row ? toDraft(row) : null;
}

/** Updates the given fields of an unsent draft; throws `NotFoundError` when there is no unsent draft row. */
export async function updateMailDraft(
  db: Queryable,
  emailItemId: string,
  patch: UpdateMailDraftInput,
): Promise<MailDraft> {
  const sets: string[] = ["last_edited_by = $2", "updated_at = now()"];
  const values: unknown[] = [emailItemId, patch.lastEditedBy];
  const set = (column: string, value: unknown, cast = ""): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}${cast}`);
  };
  if (patch.mode !== undefined) set("mode", patch.mode);
  if (patch.sourceEmailItemId !== undefined) set("source_email_item_id", patch.sourceEmailItemId);
  if (patch.inReplyTo !== undefined) set("in_reply_to", patch.inReplyTo);
  if (patch.references !== undefined) set(`"references"`, patch.references);
  if (patch.fromAddress !== undefined) set("from_address", patch.fromAddress);
  if (patch.to !== undefined) set("to_recipients", JSON.stringify(patch.to), "::jsonb");
  if (patch.cc !== undefined) set("cc_recipients", JSON.stringify(patch.cc), "::jsonb");
  if (patch.bcc !== undefined) set("bcc_recipients", JSON.stringify(patch.bcc), "::jsonb");
  if (patch.agentRunId !== undefined) set("agent_run_id", patch.agentRunId);
  if (patch.conversationId !== undefined) set("conversation_id", patch.conversationId);
  const { rows } = await db.query<DraftDbRow>(
    `UPDATE mail_drafts SET ${sets.join(", ")} WHERE email_item_id = $1 AND sent_at IS NULL RETURNING ${COLUMNS}`,
    values,
  );
  const row = rows[0];
  if (!row) throw new NotFoundError(`Unsent mail draft ${emailItemId} not found`, { emailItemId });
  return toDraft(row);
}

/** Marks an unsent draft as sent, which frees its thread for a new agent draft; throws `NotFoundError` when there is none. */
export async function markMailDraftSent(
  db: Queryable,
  emailItemId: string,
  sentAt: Date = new Date(),
): Promise<MailDraft> {
  const { rows } = await db.query<DraftDbRow>(
    `UPDATE mail_drafts SET sent_at = $2, updated_at = now()
     WHERE email_item_id = $1 AND sent_at IS NULL RETURNING ${COLUMNS}`,
    [emailItemId, sentAt],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError(`Unsent mail draft ${emailItemId} not found`, { emailItemId });
  return toDraft(row);
}
