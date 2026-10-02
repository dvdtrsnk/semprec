import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { enqueueJob, registerTask, runWorker, type Runner, type TaskList } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";

let pool: Pool;
let runner: Runner | undefined;

/** Mirrors mcpSync.test.ts's own helper: polls instead of sleeping a fixed duration. */
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!predicate()) throw new Error(message);
    },
    { timeout: 5_000, interval: 20 },
  );
}

async function probeRows(): Promise<Array<{ attempts: number; last_error: string | null; key: string | null }>> {
  const { rows } = await pool.query<{
    attempts: number;
    last_error: string | null;
    key: string | null;
  }>(`SELECT attempts, last_error, key FROM graphile_worker.jobs WHERE task_identifier = 'supersedeProbe'`);
  return rows;
}

describe("registerTask supersession handling (issue #700)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterEach(async () => {
    await runner?.stop();
    runner = undefined;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("completes a superseded run's failure instead of dead-lettering it, and logs the supersession once", async () => {
    let invocationCount = 0;
    let started = false;
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const taskList: TaskList = {
      supersedeProbe: registerTask("supersedeProbe", async () => {
        invocationCount += 1;
        if (invocationCount === 1) {
          started = true;
          await gate;
          throw new Error("transient");
        }
      }),
    };

    runner = await runWorker({ pgPool: pool, taskList, noHandleSignals: true, concurrency: 1 });

    await enqueueJob(pool, "supersedeProbe", {}, { jobKey: "k", maxAttempts: 3 });
    await waitFor(() => started, "first invocation never started");

    await enqueueJob(pool, "supersedeProbe", {}, { jobKey: "k", maxAttempts: 3 });
    releaseGate!();

    await waitFor(() => invocationCount >= 2, "replacement job never ran");

    await vi.waitFor(
      async () => {
        const rows = await probeRows();
        if (rows.length !== 0) throw new Error(`expected no supersedeProbe rows, found ${rows.length}`);
      },
      { timeout: 5_000, interval: 20 },
    );
  });

  it("retries a genuine failure normally when the job was never superseded", async () => {
    const taskList: TaskList = {
      supersedeProbe: registerTask("supersedeProbe", async () => {
        throw new Error("transient");
      }),
    };

    runner = await runWorker({ pgPool: pool, taskList, noHandleSignals: true, concurrency: 1 });

    await enqueueJob(pool, "supersedeProbe", {}, { jobKey: "k", maxAttempts: 3 });

    await vi.waitFor(
      async () => {
        const rows = await probeRows();
        if (rows.length !== 1 || rows[0]!.last_error === null) {
          throw new Error(`expected exactly one failed supersedeProbe row, found ${JSON.stringify(rows)}`);
        }
      },
      { timeout: 5_000, interval: 20 },
    );

    const rows = await probeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.last_error).toContain("transient");
    expect(rows[0]!.key).toBe("k");
  });
});
