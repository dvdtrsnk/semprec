import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import type { Queryable } from "../db/pool.js";

export function mailAccountSyncJobKey(mailboxItemId: string): string {
  return `mail-account-sync:${mailboxItemId}`;
}

/**
 * Ahead of the default-priority jobs on the same worker: a new account's index enqueues follow-up jobs per message
 * (link propagation, search reindex) by the thousand, and new mail must not wait for them.
 */
export const MAIL_ACCOUNT_SYNC_PRIORITY = -1;

export async function enqueueMailAccountSync(client: Queryable, mailboxItemId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC,
    { mailboxItemId },
    { jobKey: mailAccountSyncJobKey(mailboxItemId), maxAttempts: 1, priority: MAIL_ACCOUNT_SYNC_PRIORITY },
  );
}

/**
 * Follow-up passes after an accepted IMAP/SMTP send. Some servers (Purelymail) do not push their own deliveries to an
 * IDLE session: a message the account sent to itself, or the bounce of a refused recipient, lands in INBOX seconds
 * after the send and nothing signals it. Two delayed passes pick such a delivery up.
 */
export const MAIL_POST_SEND_SYNC_DELAYS_MS = [15_000, 60_000] as const;

export function mailPostSendSyncJobKey(mailboxItemId: string, delayMs: number): string {
  return `mail-account-sync-after-send:${delayMs}:${mailboxItemId}`;
}

/**
 * Enqueues one `mailAccountSync` per follow-up slot on `client`, in the transaction that records the send. Keyed per
 * mailbox and slot with `preserve_run_at`: a send while a slot is pending keeps its due time, so sends coalesce to one
 * pending follow-up per slot and a stream of sends cannot postpone it. The job is the normal pass with its single
 * attempt: one that starts during a pass only asks that pass for one more round, and one that starts while the account
 * backs off a failure ends in the job's prologue without a provider call.
 */
export async function enqueuePostSendMailSyncs(client: Queryable, mailboxItemId: string): Promise<void> {
  const now = Date.now();
  for (const delayMs of MAIL_POST_SEND_SYNC_DELAYS_MS) {
    await enqueueJob(
      client,
      CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC,
      { mailboxItemId },
      {
        jobKey: mailPostSendSyncJobKey(mailboxItemId, delayMs),
        jobKeyMode: "preserve_run_at",
        runAt: new Date(now + delayMs),
        maxAttempts: 1,
        priority: MAIL_ACCOUNT_SYNC_PRIORITY,
      },
    );
  }
}
