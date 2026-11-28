/** Keys of problems raised next to a notification. `dedupe_key` is tenant-scoped, so each key carries a prefix. */

export function guidanceProblemKey(projectItemId: string, fingerprint: string): string {
  return `guidance:${projectItemId}:${fingerprint}`;
}

export function automationProblemKey(databaseId: string): string {
  return `automation:${databaseId}`;
}

/** Shared by the sync job's failure reports and the stall check, so they merge. */
export function mailProblemKey(mailboxItemId: string): string {
  return `mail:${mailboxItemId}`;
}

/** A mailbox's Sent copies that could not be appended; one per mailbox, apart from its sync problem. */
export function mailSentCopyProblemKey(mailboxItemId: string): string {
  return `mail:sentCopy:${mailboxItemId}`;
}

/** An internet account's calendar sync failure; one per account, apart from its mail problem. */
export function calendarProblemKey(accountItemId: string): string {
  return `calendar:${accountItemId}`;
}

export const BACKUP_RESTORE_PROBLEM_KEY = "backup:restoreTest";

export const AGENTS_PROCESS_PROBLEM_KEY = "agents:process";
