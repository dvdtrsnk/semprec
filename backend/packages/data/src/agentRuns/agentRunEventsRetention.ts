import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";

/**
 * Older rows that precede their conversation's latest `compaction` checkpoint are deleted. The checkpoint and
 * everything after it stay, so reconstruction (which resets to the latest checkpoint) is unaffected.
 */
export const AGENT_RUN_EVENTS_RETENTION_DAYS = 30;

/** Bounds each transaction's lock footprint. */
const RETENTION_DELETE_BATCH_SIZE = 1000;

/**
 * A thread's main conversation, grouped by `thread_id`. A delegated session inherits `thread_id` but has a
 * `parent_run_id`, so it falls under the generic grouping.
 */
const THREAD_MAIN_CONVERSATION = `(r.thread_id IS NOT NULL AND r.triggered_by = 'user' AND r.parent_run_id IS NULL)`;

/** A thread's main conversation has `thread_id` set and the other key columns null; any other has `thread_id` null. */
type CompactedConversationRow = {
  thread_id: string | null;
  project_item_id: string | null;
  triggered_by: string | null;
  parent_run_id: string | null;
  compaction_id: string;
};

/**
 * Deletes rows that are older than the retention window, belong to a finished `unit = 'session'` run, and precede
 * their conversation's latest checkpoint (`e.id < compaction_id`, so the latest checkpoint itself survives). The
 * `status <> 'running'` guard keeps a live run's events even when an earlier checkpoint precedes them.
 *
 * Each batch is its own transaction. Row-level security narrows everything to the caller's tenant scope.
 */
async function deleteExpiredRunEventsInScope(pool: Pool): Promise<number> {
  const { rows: conversations } = await pool.query<CompactedConversationRow>(
    `SELECT CASE WHEN ${THREAD_MAIN_CONVERSATION} THEN r.thread_id END AS thread_id,
            CASE WHEN ${THREAD_MAIN_CONVERSATION} THEN NULL ELSE r.project_item_id END AS project_item_id,
            CASE WHEN ${THREAD_MAIN_CONVERSATION} THEN NULL ELSE r.triggered_by END AS triggered_by,
            CASE WHEN ${THREAD_MAIN_CONVERSATION} THEN NULL ELSE r.parent_run_id END AS parent_run_id,
            max(e.id) AS compaction_id
     FROM agent_run_events e
     JOIN agent_runs r ON r.id = e.agent_run_id
     WHERE e.kind = 'compaction' AND r.unit = 'session'
     GROUP BY 1, 2, 3, 4`,
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
               AND (
                 ($1::uuid IS NOT NULL AND ${THREAD_MAIN_CONVERSATION} AND r.thread_id = $1::uuid)
                 OR ($1::uuid IS NULL AND NOT ${THREAD_MAIN_CONVERSATION}
                     AND r.project_item_id IS NOT DISTINCT FROM $2
                     AND r.triggered_by = $3
                     AND r.parent_run_id IS NOT DISTINCT FROM $4)
               )
               AND e.id < $5
               AND e.at < now() - make_interval(days => $6)
             ORDER BY e.id
             LIMIT $7
           )`,
          [
            conversation.thread_id,
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
  return deleted;
}

/**
 * Grouping and checkpoints are per tenant, so one tenant's checkpoint never decides what another keeps. Rejects
 * after every tenant was attempted when any failed.
 */
export async function handleAgentRunEventsRetentionTask(pool: Pool): Promise<{ deleted: number }> {
  let deleted = 0;
  await forEachActiveTenant(pool, async () => {
    deleted += await deleteExpiredRunEventsInScope(pool);
  });
  return { deleted };
}
