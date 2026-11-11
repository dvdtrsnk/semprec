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
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";

export interface MailEnvelopeAddress {
  name?: string;
  address: string;
}

export interface MailEnvelope {
  from?: MailEnvelopeAddress;
  to?: MailEnvelopeAddress[];
  cc?: MailEnvelopeAddress[];
  bcc?: MailEnvelopeAddress[];
  /** Reply-To addresses; absent when the message has none (and for messages synced before this field existed). */
  replyTo?: MailEnvelopeAddress[];
}

export type MailMessageKind = "message" | "dsn";
export type MailMessageMigrationStatus = "stable" | "partial" | "done";

export interface MailMessageMetaRow {
  itemId: string;
  /** The Mailbox item this message was ingested for — message identity is per mailbox, `(mailbox_item_id, message_id)`. `null` only for a legacy-migrated row (migrationJob/mailLegacyEmailMigration.ts) or a pre-0052 row with no resolvable folder edge. */
  mailboxItemId: string | null;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  threadId: string | null;
  providerThreadId: string | null;
  providerMessageId: string | null;
  envelope: MailEnvelope;
  /** Resolved once, at ingest, by mail/deliveredTo.ts's precedence rule — never recomputed. */
  deliveredToAddress: string | null;
  /** 'dsn' = a multipart/report;report-type=delivery-status bounce/failure notification, distinguished from an ordinary human reply (issue #93). */
  messageKind: MailMessageKind;
  /** For a DSN only: the Message-ID (from References/In-Reply-To) of the outgoing message it reports on. */
  dsnOriginalMessageId: string | null;
  /** 'stable' = a normal ingest; 'partial'/'done' = produced by the legacy-Emails backfill job (migrationJob/mailLegacyEmailMigration.ts). */
  migrationStatus: MailMessageMigrationStatus;
  /** Plain-text preview (at most 200 characters); `null` until ingest, send or the backfill sets it. */
  previewText: string | null;
  /** When the message entered Semprec; `null` until ingest, send or the backfill sets it. */
  ingestedAt: Date | null;
  /** Bulk or automatic mail, decided once at ingest (mail/bulkMail.ts); `false` for rows ingested before issue #1502. */
  isBulk: boolean;
}

/** The raw `mail_message_meta` row shape this module reads back from Postgres. */
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
  migration_status: MailMessageMigrationStatus;
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
    migrationStatus: row.migration_status,
    previewText: row.preview_text,
    ingestedAt: row.ingested_at,
    isBulk: row.is_bulk,
  };
}

const COLUMNS =
  'item_id, mailbox_item_id, message_id, in_reply_to, "references", thread_id, provider_thread_id, provider_message_id, envelope, ' +
  "delivered_to_address, message_kind, dsn_original_message_id, migration_status, preview_text, ingested_at, is_bulk";

export interface UpsertMailMessageMetaInput {
  itemId: string;
  /** `null` only from the legacy-Emails migration, whose rows have no mailbox; a `NULL` never conflicts, so such a row is always a fresh insert. */
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
  migrationStatus?: MailMessageMigrationStatus;
  previewText?: string | null;
  ingestedAt?: Date | null;
  /** Written on insert only; a conflicting upsert keeps the stored value. Defaults to `false`. */
  isBulk?: boolean;
}

/**
 * Keyed by `(mailbox_item_id, message_id)` — a `Message-ID` is global, but the same message
 * delivered to two of the user's mailboxes is two Emails items, one per mailbox, each with its
 * own read/flag state. Within one mailbox an optimistic outgoing insert (issue #27) and the
 * sync worker later confirming the same message in Sent converge onto one row via
 * `ON CONFLICT (mailbox_item_id, message_id) DO UPDATE`, filling in provider-specific ids
 * instead of creating a duplicate. `item_id` is the caller's freshly-created (or existing)
 * Email item id either way.
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
                                     delivered_to_address, message_kind, dsn_original_message_id, migration_status, mailbox_item_id, preview_text, ingested_at, is_bulk)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16)
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
      input.migrationStatus ?? "stable",
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

/** The ingest dedup lookup: this mailbox's row for `messageId`, if it already ingested it. */
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

/**
 * Any row for `messageId`, across mailboxes — kept for the legacy-Emails migration's collision
 * check only. Since message identity is per mailbox, several rows can share one `message_id`;
 * this returns the first of them (lowest `item_id`), so it is never a dedup key for ingest.
 */
export async function getMailMessageMetaByMessageId(
  client: Queryable,
  messageId: string,
): Promise<MailMessageMetaRow | null> {
  const { rows } = await client.query<MailMessageMetaDbRow>(
    `SELECT ${COLUMNS} FROM mail_message_meta WHERE message_id = $1 ORDER BY item_id LIMIT 1`,
    [messageId],
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

/**
 * The partial-unique index that arbitrates distinct `message_id`s racing to the same non-null
 * `provider_message_id` within a tenant. Migration 0082 (#1065) dropped the legacy global one.
 */
const PROVIDER_MESSAGE_ID_CONFLICT_CONSTRAINT = "mail_message_meta_tenant_provider_msg_uq";

/**
 * True when a Postgres error is a `23505` raised by the provider-message-id arbiter (see
 * `PROVIDER_MESSAGE_ID_CONFLICT_CONSTRAINT`) — the concurrency-safe signal that ingest.ts's
 * SAVEPOINT-guarded catch converges on. Mirrors chokePoint/viewsStore.ts's own
 * `isUniqueViolation` helper.
 */
export function isProviderMessageIdConflict(err: unknown): boolean {
  const pgErr = err as { code?: string; constraint?: string };
  return pgErr?.code === "23505" && pgErr.constraint === PROVIDER_MESSAGE_ID_CONFLICT_CONSTRAINT;
}

/**
 * Compensating delete for mail/send.ts's pre-SMTP claim: if the claim row was written but the
 * SMTP call itself then failed, the claim must not persist — otherwise the item would look
 * "already sent" forever with no message actually delivered, and a genuine retry could never
 * re-claim it.
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
    // The claim may have created its thread (mail/send.ts threads at claim time); drop it when the
    // deleted row was its only message, so a failed send leaves no empty `mail_threads` row.
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
 * Deletes the `mail_message_meta` row of the permanently deleted Emails item `itemId` (issue gh-1691),
 * in the purge's transaction. An item without a row, as an unsent draft is, and a row that names no
 * thread end it there.
 *
 * When no other `mail_message_meta` row names the row's thread (the row of a message in the trash
 * counts as naming it), the thread goes too, the way `deleteMailMessageMetaByItemId` removes an
 * emptied thread: the Threads item the `mail_threads` row is bound to is trashed through the choke
 * point as the system writer, then the row is deleted, and the aliases that point at it go with it by
 * their foreign key. A Threads item that is already in the trash is left as it is. Unlike that cleanup
 * it does not fail on a thread whose Threads item is already purged, nor on a row bound to no item:
 * it deletes the row.
 *
 * It takes the tenant's mail-thread mutation guard before its first statement on a mail table.
 * Constrained by: docs/adr/2026-11-11-mail-purge-hook-takes-the-thread-guard-after-the-purge-locks.md
 */
export async function deleteMailMessageMetaOfPurgedItem(client: PoolClient, itemId: string): Promise<void> {
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

/**
 * Moves every message out of `fromThreadId` into `toThreadId`, records the alias `fromThreadId -> toThreadId`,
 * repoints every alias that already targeted `fromThreadId`, then deletes the now-empty `mail_threads` row. Run it
 * in one transaction. Nothing else references `mail_threads` except `mail_message_meta.thread_id` and the aliases,
 * so after these statements `fromThreadId` has no remaining referencer; leaving it would accumulate an orphaned row on
 * every dummy-container merge (threading.ts's self-heal path). Merging a thread with itself does nothing.
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
    await transferMailThreadRelationsWithClient(client, database.id, loserId, winnerId);
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
 * Translates a possibly merged-away thread id to the live one in a single query: the alias target, the input id
 * when it is a live `mail_threads` row, or `null` when it is neither (aliases are always one step, see `reassignThread`).
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

/** One `mail_message_meta` row that has no thread yet, with its item's subject for `resolveThreadId`'s hint. */
export interface UnthreadedMailMessage {
  itemId: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  subject: string | null;
}

/**
 * The next keyset page (`item_id` order, after `afterItemId`) of rows whose `thread_id` is still NULL, locked
 * with `FOR UPDATE OF m` for the caller's transaction, so no concurrent writer can thread a row between this read
 * and the `thread_id` write that follows it. A `LEFT JOIN` keeps a row whose item is missing: it is still threaded,
 * just without a subject hint.
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
 * The next keyset page (`message_id` order, after `afterMessageId`) of `Message-ID`s that occur in more than one
 * mailbox and whose rows name more than one thread. A candidate list only: the caller re-reads each one with
 * `lockMailMessageThreads` and decides on that locked read, not on this one.
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
 * Locks every row of one `Message-ID` (`FOR UPDATE`) for the caller's transaction and returns its distinct thread
 * ids, lowest first, the order `resolveThreadId` uses to pick a merge target. An empty or one-element result means
 * there is nothing left to merge.
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
