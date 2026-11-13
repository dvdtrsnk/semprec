import type { PoolClient } from "pg";
import { z } from "zod";
import { NotFoundError } from "../errors.js";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { resolveMergedThreadId } from "./mailMessageMetaStore.js";
import { mailThreadCopyCtes } from "./mailThreadListQuery.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";

/**
 * One live Emails copy of a mail thread, as the thread actions see it. A message delivered to several
 * mailboxes is several copies with one `messageId`.
 */
export interface MailThreadActionMessage {
  /** The copy's Emails item. */
  itemId: string;
  messageId: string;
  /** The copy's `read` property (an absent one reads as `false`). */
  read: boolean;
  /**
   * Whether the copy is incoming mail: its sender is none of the tenant's mailbox addresses and it is in
   * neither a Sent nor a Drafts folder.
   */
  incoming: boolean;
}

export interface MailThreadActionMessages {
  /** Every live copy of the thread, in any folder or mailbox, ordered by item id. */
  messages: MailThreadActionMessage[];
  /**
   * The `messageId` of the last incoming message: that of the incoming copy with the latest activity, then
   * the highest item id (the order the thread list picks a thread's latest copy in). `null` when the thread
   * has no incoming copy.
   */
  lastIncomingMessageId: string | null;
}

const messageRow = z.object({
  itemId: z.uuid(),
  messageId: z.string(),
  read: z.boolean(),
  incoming: z.boolean(),
  lastIncoming: z.boolean(),
});

/**
 * Starts a thread action in the caller's READ COMMITTED tenant transaction: takes the tenant's mail-thread guard
 * (`lockMailThreadMutation`) and then resolves the thread id. A merged-away id is translated to the thread that
 * absorbed it (issue #1493), a live id is returned as it is. An unknown id and another tenant's id (row-level
 * security hides it) both throw the same `NotFoundError`.
 *
 * The guard comes first, before the thread is resolved and before any copy is locked, as it does in the reconcilers
 * and ingest ([[2026-11-01-mail-thread-mutations-use-a-tenant-transaction-guard]]): a reconcile pass holds the
 * guard for its whole transaction and locks Emails items one after another in provider order, so a thread action
 * that locked several copies in item id order without it could wait on a copy the pass holds while the pass waits
 * on one of its own, a deadlock no layer answers as a domain error. Every thread action calls this first; see
 * [[2026-11-13-mail-thread-actions-take-the-thread-guard-before-their-item-locks]].
 */
export async function resolveMailThreadForAction(client: PoolClient, threadId: string): Promise<string> {
  await lockMailThreadMutation(client);
  const resolved = await resolveMergedThreadId(client, threadId);
  if (resolved === null) throw new NotFoundError("Thread not found");
  return resolved;
}

/**
 * The copies of thread `threadId` (an id `resolveMailThreadForAction` returned) in the thread detail's view
 * of the thread: every live copy, drafts included, read from the CTEs the thread list and the detail share
 * (`mailThreadCopyCtes`). A copy in a Drafts folder is never incoming, whoever the sender is.
 */
export async function listMailThreadActionMessages(
  client: PoolClient,
  threadId: string,
): Promise<MailThreadActionMessages> {
  const { rows } = await client.query<{ message: unknown }>(
    `
WITH ${mailThreadCopyCtes(1)}, classified AS (
  SELECT c.item_id, c.message_id, c.is_read, c.activity,
    NOT c.own AND NOT c.has_sent AND NOT EXISTS (
      SELECT 1 FROM items f
      WHERE f.tenant_id = app_tenant_default() AND f.id = ANY(c.folder_ids) AND f.properties->>'specialPurpose' = 'drafts'
    ) AS incoming
  FROM copies c
), last_incoming AS (
  SELECT item_id FROM classified WHERE incoming ORDER BY activity DESC NULLS LAST, item_id DESC LIMIT 1
)
SELECT jsonb_build_object(
  'itemId', k.item_id, 'messageId', k.message_id, 'read', k.is_read, 'incoming', k.incoming,
  'lastIncoming', COALESCE(k.item_id = (SELECT item_id FROM last_incoming), false)
) AS message
FROM classified k
ORDER BY k.item_id
`,
    [threadId],
  );
  const parsed = rows.map((row) => messageRow.parse(row.message));
  return {
    messages: parsed.map(({ itemId, messageId, read, incoming }) => ({ itemId, messageId, read, incoming })),
    lastIncomingMessageId: parsed.find((message) => message.lastIncoming)?.messageId ?? null,
  };
}

/**
 * Whether thread `threadId` (an id `resolveMailThreadForAction` returned) is unread, as the thread detail reports
 * it: some live copy, drafts included, is neither the user's own mail nor in Sent and has no `read` flag set
 * (`copy_stats` of `mailThreadCopyCtes` with a thread id). A thread without a live copy is not unread.
 *
 * The thread list leaves drafts out of that aggregate (`mailThreadCopyCtes`), the detail and this value do not.
 * A thread action never writes a copy in a Drafts folder, so a draft whose sender is none of the tenant's
 * mailbox addresses and that has no `read` flag keeps the value `true` after `read: true`, as the detail shows it.
 */
export async function readMailThreadUnread(client: PoolClient, threadId: string): Promise<boolean> {
  const { rows } = await client.query<{ unread: boolean }>(
    `WITH ${mailThreadCopyCtes(1)} SELECT COALESCE((SELECT unread FROM copy_stats), false) AS unread`,
    [threadId],
  );
  return rows[0]?.unread === true;
}

/**
 * Announces after the commit of the caller's transaction that mail thread `threadId` changed: one thin
 * `mailThread` invalidation to every socket of the tenant (issue #1816), so a client refetches the thread,
 * the mailbox counts and the overview. A rolled-back transaction announces nothing. `threadId` is the id a
 * client knows the thread by now, which is the id `resolveMailThreadForAction` returned.
 */
export function announceMailThreadChanged(client: PoolClient, threadId: string): void {
  runAfterCommit(client, () => notifyInvalidation({ scope: "mailThread", threadId }));
}
