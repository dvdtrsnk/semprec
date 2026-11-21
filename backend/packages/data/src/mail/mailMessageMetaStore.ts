import { Pool, type PoolClient } from "pg";
import type { Queryable } from "../db/pool.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";
import {
  markManagedTransactionRollbackOnly,
  requireAffectedRows,
  requireManagedTransaction,
  requireSingleRow,
} from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { getItemsByIdsIncludingDeleted, lockItemById } from "../chokePoint/itemsStore.js";
import { transferMailThreadRelationsWithClient } from "../chokePoint/relationOps.js";
import { finishThreadValueMerge, planThreadValueMerge } from "./threadMergePrecedence.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { propagateThreadAttachmentLinks, repointThreadAttachmentLinks } from "./threadAttachmentLinks.js";

export interface MailEnvelopeAddress {
  name?: string;
  address: string;
}

export interface MailEnvelope {
  from?: MailEnvelopeAddress;
  to?: MailEnvelopeAddress[];
  cc?: MailEnvelopeAddress[];
  bcc?: MailEnvelopeAddress[];
  replyTo?: MailEnvelopeAddress[];
}

export type MailMessageKind = "message" | "dsn";

export interface MailMessageMetaRow {
  itemId: string;
  /** Message identity is per mailbox, `(mailbox_item_id, message_id)`. Nullable, but every ingest and send writes it. */
  mailboxItemId: string | null;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  threadId: string | null;
  providerThreadId: string | null;
  providerMessageId: string | null;
  envelope: MailEnvelope;
  /** Resolved once at ingest (mail/deliveredTo.ts), never recomputed. */
  deliveredToAddress: string | null;
  /** 'dsn' = a multipart/report;report-type=delivery-status notification, as opposed to an ordinary reply. */
  messageKind: MailMessageKind;
  /** For a DSN only: the Message-ID (from References/In-Reply-To) of the outgoing message it reports on. */
  dsnOriginalMessageId: string | null;
  /** At most 200 characters; `null` until ingest or send sets it. */
  previewText: string | null;
  ingestedAt: Date | null;
  /** Decided once at ingest (mail/bulkMail.ts). */
  isBulk: boolean;
}

type MailMessageMetaDbRow = {
  item_id: string;
  mailbox_item_id: string | null;
  message_id: string;
  in_reply_to: string | null;
  references: string[] | null;
  thread_id: string | null;
  provider_thread_id: string | null;
  provider_message_id: string | null;
  envelope: MailEnvelope;
  delivered_to_address: string | null;
  message_kind: MailMessageKind;
  dsn_original_message_id: string | null;
  preview_text: string | null;
  ingested_at: Date | null;
  is_bulk: boolean;
};

function mapRow(row: MailMessageMetaDbRow): MailMessageMetaRow {
  return {
    itemId: row.item_id,
    mailboxItemId: row.mailbox_item_id,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: row.references ?? [],
    threadId: row.thread_id,
    providerThreadId: row.provider_thread_id,
    providerMessageId: row.provider_message_id,
    envelope: row.envelope ?? {},
    deliveredToAddress: row.delivered_to_address,
    messageKind: row.message_kind,
    dsnOriginalMessageId: row.dsn_original_message_id,
    previewText: row.preview_text,
    ingestedAt: row.ingested_at,
    isBulk: row.is_bulk,
  };
}

const COLUMNS =
  'item_id, mailbox_item_id, message_id, in_reply_to, "references", thread_id, provider_thread_id, provider_message_id, envelope, ' +
  "delivered_to_address, message_kind, dsn_original_message_id, preview_text, ingested_at, is_bulk";

export interface UpsertMailMessageMetaInput {
  itemId: string;
  /** A `NULL` never conflicts, so a row without a mailbox is always a fresh insert. */
  mailboxItemId: string | null;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  threadId?: string | null;
  providerThreadId?: string | null;
  providerMessageId?: string | null;
  envelope: MailEnvelope;
  deliveredToAddress?: string | null;
  messageKind?: MailMessageKind;
  dsnOriginalMessageId?: string | null;
  previewText?: string | null;
  ingestedAt?: Date | null;
  /** Written on insert only; a conflicting upsert keeps the stored value. Defaults to `false`. */
  isBulk?: boolean;
}

/**
 * Keyed by `(mailbox_item_id, message_id)`: the same message in two mailboxes is two Emails items with their own
 * read/flag state. Within one mailbox, an optimistic outgoing insert and the later sync confirmation in Sent converge
 * onto one row via `ON CONFLICT`, filling in provider ids instead of duplicating.
 */
export function upsertMailMessageMeta(
  client: Pool,
  input: UpsertMailMessageMetaInput & { threadId?: null },
): Promise<MailMessageMetaRow>;
export function upsertMailMessageMeta(
  client: PoolClient,
  input: UpsertMailMessageMetaInput,
): Promise<MailMessageMetaRow>;
export async function upsertMailMessageMeta(
  client: Queryable,
  input: UpsertMailMessageMetaInput,
): Promise<MailMessageMetaRow> {
  if (input.threadId != null) {
    if (client instanceof Pool) throw new Error("Mail thread mutation requires a READ COMMITTED tenant transaction");
    await lockMailThreadMutation(client);
  }
  const { rows } = await client.query<MailMessageMetaDbRow>(
    `INSERT INTO mail_message_meta (item_id, message_id, in_reply_to, "references", thread_id, provider_thread_id, provider_message_id, envelope,
                                     delivered_to_address, message_kind, dsn_original_message_id, mailbox_item_id, preview_text, ingested_at, is_bulk)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (mailbox_item_id, message_id) DO UPDATE SET
       thread_id = COALESCE(EXCLUDED.thread_id, mail_message_meta.thread_id),
       provider_thread_id = COALESCE(EXCLUDED.provider_thread_id, mail_message_meta.provider_thread_id),
       provider_message_id = COALESCE(EXCLUDED.provider_message_id, mail_message_meta.provider_message_id),
       delivered_to_address = COALESCE(EXCLUDED.delivered_to_address, mail_message_meta.delivered_to_address),
       dsn_original_message_id = COALESCE(EXCLUDED.dsn_original_message_id, mail_message_meta.dsn_original_message_id),
       preview_text = COALESCE(mail_message_meta.preview_text, EXCLUDED.preview_text),
       ingested_at = COALESCE(mail_message_meta.ingested_at, EXCLUDED.ingested_at)
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
      input.deliveredToAddress ?? null,
      input.messageKind ?? "message",
      input.dsnOriginalMessageId ?? null,
      input.mailboxItemId,
      input.previewText ?? null,
      input.ingestedAt ?? null,
      input.isBulk ?? false,
    ],
  );
  return mapRow(requireSingleRow(rows, "mail_message_meta row"));
}

export async function getMailMessageMetaByItemId(
  client: Queryable,
  itemId: string,
): Promise<MailMessageMetaRow | null> {
  const { rows } = await client.query<MailMessageMetaDbRow>(
    `SELECT ${COLUMNS} FROM mail_message_meta WHERE item_id = $1`,
    [itemId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getMailMessageMetaByMailboxAndMessageId(
  client: Queryable,
  mailboxItemId: string,
  messageId: string,
): Promise<MailMessageMetaRow | null> {
  const { rows } = await client.query<MailMessageMetaDbRow>(
    `SELECT ${COLUMNS} FROM mail_message_meta WHERE mailbox_item_id = $1 AND message_id = $2`,
    [mailboxItemId, messageId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getMailMessageMetaByProviderMessageId(
  client: Queryable,
  providerMessageId: string,
): Promise<MailMessageMetaRow | null> {
  const { rows } = await client.query<MailMessageMetaDbRow>(
    `SELECT ${COLUMNS} FROM mail_message_meta WHERE provider_message_id = $1`,
    [providerMessageId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Arbitrates distinct `message_id`s racing to the same non-null `provider_message_id` within a tenant. */
const PROVIDER_MESSAGE_ID_CONFLICT_CONSTRAINT = "mail_message_meta_tenant_provider_msg_uq";

/** The concurrency-safe signal ingest's SAVEPOINT-guarded catch converges on. */
export function isProviderMessageIdConflict(err: unknown): boolean {
  const pgErr = err as { code?: string; constraint?: string };
  return pgErr?.code === "23505" && pgErr.constraint === PROVIDER_MESSAGE_ID_CONFLICT_CONSTRAINT;
}

/**
 * Compensating delete for the send's pre-SMTP claim: a claim left after a failed SMTP call would make the item look
 * sent forever and block a genuine retry.
 */
export async function deleteMailMessageMetaByItemId(client: PoolClient, itemId: string): Promise<void> {
  requireManagedTransaction(client);
  try {
    await lockMailThreadMutation(client);
    const { rows } = await client.query<{ thread_id: string | null }>(
      `DELETE FROM mail_message_meta WHERE item_id = $1 RETURNING thread_id`,
      [itemId],
    );
    const threadId = rows[0]?.thread_id;
    if (!threadId) return;
    // The claim may have created its thread; drop it when this was its only message, so no empty thread remains.
    const thread = await client.query<{ item_id: string | null }>(
      `SELECT item_id FROM mail_threads t WHERE t.id = $1 AND NOT EXISTS (SELECT 1 FROM mail_message_meta m WHERE m.thread_id = t.id) FOR UPDATE`,
      [threadId],
    );
    if (!thread.rows[0]) return;
    const database = await getDatabaseByModuleId(client, THREADS_MODULE_ID);
    const threadItemId = thread.rows[0].item_id;
    if (!database?.system || !threadItemId) throw new Error("Missing Threads binding during mail cleanup");
    const existing = await lockItemById(client, database.id, threadItemId);
    if (!existing) throw new Error("Missing Threads item during mail cleanup");
    await itemDeleteWithClient(client, database.id, threadItemId, {
      queueAffinity: createActionQueueAffinity(),
      writer: SYSTEM_WRITER,
    });
    await client.query(
      `DELETE FROM mail_threads t WHERE t.id = $1 AND NOT EXISTS (SELECT 1 FROM mail_message_meta m WHERE m.thread_id = t.id)`,
      [threadId],
    );
  } catch (error) {
    markManagedTransactionRollbackOnly(client, error);
    throw error;
  }
}

/**
 * Marks that an IMAP pass removed one of the Email's folder edges, in the transaction that removed it, so the decision
 * whether the Email still has a folder copy survives a pass that ends before its final transaction. `false` for an
 * Email without a meta row, which only the removing pass itself decides.
 */
export async function markMailMessageFolderCopyRemoved(client: PoolClient, itemId: string): Promise<boolean> {
  const result = await client.query("UPDATE mail_message_meta SET folder_copy_removed_at = now() WHERE item_id = $1", [
    itemId,
  ]);
  return result.rowCount === 1;
}

/** The Emails of `mailboxItemId` marked by `markMailMessageFolderCopyRemoved` and not yet decided. */
export async function listMailMessagesWithFolderCopyRemoved(
  client: Queryable,
  mailboxItemId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ item_id: string }>(
    `SELECT item_id FROM mail_message_meta
      WHERE tenant_id = app_tenant_default() AND mailbox_item_id = $1 AND folder_copy_removed_at IS NOT NULL
      ORDER BY item_id`,
    [mailboxItemId],
  );
  return rows.map((row) => row.item_id);
}

/** Clears the mark of an Email found to keep a folder copy; `false` for an Email without a meta row. */
export async function clearMailMessageFolderCopyRemoved(client: PoolClient, itemId: string): Promise<boolean> {
  const result = await client.query("UPDATE mail_message_meta SET folder_copy_removed_at = NULL WHERE item_id = $1", [
    itemId,
  ]);
  return result.rowCount === 1;
}

/**
 * Deletes the meta row of an Emails item that leaves the mail for good: one permanently deleted (in the purge's
 * transaction) or one trashed because its account's Mail was switched off. When no other row names its thread
 * (trashed messages count), the thread goes too: its Threads item is trashed through the choke point as the system
 * writer (unless already trashed), then the `mail_threads` row is deleted with its aliases by foreign key. Unlike
 * `deleteMailMessageMetaByItemId`, an item without a meta row and an already purged or unbound Threads item do not
 * fail it.
 *
 * Takes the tenant's mail-thread mutation guard before its first statement on a mail table.
 */
export async function deleteMailMessageMetaOfRemovedItem(client: PoolClient, itemId: string): Promise<void> {
  await lockMailThreadMutation(client);
  const deleted = await client.query<{ thread_id: string | null }>(
    `DELETE FROM mail_message_meta WHERE item_id = $1 RETURNING thread_id`,
    [itemId],
  );
  if (deleted.rowCount === 0) return;
  const threadId = deleted.rows[0]?.thread_id;
  if (!threadId) return;
  const emptied = await client.query<{ item_id: string | null }>(
    `SELECT item_id FROM mail_threads t WHERE t.id = $1 AND NOT EXISTS (SELECT 1 FROM mail_message_meta m WHERE m.thread_id = t.id) FOR UPDATE`,
    [threadId],
  );
  const thread = emptied.rows[0];
  if (!thread) return;
  if (thread.item_id !== null) {
    const [threadItem] = await getItemsByIdsIncludingDeleted(client, [thread.item_id]);
    if (threadItem) {
      await itemDeleteWithClient(client, threadItem.databaseId, threadItem.id, {
        queueAffinity: createActionQueueAffinity(),
        writer: SYSTEM_WRITER,
      });
    }
  }
  requireAffectedRows(
    await client.query(`DELETE FROM mail_threads WHERE id = $1`, [threadId]),
    "delete of an emptied mail thread",
  );
}

export interface MailThreadRow {
  id: string;
  subjectHint: string | null;
}

export async function createMailThread(client: PoolClient, subjectHint?: string): Promise<MailThreadRow> {
  await lockMailThreadMutation(client);
  const database = await getDatabaseByModuleId(client, THREADS_MODULE_ID);
  if (!database) throw new Error("Threads database is missing");
  const item = await createItemWithClient(
    client,
    {
      databaseId: database.id,
      properties: { name: subjectHint || "(no subject)" },
    },
    { allowedSystemKeys: ["name"] },
  );
  const { rows } = await client.query<{ id: string; subject_hint: string | null }>(
    `INSERT INTO mail_threads (subject_hint, item_id) VALUES ($1, $2) RETURNING id, subject_hint`,
    [subjectHint ?? null, item.id],
  );
  const thread = requireSingleRow(rows, "mail_threads row");
  return { id: thread.id, subjectHint: thread.subject_hint };
}

/** Throws for a missing or unbound thread: a thread has its item from its creation on. */
export async function getMailThreadItemId(client: Queryable, threadId: string): Promise<string> {
  const { rows } = await client.query<{ item_id: string | null }>(
    "SELECT item_id FROM mail_threads WHERE tenant_id = app_tenant_default() AND id = $1",
    [threadId],
  );
  const itemId = rows[0]?.item_id;
  if (!itemId) throw new Error("The mail thread has no Threads item");
  return itemId;
}

/**
 * Moves every message of `fromThreadId` into `toThreadId`, merges their Threads items (`planThreadValueMerge`),
 * records the alias and repoints existing aliases to it, then deletes the empty `mail_threads` row, which would
 * otherwise accumulate on every dummy-container merge. Run it in one transaction. Merging a thread with itself does
 * nothing. The loser's attachment value links move to the winner first, so attachments follow the winner's project.
 */
export async function reassignThread(client: PoolClient, fromThreadId: string, toThreadId: string): Promise<void> {
  requireManagedTransaction(client);
  try {
    await lockMailThreadMutation(client);
    if (fromThreadId === toThreadId) return;
    const database = await getDatabaseByModuleId(client, THREADS_MODULE_ID);
    if (!database?.system) throw new Error("Threads database is missing");
    const bindings = await client.query<{ id: string; item_id: string | null }>(
      "SELECT id, item_id FROM mail_threads WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [[fromThreadId, toThreadId]],
    );
    const loserId = bindings.rows.find((row) => row.id === fromThreadId)?.item_id;
    const winnerId = bindings.rows.find((row) => row.id === toThreadId)?.item_id;
    if (!loserId || !winnerId || loserId === winnerId) throw new Error("Invalid Threads merge binding");
    for (const id of [loserId, winnerId].sort()) {
      const item = await lockItemById(client, database.id, id);
      if (!item || item.deletedAt) throw new Error("Threads merge item is missing or deleted");
    }
    const valueMerge = {
      winnerItemId: winnerId,
      loserItemId: loserId,
      winnerThreadId: toThreadId,
      loserThreadId: fromThreadId,
    };
    const plan = await planThreadValueMerge(client, valueMerge);
    // Before the generic move removes the loser's edges, which would end these links.
    const repointed = await repointThreadAttachmentLinks(client, loserId, winnerId);
    await transferMailThreadRelationsWithClient(client, database.id, loserId, winnerId, plan.loserValueWins);
    await finishThreadValueMerge(client, plan, valueMerge);
    if (repointed) await propagateThreadAttachmentLinks(client, winnerId);
    await itemDeleteWithClient(client, database.id, loserId, {
      queueAffinity: createActionQueueAffinity(),
      writer: SYSTEM_WRITER,
    });
    await client.query(`UPDATE mail_message_meta SET thread_id = $2 WHERE thread_id = $1`, [fromThreadId, toThreadId]);
    await client.query(
      `INSERT INTO mail_thread_aliases (from_thread_id, to_thread_id) VALUES ($1, $2)
     ON CONFLICT (tenant_id, from_thread_id) DO UPDATE SET to_thread_id = EXCLUDED.to_thread_id`,
      [fromThreadId, toThreadId],
    );
    await client.query(`UPDATE mail_thread_aliases SET to_thread_id = $2 WHERE to_thread_id = $1`, [
      fromThreadId,
      toThreadId,
    ]);
    await client.query(`DELETE FROM mail_threads WHERE id = $1`, [fromThreadId]);
  } catch (error) {
    markManagedTransactionRollbackOnly(client, error);
    throw error;
  }
}

/**
 * The alias target, the input id when it is a live thread, or `null`. Aliases are always one step (`reassignThread`).
 */
export async function resolveMergedThreadId(client: Queryable, threadId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT to_thread_id AS id FROM mail_thread_aliases WHERE from_thread_id = $1
     UNION ALL
     SELECT id FROM mail_threads WHERE id = $1
     LIMIT 1`,
    [threadId],
  );
  return rows[0]?.id ?? null;
}

export interface UnthreadedMailMessage {
  itemId: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  subject: string | null;
}

/**
 * A keyset page of rows without a thread, locked `FOR UPDATE OF m` so no concurrent writer threads a row before the
 * caller's write. `LEFT JOIN` keeps a row whose item is missing; it is threaded without a subject hint.
 */
export async function listUnthreadedMailMessagePage(
  client: PoolClient,
  afterItemId: string | null,
  limit: number,
): Promise<UnthreadedMailMessage[]> {
  await lockMailThreadMutation(client);
  const { rows } = await client.query<{
    item_id: string;
    message_id: string;
    in_reply_to: string | null;
    references: string[] | null;
    subject: string | null;
  }>(
    `SELECT m.item_id, m.message_id, m.in_reply_to, m."references", i.properties ->> 'name' AS subject
       FROM mail_message_meta m
       LEFT JOIN items i ON i.id = m.item_id
      WHERE m.thread_id IS NULL AND ($1::uuid IS NULL OR m.item_id > $1::uuid)
      ORDER BY m.item_id
      LIMIT $2
        FOR UPDATE OF m`,
    [afterItemId, limit],
  );
  return rows.map((row) => ({
    itemId: row.item_id,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: row.references ?? [],
    subject: row.subject,
  }));
}

/**
 * A keyset page of `Message-ID`s present in several mailboxes whose rows name several threads. Candidates only: the
 * caller decides on the locked re-read of `lockMailMessageThreads`.
 */
export async function listSplitMailMessageIdPage(
  client: PoolClient,
  afterMessageId: string | null,
  limit: number,
): Promise<string[]> {
  await lockMailThreadMutation(client);
  const { rows } = await client.query<{ message_id: string }>(
    `SELECT message_id
       FROM mail_message_meta
      WHERE thread_id IS NOT NULL AND ($1::text IS NULL OR message_id > $1::text)
      GROUP BY message_id
     HAVING COUNT(DISTINCT mailbox_item_id) > 1 AND COUNT(DISTINCT thread_id) > 1
      ORDER BY message_id
      LIMIT $2`,
    [afterMessageId, limit],
  );
  return rows.map((row) => row.message_id);
}

/**
 * Locks every row of one `Message-ID` and returns its distinct thread ids lowest first, the order `resolveThreadId`
 * picks a merge target by. Fewer than two means nothing to merge.
 */
export async function lockMailMessageThreads(client: PoolClient, messageId: string): Promise<string[]> {
  await lockMailThreadMutation(client);
  const { rows } = await client.query<{ thread_id: string | null }>(
    `SELECT thread_id FROM mail_message_meta WHERE message_id = $1 ORDER BY thread_id FOR UPDATE`,
    [messageId],
  );
  const threadIds = new Set<string>();
  for (const row of rows) if (row.thread_id) threadIds.add(row.thread_id);
  return [...threadIds];
}
