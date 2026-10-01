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

/**
 * How long an unaffinitized probe waits for the other one to start before it gives up and
 * finishes alone. It only bounds the failure case (the two never overlap), so it sits well above
 * graphile-worker's 2s `pollInterval`, the latest an idle worker picks up a job whose
 * `jobs:insert` notification reached no idle worker.
 */
const UNAFFINITIZED_OVERLAP_WAIT_MS = 5_000;

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
    // One entry per finished unaffinitized probe: whether the other one had started before it
    // stopped waiting.
    const unaffinitizedOverlaps: boolean[] = [];

    // A fixed sleep only shows the two unaffinitized runs overlapping if graphile-worker picks the
    // second one up within that sleep of the first, which it does not promise: a `jobs:insert`
    // notification only nudges a worker that is idle at that moment, and a job it misses waits for
    // a freed worker or the next poll. Each unaffinitized probe instead stays in flight until both
    // have started, so they overlap whenever they can run concurrently at all, and a serialized
    // pair shows up as the first giving up before the second ever started.
    let unaffinitizedStarted = 0;
    let releaseUnaffinitized!: () => void;
    const bothUnaffinitizedStarted = new Promise<void>((resolve) => {
      releaseUnaffinitized = resolve;
    });
    async function otherUnaffinitizedProbeStarted(): Promise<boolean> {
      let timer: NodeJS.Timeout | undefined;
      const gaveUp = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), UNAFFINITIZED_OVERLAP_WAIT_MS);
      });
      const overlapped = await Promise.race([bothUnaffinitizedStarted.then(() => true as const), gaveUp]);
      clearTimeout(timer);
      return overlapped;
    }

    const taskList: TaskList = {
      probe: registerTask("probe", async (payload) => {
        if ((payload as { queue: string }).queue === "semprec-tick") {
          const start = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 300));
          tickRuns.push({ start, end: Date.now() });
        } else {
          unaffinitizedStarted += 1;
          if (unaffinitizedStarted === 2) releaseUnaffinitized();
          unaffinitizedOverlaps.push(await otherUnaffinitizedProbeStarted());
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
        if (tickRuns.length !== 2 || unaffinitizedOverlaps.length !== 2) {
          throw new Error(
            `expected 2 tick runs and 2 unaffinitized runs, got ${tickRuns.length}/${unaffinitizedOverlaps.length}`,
          );
        }
      },
      { timeout: 2 * UNAFFINITIZED_OVERLAP_WAIT_MS, interval: 20 },
    );

    const [firstTick, secondTick] = tickRuns.sort((a, b) => a.start - b.start);
    expect(secondTick!.start).toBeGreaterThanOrEqual(firstTick!.end);

    expect(unaffinitizedOverlaps).toEqual([true, true]);
  });
});
