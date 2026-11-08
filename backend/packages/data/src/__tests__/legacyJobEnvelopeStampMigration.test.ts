import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES } from "@semprec/queue";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createTestTenant } from "../testSupport/tenantFixtures.js";
import { runLegacyJobEnvelopeStampMigration } from "../tenancy/legacyJobEnvelopeStampMigration.js";

const TENANT_TASK = CORE_TASK_NAMES.ROLLUP_RECOMPUTE;
const SYSTEM_TASK = CORE_TASK_NAMES.HEARTBEAT_SWEEP;

const jobRowSchema = z.object({
  id: z.string(),
  task_identifier: z.string(),
  key: z.string().nullable(),
  queue_name: z.string().nullable(),
  run_at: z.date(),
  attempts: z.number(),
  max_attempts: z.number(),
  locked_at: z.date().nullable(),
  payload: z.unknown(),
});
type JobRow = z.infer<typeof jobRowSchema>;

let pool: Pool;

/**
 * Every job row with its payload, ordered by id. Reads graphile-worker 0.17.3's private tables,
 * because the public `graphile_worker.jobs` view does not project `payload`.
 */
async function allJobs(): Promise<JobRow[]> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT j.id::text AS id, t.identifier AS task_identifier, j.key, q.queue_name, j.run_at, j.attempts,
            j.max_attempts, j.locked_at, j.payload
     FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     LEFT JOIN graphile_worker._private_job_queues q ON q.id = j.job_queue_id
     ORDER BY j.id`,
  );
  return rows.map((row) => jobRowSchema.parse(row));
}

interface AddJobOptions {
  key?: string;
  queueName?: string;
  runAt?: Date;
  maxAttempts?: number;
}

/**
 * Adds a job with a hand-built payload through graphile-worker's public `add_job`: `enqueueJob`
 * always stamps a `tenantId`, so it cannot produce the legacy envelopes this step converts.
 */
async function addRawJob(identifier: string, payload: unknown, options: AddJobOptions = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT (graphile_worker.add_job(
       identifier => $1, payload => $2::json, queue_name => $3, run_at => $4, max_attempts => $5, job_key => $6
     )).id::text AS id`,
    [
      identifier,
      JSON.stringify(payload),
      options.queueName ?? null,
      options.runAt ?? null,
      options.maxAttempts ?? null,
      options.key ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("addRawJob: add_job returned no row");
  return id;
}

describe("runLegacyJobEnvelopeStampMigration", () => {
  beforeAll(() => {
    pool = getTestPool();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it.each([
    ["without a tenantId", (traceId: string) => ({ traceId, payload: { itemId: "abc", n: 1 } })],
    ["with a null tenantId", (traceId: string) => ({ traceId, tenantId: null, payload: { itemId: "abc", n: 1 } })],
  ])("stamps the sole tenant onto a pending tenant-task envelope %s", async (_label, envelope) => {
    const traceId = randomUUID();
    const runAt = new Date("2031-01-02T03:04:05.000Z");
    await addRawJob(TENANT_TASK, envelope(traceId), {
      key: "legacy-key",
      queueName: "legacy-queue",
      runAt,
      maxAttempts: 7,
    });

    await expect(runLegacyJobEnvelopeStampMigration(pool)).resolves.toEqual({ stamped: 1 });

    const jobs = await allJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      task_identifier: TENANT_TASK,
      key: "legacy-key",
      queue_name: "legacy-queue",
      run_at: runAt,
      attempts: 0,
      max_attempts: 7,
      payload: { traceId, tenantId: getTenantZeroId(), payload: { itemId: "abc", n: 1 } },
    });

    // A second run finds nothing left to stamp and changes no job.
    await expect(runLegacyJobEnvelopeStampMigration(pool)).resolves.toEqual({ stamped: 0 });
    expect(await allJobs()).toEqual(jobs);
  });

  it("leaves a system task's null tenantId, a crontab payload, a stamped envelope and a permanently failed job as they were", async () => {
    await addRawJob(SYSTEM_TASK, { traceId: randomUUID(), tenantId: null, payload: {} });
    await addRawJob(TENANT_TASK, { _cron: { ts: "2031-01-01T00:00:00.000Z", backfilled: false } });
    await addRawJob(TENANT_TASK, { traceId: randomUUID(), tenantId: getTenantZeroId(), payload: { a: 1 } });
    const failedId = await addRawJob(TENANT_TASK, { traceId: randomUUID(), payload: { a: 2 } }, { maxAttempts: 3 });
    // No public API marks a job permanently failed without running a worker against it.
    await pool.query("UPDATE graphile_worker._private_jobs SET attempts = max_attempts WHERE id = $1::bigint", [
      failedId,
    ]);
    const before = await allJobs();

    await expect(runLegacyJobEnvelopeStampMigration(pool)).resolves.toEqual({ stamped: 0 });

    expect(await allJobs()).toEqual(before);
  });

  it("throws naming the tenant count with two tenants and one legacy tenant-task job, changing no job", async () => {
    await createTestTenant(pool);
    await addRawJob(TENANT_TASK, { traceId: randomUUID(), payload: { a: 1 } }, { key: "two-tenants" });
    const before = await allJobs();

    await expect(runLegacyJobEnvelopeStampMigration(pool)).rejects.toThrow(/there are 2 tenants/);
    await expect(runLegacyJobEnvelopeStampMigration(pool)).rejects.toThrow(/1 legacy tenant-task job/);

    expect(await allJobs()).toEqual(before);
  });

  it("returns { stamped: 0 } with two tenants and no legacy job", async () => {
    await createTestTenant(pool);
    await addRawJob(TENANT_TASK, { traceId: randomUUID(), tenantId: getTenantZeroId(), payload: {} });
    const before = await allJobs();

    await expect(runLegacyJobEnvelopeStampMigration(pool)).resolves.toEqual({ stamped: 0 });

    expect(await allJobs()).toEqual(before);
  });

  it.each([
    ["a non-string traceId", { traceId: 5, payload: { a: 1 } }, /has a payload that is not a valid queue envelope/],
    [
      "an array business payload",
      { traceId: randomUUID(), payload: [1] },
      /has an envelope whose payload is not an object/,
    ],
    [
      "a string business payload",
      { traceId: randomUUID(), payload: "x" },
      /has an envelope whose payload is not an object/,
    ],
  ])(
    "throws naming a legacy job with %s and rolls back every job already re-enqueued",
    async (_label, bad, message) => {
      // The valid job has the lower id, so it is removed and re-enqueued before the malformed one throws.
      await addRawJob(TENANT_TASK, { traceId: randomUUID(), payload: { a: 0 } }, { key: "valid-before-bad" });
      const badId = await addRawJob(TENANT_TASK, bad);
      const before = await allJobs();

      const run = runLegacyJobEnvelopeStampMigration(pool);
      await expect(run).rejects.toThrow(message);
      await expect(run).rejects.toThrow(new RegExp(`job ${badId} \\(${TENANT_TASK}\\)`));

      expect(await allJobs()).toEqual(before);
    },
  );

  it("throws naming a locked legacy job's id and changes no job", async () => {
    await addRawJob(TENANT_TASK, { traceId: randomUUID(), payload: { a: 1 } });
    const lockedId = await addRawJob(TENANT_TASK, { traceId: randomUUID(), payload: { a: 2 } });
    // Simulates a worker holding the job; locking it through get_job would need a running worker.
    await pool.query(
      "UPDATE graphile_worker._private_jobs SET locked_at = now(), locked_by = 'test-worker' WHERE id = $1::bigint",
      [lockedId],
    );
    const before = await allJobs();

    await expect(runLegacyJobEnvelopeStampMigration(pool)).rejects.toThrow(
      new RegExp(`job\\(s\\) ${lockedId} \\(${TENANT_TASK}\\)`),
    );

    expect(await allJobs()).toEqual(before);
  });
});
