import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import type { Queryable } from "../db/pool.js";

export function mailAccountSyncJobKey(mailboxItemId: string): string {
  return `mail-account-sync:${mailboxItemId}`;
}

export async function enqueueMailAccountSync(client: Queryable, mailboxItemId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC,
    { mailboxItemId },
    { jobKey: mailAccountSyncJobKey(mailboxItemId), maxAttempts: 3 },
  );
}
