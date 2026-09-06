import { describe, expect, it } from "vitest";
import { createImapConnectionLimiter } from "../mail/imapConnectionLimiter.js";

/** Resolves once a promise's microtask queue has had a chance to settle, without advancing real time. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("imapConnectionLimiter", () => {
  it("never runs more concurrent tasks than the limit, even when the limit is raised while waiters are queued", async () => {
    const limiter = createImapConnectionLimiter();
    const accountId = "acct-1";
    let concurrent = 0;
    let maxConcurrent = 0;
    const releasers: Array<() => void> = [];

    const runTask = (limit: number) =>
      limiter.run(accountId, limit, async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise<void>((resolve) => releasers.push(resolve));
        concurrent--;
      });

    // Five tasks queue up behind a limit of 1; only the first should be running.
    const results = [runTask(1), runTask(1), runTask(1), runTask(1), runTask(1)];
    await flushMicrotasks();
    expect(concurrent).toBe(1);

    // Raising the limit to 3 must free up exactly two more slots (3 - 1 active), not all four
    // remaining waiters — this is the capacity-bound the limiter must enforce.
    const raised = runTask(3);
    await flushMicrotasks();
    expect(concurrent).toBe(3);

    // Drain everything, one release wave at a time, and confirm the limit is never exceeded
    // as later waiters get woken to backfill freed slots.
    for (let i = 0; i < 10 && releasers.length > 0; i++) {
      releasers.splice(0).forEach((release) => release());
      await flushMicrotasks();
      expect(concurrent).toBeLessThanOrEqual(3);
    }

    await Promise.all([...results, raised]);
    expect(maxConcurrent).toBe(3);
    expect(concurrent).toBe(0);
  });
});
