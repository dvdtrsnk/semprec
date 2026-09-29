import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";

/**
 * Rows older than this that precede their conversation's latest `compaction` checkpoint are
 * deleted by `handleAgentRunEventsRetentionTask` (issue #692). The checkpoint itself and
 * everything after it are always kept, so reconstruction (`walkStoredEntries`, which resets to
 * the latest `compaction` payload and never reads anything before it) is unaffected. A run-page
 * transcript for a conversation older than this window may show only its post-checkpoint tail.
 */
export const AGENT_RUN_EVENTS_RETENTION_DAYS = 30;

/** Rows deleted per transaction, so one sweep never holds a lock or a transaction open over an unbounded row count. */
const RETENTION_DELETE_BATCH_SIZE = 1000;

/** One conversation (grouping key) that has ever produced a `compaction` checkpoint, and the id of its latest one. */
type CompactedConversationRow = {
  project_item_id: string | null;
  triggered_by: string;
  parent_run_id: string | null;
  compaction_id: string;
};

/**
 * The `agentRunEventsRetention` daily core task (issue #692): deletes `agent_run_events` rows
 * that are (1) older than `AGENT_RUN_EVENTS_RETENTION_DAYS`, (2) attached to a finished
 * (`status <> 'running'`) `unit = 'session'` run, and (3) precede their conversation's latest
 * `compaction` checkpoint (`e.id < compaction_id`). A `compaction` row itself is never deleted
 * by this task: the strict `<` excludes the latest one, and an older checkpoint superseded by a
 * later one only qualifies once it is itself below that later checkpoint's id, at which point
 * reconstruction no longer reads it either.
 *
 * The `r.status <> 'running'` guard means a live run's events are never touched, even when they
 * are old and precede a checkpoint from an earlier run in the same conversation.
 *
 * Deletes in batches of `RETENTION_DELETE_BATCH_SIZE`, each in its own transaction — the same
 * per-unit chunking `docHistoryCleanup` uses to keep every transaction's lock footprint small —
 * looping per conversation until a batch deletes fewer than the batch size.
 */
export async function handleAgentRunEventsRetentionTask(pool: Pool): Promise<{ deleted: number }> {
  const { rows: conversations } = await pool.query<CompactedConversationRow>(
    `SELECT r.project_item_id, r.triggered_by, r.parent_run_id, max(e.id) AS compaction_id
     FROM agent_run_events e
     JOIN agent_runs r ON r.id = e.agent_run_id
     WHERE e.kind = 'compaction' AND r.unit = 'session'
     GROUP BY 1, 2, 3`,
  );

  let deleted = 0;
  for (const conversation of conversations) {
    for (;;) {
      const batchDeleted = await withTransaction(pool, async (client) => {
        const { rowCount } = await client.query(
          `DELETE FROM agent_run_events WHERE id IN (
             SELECT e.id FROM agent_run_events e
             JOIN agent_runs r ON r.id = e.agent_run_id
             WHERE r.unit = 'session'
               AND r.status <> 'running'
               AND r.project_item_id IS NOT DISTINCT FROM $1
               AND r.triggered_by = $2
               AND r.parent_run_id IS NOT DISTINCT FROM $3
               AND e.id < $4
               AND e.at < now() - make_interval(days => $5)
             ORDER BY e.id
             LIMIT $6
           )`,
          [
            conversation.project_item_id,
            conversation.triggered_by,
            conversation.parent_run_id,
            conversation.compaction_id,
            AGENT_RUN_EVENTS_RETENTION_DAYS,
            RETENTION_DELETE_BATCH_SIZE,
          ],
        );
        return rowCount ?? 0;
      });
      deleted += batchDeleted;
      if (batchDeleted < RETENTION_DELETE_BATCH_SIZE) break;
    }
  }
  return { deleted };
}
