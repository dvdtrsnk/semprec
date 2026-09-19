import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { enqueueJob } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createHeartbeat } from "../schedulerStore.js";
import { CORE_AGENT_RUN_ACTION_ID } from "../actions.js";
import { runHeartbeatFireQueueSplitMigration } from "../heartbeatFireQueueSplitMigration.js";

let pool: Pool;

interface LegacyJobRow {
  id: string;
  key: string;
  queue_name: string | null;
  payload: { traceId: string; payload: Record<string, unknown> };
}

async function jobsByIdentifier(identifier: string): Promise<LegacyJobRow[]> {
  const { rows } = await pool.query<LegacyJobRow>(
    `SELECT j.id::text AS id, j.key, jq.queue_name, j.payload
     FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     LEFT JOIN graphile_worker._private_job_queues jq ON jq.id = j.job_queue_id
     WHERE t.identifier = $1`,
    [identifier],
  );
  return rows;
}

async function getSemprecProjectId(): Promise<string> {
  const { rows } = await pool.query("SELECT id FROM databases WHERE owner_module_id = 'projects'");
  if (rows.length === 0)
    throw new Error("getSemprecProjectId: no database with owner_module_id 'projects' — did seedSystem run?");
  const { rows: items } = await pool.query("SELECT id FROM items WHERE database_id = $1 LIMIT 1", [rows[0].id]);
  if (items.length === 0) throw new Error("getSemprecProjectId: the projects database has no seeded items");
  return items[0].id;
}

/**
 * `globalSetup.ts` already runs this migration once against a fresh (empty) database, exercising
 * its "nothing to migrate" early return; these tests seed genuine legacy `heartbeatFire` jobs
 * (bypassing every live enqueue site, which can no longer produce that identifier) and re-invoke
 * the migration directly, matching `approvalRequestExecutionStatusCutoverMigration.test.ts`'s shape.
 */
describe("runHeartbeatFireQueueSplitMigration (issue #222)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("re-enqueues a deterministic action's legacy job under heartbeatFireCore exactly once, preserving key/queue/payload", async () => {
    const projectItemId = await getSemprecProjectId();
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Legacy deterministic",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "noop",
      }),
    );

    await enqueueJob(
      pool,
      "heartbeatFire",
      { heartbeatId: heartbeat.id, occurrenceId: "legacy-occurrence", generation: 0 },
      { jobKey: "legacy-key-core", maxAttempts: 3, queueName: "legacy-queue" },
    );

    await runHeartbeatFireQueueSplitMigration(pool);

    expect(await jobsByIdentifier("heartbeatFire")).toHaveLength(0);
    const coreJobs = await jobsByIdentifier("heartbeatFireCore");
    expect(coreJobs).toHaveLength(1);
    expect(coreJobs[0]).toMatchObject({
      key: "legacy-key-core",
      queue_name: "legacy-queue",
      payload: { payload: { heartbeatId: heartbeat.id, occurrenceId: "legacy-occurrence", generation: 0 } },
    });

    // A second run must find nothing left to migrate and must not duplicate the re-enqueued job.
    await runHeartbeatFireQueueSplitMigration(pool);
    expect(await jobsByIdentifier("heartbeatFireCore")).toHaveLength(1);
  });

  it("re-enqueues an agent-session action's legacy job under heartbeatFireAgent", async () => {
    const projectItemId = await getSemprecProjectId();
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Legacy agent session",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: CORE_AGENT_RUN_ACTION_ID,
      }),
    );

    await enqueueJob(
      pool,
      "heartbeatFire",
      { heartbeatId: heartbeat.id, triggeredByRunId: "run-1" },
      { jobKey: "legacy-key-agent", maxAttempts: 3 },
    );

    await runHeartbeatFireQueueSplitMigration(pool);

    expect(await jobsByIdentifier("heartbeatFire")).toHaveLength(0);
    const agentJobs = await jobsByIdentifier("heartbeatFireAgent");
    expect(agentJobs).toHaveLength(1);
    expect(agentJobs[0]).toMatchObject({
      key: "legacy-key-agent",
      payload: { payload: { heartbeatId: heartbeat.id, triggeredByRunId: "run-1" } },
    });
  });

  it("stops with an actionable error, migrating nothing, when a legacy job's heartbeat no longer exists", async () => {
    const projectItemId = await getSemprecProjectId();
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Deleted before migration",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "noop",
      }),
    );

    await enqueueJob(
      pool,
      "heartbeatFire",
      { heartbeatId: heartbeat.id, itemId: "orphan-item" },
      { jobKey: "legacy-key-orphan", maxAttempts: 3 },
    );
    await pool.query(`DELETE FROM project_heartbeats WHERE id = $1`, [heartbeat.id]);

    await expect(runHeartbeatFireQueueSplitMigration(pool)).rejects.toThrow(
      /references heartbeat .* which no longer exists/,
    );

    // The failed run must not have removed the legacy job it couldn't resolve.
    expect(await jobsByIdentifier("heartbeatFire")).toHaveLength(1);
    expect(await jobsByIdentifier("heartbeatFireCore")).toHaveLength(0);
  });
});
