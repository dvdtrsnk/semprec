/**
 * Dedupe keys of the Semp status problems that producers raise next to an existing notification.
 * `semp_problems.dedupe_key` is scoped to the tenant, not to the category, so each builder
 * carries its own prefix.
 */

export function guidanceProblemKey(projectItemId: string, fingerprint: string): string {
  return `guidance:${projectItemId}:${fingerprint}`;
}

export function automationProblemKey(databaseId: string): string {
  return `automation:${databaseId}`;
}

/**
 * The one problem of a mailbox that is not syncing (issue #1506). The sync job's failure reports and
 * the `mail:<mailboxItemId>` stall check both raise it under this key, so the reports merge.
 */
export function mailProblemKey(mailboxItemId: string): string {
  return `mail:${mailboxItemId}`;
}

/** The one backup problem: the monthly restore test. */
export const BACKUP_RESTORE_PROBLEM_KEY = "backup:restoreTest";

/** The stale `agents` process problem; no other process raises one. */
export const AGENTS_PROCESS_PROBLEM_KEY = "agents:process";
