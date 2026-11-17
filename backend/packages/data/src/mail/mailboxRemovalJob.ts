// Soft-deletes a removed mailbox's Emails and Folders in committed chunks, each row with the Mailboxes
// item's own deletion time.
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

const MAILBOX_REMOVAL_CHUNK_SIZE = 100;
const MAILBOX_REMOVAL_LANE = "mailbox-removal";

const payloadSchema = z.object({ mailboxItemId: z.uuid() }).strict();

export function mailboxRemovalJobKey(mailboxItemId: string): string {
  return `mailbox-removal-${mailboxItemId}`;
}

/** Called inside the removal transaction, so the job exists only when the removal commits. */
export async function enqueueMailboxRemoval(client: Queryable, mailboxItemId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.MAILBOX_REMOVAL,
    { mailboxItemId },
    { jobKey: mailboxRemovalJobKey(mailboxItemId), queueName: tenantLane(MAILBOX_REMOVAL_LANE) },
  );
}

/** Emails go first, because membership is read through the live Folders. */
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
 * Members are those of `MAILBOX_REMOVAL_MEMBERS_CTE_SQL`; another mailbox's mail in the same thread is
 * kept, and attachment Files and blobs are not touched.
 *
 * Each chunk is one transaction that first takes the Mailboxes item `FOR SHARE` and reads its trash
 * epoch, so a restore waits for the chunk; a live or gone mailbox ends the job. Rows are trashed as the
 * system writer with that epoch as `deleted_at`. A failed chunk rolls back alone; a rerun selects only
 * rows still live.
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
      if (page === null) return;
      if (page.length < chunkSize) break;
      afterId = page.at(-1) ?? null;
    }
  }
}
