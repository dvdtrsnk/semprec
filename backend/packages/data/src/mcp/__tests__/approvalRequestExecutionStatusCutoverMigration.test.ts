import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { enqueueJob } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { getApprovalRequest } from "../approvalRequestsStore.js";
import { runApprovalRequestExecutionStatusCutoverMigration } from "../approvalRequestExecutionStatusCutoverMigration.js";

let pool: Pool;

async function createUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'unused') RETURNING id`,
    [`${randomUUID()}@example.com`],
  );
  return rows[0]!.id;
}

/**
 * `globalSetup.ts` already runs this migration once against a fresh (empty) database, so its
 * happy-path "already migrated" early-return is exercised by every other integration test in this
 * suite, but its actual backfill logic against pre-existing rows never is. This test reverts the
 * three columns issue #89 added back to their nullable, unconstrained "just after the additive SQL
 * migration" shape, inserts rows in that old shape (mirroring what a real pre-#89 deploy's rows
 * looked like), then re-invokes the cutover directly to exercise the backfill for real.
 */
describe("runApprovalRequestExecutionStatusCutoverMigration (issue #89)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await pool.query(`
      ALTER TABLE approval_requests
        ALTER COLUMN resource_snapshot DROP NOT NULL,
        ALTER COLUMN execution_status DROP NOT NULL,
        ALTER COLUMN execution_status DROP DEFAULT,
        DROP CONSTRAINT IF EXISTS approval_requests_execution_status_check
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("terminalizes every pre-existing row as legacy_terminal, rejects still-pending rows, and removes queued approvalExecute jobs", async () => {
    await createUser();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "legacy" });
    const decidedByUserId = await createUser();

    const { rows: pendingRows } = await pool.query<{ id: string }>(
      `INSERT INTO approval_requests (agent_run_id, tool_name, risk_class, payload)
       VALUES ($1, 'search_web', 'unclassified', $2::jsonb) RETURNING id`,
      [run.id, JSON.stringify({ mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} })],
    );
    const pendingId = pendingRows[0]!.id;

    const { rows: approvedRows } = await pool.query<{ id: string }>(
      `INSERT INTO approval_requests (agent_run_id, tool_name, risk_class, payload, status, decided_at, decided_by)
       VALUES ($1, 'search_web', 'unclassified', $2::jsonb, 'approved', now(), $3) RETURNING id`,
      [
        run.id,
        JSON.stringify({ mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} }),
        decidedByUserId,
      ],
    );
    const approvedId = approvedRows[0]!.id;

    await enqueueJob(
      pool,
      "approvalExecute",
      { approvalRequestId: approvedId },
      { jobKey: `approval-request-execute-${approvedId}` },
    );
    await enqueueJob(
      pool,
      "approvalExecute",
      { approvalRequestId: pendingId },
      { jobKey: `approval-request-execute-${pendingId}` },
    );

    const { rows: beforeJobs } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE task_identifier = 'approvalExecute'`,
    );
    expect(beforeJobs[0]!.count).toBe(2);

    await runApprovalRequestExecutionStatusCutoverMigration(pool);

    const { rows: afterJobs } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE task_identifier = 'approvalExecute'`,
    );
    expect(afterJobs[0]!.count).toBe(0);

    const pending = await getApprovalRequest(pool, pendingId);
    expect(pending!.status).toBe("rejected");
    expect(pending!.executionStatus).toBe("legacy_terminal");
    expect(pending!.resourceSnapshot).toEqual({ kind: "legacy_unavailable", resourceId: pendingId, sha256: null });
    expect(pending!.executionResult).toEqual({
      error: { code: "validation_failed", details: { reason: "approval_snapshot_unavailable" } },
    });
    expect(pending!.executedAt).not.toBeNull();

    const approved = await getApprovalRequest(pool, approvedId);
    expect(approved!.status).toBe("approved");
    expect(approved!.executionStatus).toBe("legacy_terminal");
    expect(approved!.resourceSnapshot).toEqual({ kind: "legacy_unavailable", resourceId: approvedId, sha256: null });
    expect(approved!.executionResult).toEqual({
      error: { code: "validation_failed", details: { reason: "approval_snapshot_unavailable" } },
    });
    expect(approved!.executedAt).not.toBeNull();

    const { rows: constraintRows } = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'approval_requests' AND column_name = 'execution_status'`,
    );
    expect(constraintRows[0]!.is_nullable).toBe("NO");
  });

  it("is idempotent: a second run against an already-migrated table is a no-op", async () => {
    await createUser();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "legacy" });
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO approval_requests (agent_run_id, tool_name, risk_class, payload)
       VALUES ($1, 'search_web', 'unclassified', $2::jsonb) RETURNING id`,
      [run.id, JSON.stringify({ mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} })],
    );
    const requestId = rows[0]!.id;

    await runApprovalRequestExecutionStatusCutoverMigration(pool);
    const migratedOnce = await getApprovalRequest(pool, requestId);

    await runApprovalRequestExecutionStatusCutoverMigration(pool);
    const migratedTwice = await getApprovalRequest(pool, requestId);
    expect(migratedTwice).toEqual(migratedOnce);
  });
});
