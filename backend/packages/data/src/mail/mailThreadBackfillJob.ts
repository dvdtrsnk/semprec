import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import {
  listSplitMailMessageIdPage,
  listUnthreadedMailMessagePage,
  lockMailMessageThreads,
  reassignThread,
} from "./mailMessageMetaStore.js";
import { resolveThreadId } from "./threading.js";

const PAGE_SIZE = 200;
const BACKFILL_JOB_KEY = "mail-thread-backfill";

/** Enqueues the one-off backfill under a fixed job key, so repeated deploys collapse into one job. */
export async function enqueueMailThreadBackfill(pool: Pool): Promise<void> {
  await enqueueJob(pool, CORE_TASK_NAMES.MAIL_THREAD_BACKFILL, {}, { jobKey: BACKFILL_JOB_KEY, maxAttempts: 3 });
}

/**
 * Pass 1: gives a thread to every row whose `thread_id` is still NULL (in practice, sent messages stored before
 * #1474). Each row goes through the same `resolveThreadId` that live ingest uses, with the row's own headers and its
 * item's subject. A child processed before its parent starts a thread; when the parent is processed, its own
 * `resolveThreadId` finds that thread through the self-heal lookup, joins it, and merges in any other thread its
 * ancestors already have. Keyset pages, one transaction per page.
 */
async function threadUnthreadedMessages(pool: Pool): Promise<void> {
  let afterItemId: string | null = null;
  for (;;) {
    const lastItemId: string | null = await withTransaction(pool, async (client) => {
      await lockMailThreadMutation(client);
      const rows = await listUnthreadedMailMessagePage(client, afterItemId, PAGE_SIZE);
      for (const row of rows) {
        const threadId = await resolveThreadId(client, {
          messageId: row.messageId,
          inReplyTo: row.inReplyTo,
          references: row.references,
          subjectHint: row.subject ?? undefined,
        });
        const result = await client.query(
          `UPDATE mail_message_meta SET thread_id = $2 WHERE item_id = $1 AND thread_id IS NULL`,
          [row.itemId, threadId],
        );
        requireAffectedRows(result, `mail thread backfill for item ${row.itemId}`);
      }
      return rows.length === PAGE_SIZE ? (rows[rows.length - 1]?.itemId ?? null) : null;
    });
    if (lastItemId === null) return;
    afterItemId = lastItemId;
  }
}

/**
 * Pass 2: merges the threads of every `Message-ID` that is split across mailboxes. The page only proposes candidates;
 * each one is then locked and re-read, and the merge uses that locked read. A candidate that an earlier merge in the
 * same run already joined has nothing left to merge and is skipped. Keyset pages, one transaction per page.
 */
async function mergeSplitMessageCopies(pool: Pool): Promise<void> {
  let afterMessageId: string | null = null;
  for (;;) {
    const lastMessageId: string | null = await withTransaction(pool, async (client) => {
      await lockMailThreadMutation(client);
      const messageIds = await listSplitMailMessageIdPage(client, afterMessageId, PAGE_SIZE);
      for (const messageId of messageIds) {
        const [target, ...others] = await lockMailMessageThreads(client, messageId);
        if (target === undefined || others.length === 0) continue;
        for (const other of others) {
          await reassignThread(client, other, target);
        }
      }
      return messageIds.length === PAGE_SIZE ? (messageIds[messageIds.length - 1] ?? null) : null;
    });
    if (lastMessageId === null) return;
    afterMessageId = lastMessageId;
  }
}

/**
 * The `mailThreadBackfill` core task: for every active tenant, threads the rows that have no thread, then merges the
 * copies of one `Message-ID` that sit in different threads. Each tenant runs inside its own scope, and
 * `forEachActiveTenant` rethrows any failing tenant as one `AggregateError` after the others were processed, so the
 * job is retried. A run over data that an earlier completed run already processed changes no row. See
 * docs/adr/2026-09-28-chunked-transactions-for-large-background-sweeps.md for the paging.
 */
export async function handleMailThreadBackfillTask(pool: Pool): Promise<void> {
  await forEachActiveTenant(pool, async () => {
    await threadUnthreadedMessages(pool);
    await mergeSplitMessageCopies(pool);
  });
}
