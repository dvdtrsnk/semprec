import type { Queryable } from "../db/pool.js";

export interface MailEnvelopeAddress {
  name?: string;
  address: string;
}

export interface MailEnvelope {
  from?: MailEnvelopeAddress;
  to?: MailEnvelopeAddress[];
  cc?: MailEnvelopeAddress[];
  bcc?: MailEnvelopeAddress[];
}

export interface MailMessageMetaRow {
  itemId: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  threadId: string | null;
  providerThreadId: string | null;
  providerMessageId: string | null;
  envelope: MailEnvelope;
}

function mapRow(row: {
  item_id: string;
  message_id: string;
  in_reply_to: string | null;
  references: string[] | null;
  thread_id: string | null;
  provider_thread_id: string | null;
  provider_message_id: string | null;
  envelope: MailEnvelope;
}): MailMessageMetaRow {
  return {
    itemId: row.item_id,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: row.references ?? [],
    threadId: row.thread_id,
    providerThreadId: row.provider_thread_id,
    providerMessageId: row.provider_message_id,
    envelope: row.envelope ?? {},
  };
}

const COLUMNS = 'item_id, message_id, in_reply_to, "references", thread_id, provider_thread_id, provider_message_id, envelope';

export interface UpsertMailMessageMetaInput {
  itemId: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  threadId?: string | null;
  providerThreadId?: string | null;
  providerMessageId?: string | null;
  envelope: MailEnvelope;
}

/**
 * Keyed by `message_id` (RFC 5322, global dedup key): an optimistic outgoing insert
 * (issue #27) and the sync worker later confirming the same message in Sent converge onto
 * one row via `ON CONFLICT (message_id) DO UPDATE`, filling in provider-specific ids instead
 * of creating a duplicate. `item_id` is the caller's freshly-created (or existing) Email
 * item id either way.
 */
export async function upsertMailMessageMeta(client: Queryable, input: UpsertMailMessageMetaInput): Promise<MailMessageMetaRow> {
  const { rows } = await client.query(
    `INSERT INTO mail_message_meta (item_id, message_id, in_reply_to, "references", thread_id, provider_thread_id, provider_message_id, envelope)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (message_id) DO UPDATE SET
       thread_id = COALESCE(EXCLUDED.thread_id, mail_message_meta.thread_id),
       provider_thread_id = COALESCE(EXCLUDED.provider_thread_id, mail_message_meta.provider_thread_id),
       provider_message_id = COALESCE(EXCLUDED.provider_message_id, mail_message_meta.provider_message_id)
     RETURNING ${COLUMNS}`,
    [
      input.itemId,
      input.messageId,
      input.inReplyTo ?? null,
      input.references ?? [],
      input.threadId ?? null,
      input.providerThreadId ?? null,
      input.providerMessageId ?? null,
      JSON.stringify(input.envelope),
    ],
  );
  return mapRow(rows[0]);
}

export async function getMailMessageMetaByItemId(client: Queryable, itemId: string): Promise<MailMessageMetaRow | null> {
  const { rows } = await client.query(`SELECT ${COLUMNS} FROM mail_message_meta WHERE item_id = $1`, [itemId]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getMailMessageMetaByMessageId(client: Queryable, messageId: string): Promise<MailMessageMetaRow | null> {
  const { rows } = await client.query(`SELECT ${COLUMNS} FROM mail_message_meta WHERE message_id = $1`, [messageId]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getMailMessageMetaByProviderMessageId(client: Queryable, providerMessageId: string): Promise<MailMessageMetaRow | null> {
  const { rows } = await client.query(`SELECT ${COLUMNS} FROM mail_message_meta WHERE provider_message_id = $1`, [providerMessageId]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface MailThreadRow {
  id: string;
  subjectHint: string | null;
}

export async function createMailThread(client: Queryable, subjectHint?: string): Promise<MailThreadRow> {
  const { rows } = await client.query(`INSERT INTO mail_threads (subject_hint) VALUES ($1) RETURNING id, subject_hint`, [subjectHint ?? null]);
  return { id: rows[0].id, subjectHint: rows[0].subject_hint };
}

/** Moves every message out of `fromThreadId` into `toThreadId`, then deletes the now-empty `mail_threads` row — nothing else references `mail_threads` except this table's own `thread_id`, so once this UPDATE runs, `fromThreadId` is guaranteed to have zero remaining referencers. Leaving it would accumulate an orphaned row on every dummy-container merge (threading.ts's self-heal path). */
export async function reassignThread(client: Queryable, fromThreadId: string, toThreadId: string): Promise<void> {
  await client.query(`UPDATE mail_message_meta SET thread_id = $2 WHERE thread_id = $1`, [fromThreadId, toThreadId]);
  await client.query(`DELETE FROM mail_threads WHERE id = $1`, [fromThreadId]);
}
