import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { enqueueJob } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { pruneQueueFailedJobs } from "../observability/queueFailedJobsPrune.js";
import { logger } from "../observability/logger.js";

let pool: Pool;

async function enqueueFailed(taskIdentifier: string, agedDays: number, locked: boolean): Promise<void> {
  await enqueueJob(pool, taskIdentifier, {}, { maxAttempts: 1 });
  await pool.query(
    `UPDATE graphile_worker._private_jobs
     SET attempts = max_attempts,
         updated_at = now() - ($2 * interval '1 day'),
         locked_at = CASE WHEN $3 THEN now() ELSE NULL END,
         locked_by = CASE WHEN $3 THEN 'test-worker' ELSE NULL END
     WHERE task_id = (SELECT id FROM graphile_worker._private_tasks WHERE identifier = $1)`,
    [taskIdentifier, agedDays, locked],
  );
}

async function remainingTaskIdentifiers(): Promise<string[]> {
  const { rows } = await pool.query<{ task_identifier: string }>(`SELECT task_identifier FROM graphile_worker.jobs`);
  return rows.map((row) => row.task_identifier).sort();
}

describe("pruneQueueFailedJobs (issue #706)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("deletes only a permanently-failed, unlocked row past the retention window", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      await enqueueFailed("staleFailedTask", 8, false);
      await enqueueFailed("freshFailedTask", 0, false);
      await enqueueFailed("lockedStaleFailedTask", 8, true);

      const deleted = await pruneQueueFailedJobs(pool);

      expect(deleted).toBe(1);
      expect(await remainingTaskIdentifiers()).toEqual(["freshFailedTask", "lockedStaleFailedTask"]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ jobName: "staleFailedTask" }),
        "Pruning a permanently failed job",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns 0 and logs nothing when no row qualifies", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    try {
      await enqueueFailed("freshFailedTask", 0, false);

      const deleted = await pruneQueueFailedJobs(pool);

      expect(deleted).toBe(0);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
