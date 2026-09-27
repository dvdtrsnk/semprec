import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createAgentRun, finishAgentRun, getAgentRun } from "../agentRuns/agentRunsStore.js";
import { NotFoundError } from "../errors.js";

let pool: Pool;

describe("finishAgentRun", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'unused')`, [`${randomUUID()}@example.com`]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("closes a running run and returns true", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "do the thing" });

    await expect(finishAgentRun(pool, run.id, "done", "result text")).resolves.toBe(true);

    const finished = await getAgentRun(pool, run.id);
    expect(finished).toMatchObject({ status: "done", result: "result text" });
    expect(finished!.finishedAt).not.toBeNull();
  });

  it.each([
    ["done", "error"],
    ["error", "done"],
  ] as const)("keeps the first close (%s) when a second one (%s) arrives and returns false", async (first, second) => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "do the thing" });
    await expect(finishAgentRun(pool, run.id, first, "first")).resolves.toBe(true);
    const afterFirst = await getAgentRun(pool, run.id);

    await expect(finishAgentRun(pool, run.id, second, "second")).resolves.toBe(false);

    const afterSecond = await getAgentRun(pool, run.id);
    expect(afterSecond).toMatchObject({ status: first, result: "first", finishedAt: afterFirst!.finishedAt });
  });

  it("throws NotFoundError for an unknown run id", async () => {
    await expect(finishAgentRun(pool, randomUUID(), "done", null)).rejects.toBeInstanceOf(NotFoundError);
  });
});
