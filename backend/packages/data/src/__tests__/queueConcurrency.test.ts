import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { enqueueJob, registerTask, runWorker, type Runner, type TaskList } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";

let pool: Pool;
let runner: Runner | undefined;

interface ProbeRun {
  start: number;
  end: number;
}

describe("production concurrency: semprec-tick serializes, unaffinitized jobs run in parallel (issue #705)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterEach(async () => {
    await runner?.stop();
    runner = undefined;
    delete process.env.QUEUE_CONCURRENCY;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("serializes jobs on the semprec-tick queue but runs unaffinitized jobs concurrently", async () => {
    delete process.env.QUEUE_CONCURRENCY;

    const tickRuns: ProbeRun[] = [];
    const unaffinitizedRuns: ProbeRun[] = [];

    const taskList: TaskList = {
      probe: registerTask("probe", async (payload) => {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const end = Date.now();
        const run = { start, end };
        if ((payload as { queue: string }).queue === "semprec-tick") {
          tickRuns.push(run);
        } else {
          unaffinitizedRuns.push(run);
        }
      }),
    };

    runner = await runWorker({ pgPool: pool, taskList, noHandleSignals: true });

    await enqueueJob(pool, "probe", { queue: "semprec-tick" }, { queueName: "semprec-tick" });
    await enqueueJob(pool, "probe", { queue: "semprec-tick" }, { queueName: "semprec-tick" });
    await enqueueJob(pool, "probe", { queue: "none" });
    await enqueueJob(pool, "probe", { queue: "none" });

    await vi.waitFor(
      () => {
        if (tickRuns.length !== 2 || unaffinitizedRuns.length !== 2) {
          throw new Error(
            `expected 2 tick runs and 2 unaffinitized runs, got ${tickRuns.length}/${unaffinitizedRuns.length}`,
          );
        }
      },
      { timeout: 5_000, interval: 20 },
    );

    const [firstTick, secondTick] = tickRuns.sort((a, b) => a.start - b.start);
    expect(secondTick!.start).toBeGreaterThanOrEqual(firstTick!.end);

    const [firstUnaffinitized, secondUnaffinitized] = unaffinitizedRuns.sort((a, b) => a.start - b.start);
    expect(secondUnaffinitized!.start).toBeLessThan(firstUnaffinitized!.end);
  });
});
