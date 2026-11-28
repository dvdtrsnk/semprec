import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { enqueueJob, registerTask, runWorker, type Runner, type TaskList } from "@alldots/queue";
import { getTestPool, inTenantZero, resetDatabase } from "../testSupport/testDb.js";

let pool: Pool;
let runner: Runner | undefined;

interface ProbeRun {
  start: number;
  end: number;
}

/**
 * Bounds only the failure case (the probes never overlap); well above graphile-worker's 2 s `pollInterval`,
 * the latest an idle worker picks up a job whose `jobs:insert` notification it missed.
 */
const UNAFFINITIZED_OVERLAP_WAIT_MS = 5_000;

describe("production concurrency: alldots-tick serializes, unaffinitized jobs run in parallel (issue #705)", () => {
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

  it("serializes jobs on the alldots-tick queue but runs unaffinitized jobs concurrently", async () => {
    delete process.env.QUEUE_CONCURRENCY;

    const tickRuns: ProbeRun[] = [];
    // Per finished probe: whether the other one had started before it stopped waiting.
    const unaffinitizedOverlaps: boolean[] = [];

    // graphile-worker does not promise to pick up the second job within a fixed sleep, so each probe stays in
    // flight until both started; a serialized pair shows up as the first giving up first.
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
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("queue" in payload) ||
          typeof payload.queue !== "string"
        ) {
          throw new Error(`probe payload must be an object with a string queue, got ${JSON.stringify(payload)}`);
        }
        if (payload.queue === "alldots-tick") {
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

    await inTenantZero(() => enqueueJob(pool, "probe", { queue: "alldots-tick" }, { queueName: "alldots-tick" }));
    await inTenantZero(() => enqueueJob(pool, "probe", { queue: "alldots-tick" }, { queueName: "alldots-tick" }));
    await inTenantZero(() => enqueueJob(pool, "probe", { queue: "none" }));
    await inTenantZero(() => enqueueJob(pool, "probe", { queue: "none" }));

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
