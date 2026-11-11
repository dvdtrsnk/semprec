// The `mailboxRemoval` task (issue gh-2029): soft-deletes a removed mailbox's Emails and Folders in
// committed chunks, each row with the Mailboxes item's own deletion time.
// Constrained by: docs/adr/2026-11-10-a-mailbox-removal-job-joins-the-mailbox-trash-epoch.md,
// docs/adr/2026-09-28-chunked-transactions-for-large-background-sweeps.md
import type { Pool } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { lockItemTrashEpoch } from "../chokePoint/itemsStore.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { withTransaction, type Queryable } from "../db/pool.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { tenantLane } from "../tenancy/tenantLane.js";
import { resolveMailModuleIds, type MailModuleIds } from "./mailModuleIds.js";
import { MAILBOX_REMOVAL_MEMBERS_CTE_SQL } from "./mailboxRemovalImpact.js";

/** Rows soft-deleted per transaction, the page size of the chunked-sweep ADR named above. */
const MAILBOX_REMOVAL_CHUNK_SIZE = 100;
const MAILBOX_REMOVAL_LANE = "mailbox-removal";

const payloadSchema = z.object({ mailboxItemId: z.uuid() }).strict();

export function mailboxRemovalJobKey(mailboxItemId: string): string {
  return `mailbox-removal-${mailboxItemId}`;
}

/**
 * Queues the job for one removed mailbox on the tenant's `mailbox-removal` lane. The removal calls it
 * inside its own transaction, so the job exists only when the removal commits.
 */
export async function enqueueMailboxRemoval(client: Queryable, mailboxItemId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.MAILBOX_REMOVAL,
    { mailboxItemId },
    { jobKey: mailboxRemovalJobKey(mailboxItemId), queueName: tenantLane(MAILBOX_REMOVAL_LANE) },
  );
}

/** What one phase soft-deletes: the mailbox's Emails (drafts included), then its Folders. */
const PHASES = [
  {
    databaseId: (ids: MailModuleIds) => ids.emailsDatabaseId,
    pageSql: `${MAILBOX_REMOVAL_MEMBERS_CTE_SQL}
SELECT email_id AS id FROM mailbox_emails
 WHERE ($4::uuid IS NULL OR email_id > $4::uuid)
 ORDER BY email_id LIMIT $5`,
  },
  {
    databaseId: (ids: MailModuleIds) => ids.foldersDatabaseId,
    pageSql: `${MAILBOX_REMOVAL_MEMBERS_CTE_SQL}
SELECT id FROM mailbox_folders
 WHERE ($4::uuid IS NULL OR id > $4::uuid)
 ORDER BY id LIMIT $5`,
  },
] as const;

/**
 * Soft-deletes the Emails and Folders of removed mailbox `mailboxItemId` in the job's tenant scope.
 *
 * The rows are the members the removal impact report counts (`MAILBOX_REMOVAL_MEMBERS_CTE_SQL`):
 * the non-deleted Emails in the mailbox's non-deleted Folders, drafts included, and those Folders. Mail
 * of another mailbox is not a member, so a thread that also holds such a message keeps it. Emails go
 * first, because membership is read through the live Folders. The attachments' Files items and blobs
 * are not items of the Email's subtree and are not touched.
 *
 * Each chunk is one transaction over at most `chunkSize` rows (`MAILBOX_REMOVAL_CHUNK_SIZE` unless a
 * test passes a smaller one), in id order after the previous chunk's last id. It first takes the
 * Mailboxes item `FOR SHARE` and reads its trash epoch, so a restore of the mailbox waits for the
 * chunk; when the mailbox is live or gone by then, the job ends there. Every row is trashed through the
 * choke point's cascade as the system writer with that epoch as its `deleted_at`. A row trashed on its
 * own earlier is not a member and keeps its time.
 *
 * A chunk that throws rolls itself back and fails the job; the chunks before it stay committed. A
 * rerun selects only rows that are still live, so it continues and rewrites none of the others.
 */
export async function handleMailboxRemovalTask(
  pool: Pool,
  payload: unknown,
  options: { chunkSize?: number } = {},
): Promise<void> {
  const { mailboxItemId } = payloadSchema.parse(payload);
  const chunkSize = options.chunkSize ?? MAILBOX_REMOVAL_CHUNK_SIZE;
  const queueAffinity = createActionQueueAffinity();
  const ids = await withTransaction(pool, (client) => resolveMailModuleIds(client));

  /** One chunk of `phase` after `afterId`: the ids it selected, or `null` when the mailbox is not in the trash. */
  const runChunk = (phase: (typeof PHASES)[number], afterId: string | null): Promise<string[] | null> =>
    withTransaction(pool, async (client) => {
      const deletedAtExact = await lockItemTrashEpoch(client, ids.mailboxesDatabaseId, mailboxItemId);
      if (deletedAtExact === null) return null;
      const { rows } = await client.query<{ id: string }>(phase.pageSql, [
        mailboxItemId,
        ids.foldersDatabaseId,
        ids.emailsDatabaseId,
        afterId,
        chunkSize,
      ]);
      for (const row of rows) {
        await itemDeleteWithClient(client, phase.databaseId(ids), row.id, {
          queueAffinity,
          writer: SYSTEM_WRITER,
          deletedAtExact,
        });
      }
      return rows.map((row) => row.id);
    });

  for (const phase of PHASES) {
    let afterId: string | null = null;
    for (;;) {
      const page = await runChunk(phase, afterId);
      // The mailbox is live again or gone: nothing of it is left for this job to trash.
      if (page === null) return;
      if (page.length < chunkSize) break;
      afterId = page.at(-1) ?? null;
    }
  }
}
