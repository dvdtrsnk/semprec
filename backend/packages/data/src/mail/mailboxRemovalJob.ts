// Soft-deletes the Emails and Folders of a mailbox in committed chunks: of a removed mailbox, each row with the
// Mailboxes item's own deletion time; of a live mailbox whose Mail was switched off, each row with the pause time,
// releasing each Email's meta row and emptied thread.
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { lockItemTrashEpoch } from "../chokePoint/itemsStore.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { withTransaction, type Queryable } from "../db/pool.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { tenantLane } from "../tenancy/tenantLane.js";
import { lockMailAccountSyncPause } from "./mailAccountSyncStateStore.js";
import { deleteMailMessageMetaOfRemovedItem } from "./mailMessageMetaStore.js";
import { resolveMailModuleIds, type MailModuleIds } from "./mailModuleIds.js";
import { MAILBOX_REMOVAL_MEMBERS_CTE_SQL } from "./mailboxRemovalImpact.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";

const MAILBOX_REMOVAL_CHUNK_SIZE = 100;
const MAILBOX_REMOVAL_LANE = "mailbox-removal";

/** Without `purpose` the job is a removal's. */
const payloadSchema = z.object({ mailboxItemId: z.uuid(), purpose: z.literal("mailOff").optional() }).strict();

export function mailboxRemovalJobKey(mailboxItemId: string): string {
  return `mailbox-removal-${mailboxItemId}`;
}

export function mailboxMailOffJobKey(mailboxItemId: string): string {
  return `mailbox-mail-off-${mailboxItemId}`;
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

/**
 * Called inside the transaction that switches the account's Mail off, so the job exists only when the switch commits.
 * Same task and lane as a removal, under its own key, so neither replaces the other.
 */
export async function enqueueMailboxMailOff(client: Queryable, mailboxItemId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.MAILBOX_REMOVAL,
    { mailboxItemId, purpose: "mailOff" },
    { jobKey: mailboxMailOffJobKey(mailboxItemId), queueName: tenantLane(MAILBOX_REMOVAL_LANE) },
  );
}

/** Emails go first, because membership is read through the live Folders. */
const PHASES = [
  {
    kind: "emails",
    databaseId: (ids: MailModuleIds) => ids.emailsDatabaseId,
    pageSql: `${MAILBOX_REMOVAL_MEMBERS_CTE_SQL}
SELECT email_id AS id FROM mailbox_emails
 WHERE ($4::uuid IS NULL OR email_id > $4::uuid)
 ORDER BY email_id LIMIT $5`,
  },
  {
    kind: "folders",
    databaseId: (ids: MailModuleIds) => ids.foldersDatabaseId,
    pageSql: `${MAILBOX_REMOVAL_MEMBERS_CTE_SQL}
SELECT id FROM mailbox_folders
 WHERE ($4::uuid IS NULL OR id > $4::uuid)
 ORDER BY id LIMIT $5`,
  },
] as const;

/**
 * Mail-off: the mail-thread guard first (the order a sync pass takes it in), then the paused sync state row and the
 * live Mailboxes item `FOR SHARE`, so switching Mail on again waits for the chunk. `null` (the account is no longer
 * paused, or the mailbox is trashed or gone) ends the job.
 */
async function lockMailOffEpoch(client: PoolClient, ids: MailModuleIds, mailboxItemId: string): Promise<string | null> {
  await lockMailThreadMutation(client);
  const pausedAt = await lockMailAccountSyncPause(client, mailboxItemId);
  if (pausedAt === null) return null;
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM items WHERE database_id = $1 AND id = $2 AND deleted_at IS NULL FOR SHARE",
    [ids.mailboxesDatabaseId, mailboxItemId],
  );
  return rows.length === 0 ? null : pausedAt;
}

/**
 * Members are those of `MAILBOX_REMOVAL_MEMBERS_CTE_SQL`; another mailbox's mail in the same thread is kept, and
 * attachment Files and blobs are not touched.
 *
 * Removal: each chunk is one transaction that first takes the Mailboxes item `FOR SHARE` and reads its trash epoch,
 * so a restore waits for the chunk; a live or gone mailbox ends the job. Rows are trashed as the system writer with
 * that epoch as `deleted_at`.
 *
 * Mail-off: each chunk locks as `lockMailOffEpoch` does and trashes with the pause time as `deleted_at`. Each trashed
 * Email also loses its meta row (and a thread no other message names), so the account's mail is ingested anew once
 * Mail is on again instead of converging onto trashed items.
 *
 * A failed chunk rolls back alone; a rerun selects only rows still live.
 */
export async function handleMailboxRemovalTask(
  pool: Pool,
  payload: unknown,
  options: { chunkSize?: number } = {},
): Promise<void> {
  const { mailboxItemId, purpose } = payloadSchema.parse(payload);
  const chunkSize = options.chunkSize ?? MAILBOX_REMOVAL_CHUNK_SIZE;
  const queueAffinity = createActionQueueAffinity();
  const ids = await withTransaction(pool, (client) => resolveMailModuleIds(client));

  const runChunk = (phase: (typeof PHASES)[number], afterId: string | null): Promise<string[] | null> =>
    withTransaction(pool, async (client) => {
      const deletedAtExact =
        purpose === "mailOff"
          ? await lockMailOffEpoch(client, ids, mailboxItemId)
          : await lockItemTrashEpoch(client, ids.mailboxesDatabaseId, mailboxItemId);
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
        if (purpose === "mailOff" && phase.kind === "emails") await deleteMailMessageMetaOfRemovedItem(client, row.id);
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
