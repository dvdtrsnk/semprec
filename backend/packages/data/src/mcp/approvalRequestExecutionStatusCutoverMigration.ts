import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";

/**
 * One-time populated-upgrade cutover for issue #89's exactly-once execution protocol
 * (0044_approval_request_execution_status.sql adds the columns nullable; this finishes the job,
 * mirroring `agentRunsActorUserIdCutoverMigration.ts`'s identical lock/idempotency-check/
 * backfill/tighten shape). Every `approval_requests` row that exists at the moment this runs
 * predates the protocol entirely — none of them were ever snapshotted against a resource, so
 * none can be safely revalidated and replayed. Every one of them, unconditionally, becomes
 * `legacy_terminal`: a still-`pending` request is decided `rejected` first (a decision this
 * deploy's approver never made, so it must not silently execute later), and every row (including
 * an already-`succeeded` mcpInvoke one) gets a `legacy_unavailable` snapshot, a
 * `validation_failed` execution result, and its `executed_at` stamped to this migration's own
 * timestamp — per the issue's "EVERY legacy row" requirement.
 *
 * Any `approvalExecute` job still queued for one of these rows is removed first: after this
 * transaction commits, every row is terminal, so a redelivered job for it must not run the old
 * handler logic against a row whose state it no longer expects. `graphile_worker.jobs` is a
 * read-only view over `_private_jobs`/`_private_tasks` (not a table — deleting from it directly
 * fails with "cannot delete from view"), so the removal targets `_private_jobs` joined back to
 * `_private_tasks` for the identifier instead. `_private_jobs`/`_private_tasks` may not exist yet
 * at this point in a fresh test/CI database — `runMigrationsCli.ts` and `testSupport/globalSetup.ts`
 * both call `ensureQueueSchema` *after* this cutover, matching the existing two cutover migrations
 * it already runs alongside — so the removal is skipped rather than attempted when the schema
 * isn't there; a real deploy always has it already, from the previous release's own
 * `ensureQueueSchema` call.
 */
export async function runApprovalRequestExecutionStatusCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    // Excludes concurrent approval_requests inserts/decisions for the duration of the cutover,
    // so no row can be left without a terminal execution_status after this transaction commits.
    await client.query(`LOCK TABLE approval_requests IN EXCLUSIVE MODE`);

    const { rows: columnRows } = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'approval_requests' AND column_name = 'execution_status'`,
    );
    if (columnRows[0]?.is_nullable === "NO") return; // already migrated

    const { rows: schemaRows } = await client.query<{ exists: boolean }>(
      `SELECT to_regclass('graphile_worker._private_jobs') IS NOT NULL AS exists`,
    );
    if (schemaRows[0]?.exists) {
      await client.query(`
        DELETE FROM graphile_worker._private_jobs AS jobs
         WHERE jobs.task_id IN (
           SELECT id FROM graphile_worker._private_tasks WHERE identifier = 'approvalExecute'
         )
      `);
    }

    await client.query(`UPDATE approval_requests SET status = 'rejected' WHERE status = 'pending'`);

    await client.query(`
      UPDATE approval_requests
         SET resource_snapshot = jsonb_build_object('kind', 'legacy_unavailable', 'resourceId', id, 'sha256', null),
             execution_status = 'legacy_terminal',
             execution_result = jsonb_build_object(
               'error', jsonb_build_object(
                 'code', 'validation_failed',
                 'details', jsonb_build_object('reason', 'approval_snapshot_unavailable')
               )
             ),
             executed_at = now()
    `);

    await client.query(`
      ALTER TABLE approval_requests
        ALTER COLUMN resource_snapshot SET NOT NULL,
        ALTER COLUMN execution_status SET DEFAULT 'not_approved',
        ALTER COLUMN execution_status SET NOT NULL,
        ADD CONSTRAINT approval_requests_execution_status_check
          CHECK (execution_status IN ('not_approved', 'queued', 'succeeded', 'conflict', 'legacy_terminal'))
    `);
  });
}
