import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createAgentRun, finishAgentRunWithErrorNotification, getAgentRun } from "../agentRuns/agentRunsStore.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";

let pool: Pool;

describe("finishAgentRunWithErrorNotification (issue #149)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createTestUser() {
    const passwordHash = await hashPassword("s3cret-password");
    return createUser(pool, { email: "owner@example.test", passwordHash, locale: "en" });
  }

  it("writes an agent_run_error notification in the same transaction as the status write, and replaying the same run never duplicates it", async () => {
    const user = await createTestUser();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "do the thing" });

    await withTransaction(pool, (client) => finishAgentRunWithErrorNotification(client, run.id, "boom"));

    const { rows: afterFirst } = await pool.query(
      `SELECT user_id, kind, title, link_href, source_table, source_id, transition_instance FROM notifications WHERE source_id = $1`,
      [run.id],
    );
    expect(afterFirst).toMatchObject([
      {
        user_id: user.id,
        kind: "agent_run_error",
        title: "Agent run failed",
        link_href: `?page=agent-run&id=${run.id}`,
        source_table: "agent_runs",
        transition_instance: run.id,
      },
    ]);

    // Replaying the same close (e.g. a retried caller after a crash) must not duplicate it.
    await withTransaction(pool, (client) => finishAgentRunWithErrorNotification(client, run.id, "boom"));
    const { rows: afterReplay } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, [run.id]);
    expect(afterReplay).toHaveLength(1);
  });

  it("rolls back the notification along with the rest of the transaction on failure", async () => {
    await createTestUser();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "do the thing" });

    await expect(
      withTransaction(pool, async (client) => {
        await finishAgentRunWithErrorNotification(client, run.id, "boom");
        throw new Error("later step in the same transaction fails");
      }),
    ).rejects.toThrow("later step in the same transaction fails");

    const { rows } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, [run.id]);
    expect(rows).toHaveLength(0);
    const finished = await getAgentRun(pool, run.id);
    expect(finished!.status).toBe("running");
  });

  it("opens its own transaction when given a bare pool, so the close and the notification still land atomically together", async () => {
    const user = await createTestUser();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "do the thing" });

    await finishAgentRunWithErrorNotification(pool, run.id, "boom");

    const finished = await getAgentRun(pool, run.id);
    expect(finished!.status).toBe("error");
    const { rows } = await pool.query(`SELECT user_id, kind FROM notifications WHERE source_id = $1`, [run.id]);
    expect(rows).toMatchObject([{ user_id: user.id, kind: "agent_run_error" }]);
  });

  it("skips the notification (but still finishes the run) before any user account exists", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "do the thing" });

    await withTransaction(pool, (client) => finishAgentRunWithErrorNotification(client, run.id, "boom"));

    const finished = await getAgentRun(pool, run.id);
    expect(finished!.status).toBe("error");
    const { rows } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, [run.id]);
    expect(rows).toHaveLength(0);
  });
});
