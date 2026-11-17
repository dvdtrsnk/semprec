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

export const BACKUP_RESTORE_PROBLEM_KEY = "backup:restoreTest";

export const AGENTS_PROCESS_PROBLEM_KEY = "agents:process";
