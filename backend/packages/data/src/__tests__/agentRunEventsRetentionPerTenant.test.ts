import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createAgentRun, finishAgentRun } from "../agentRuns/agentRunsStore.js";
import { insertAgentRunEvent } from "../agentRuns/agentRunEventsStore.js";
import { handleAgentRunEventsRetentionTask } from "../agentRuns/agentRunEventsRetention.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let adminPool: Pool;
let pool: Pool;
let userId: string;

type Conversation = { runId: string; pre: string[]; checkpoint: string; post: string[] };

/** All event ids of `runId`, read inside `tenantId` so row-level security applies. */
async function eventIds(tenantId: string, runId: string): Promise<string[]> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id",
      [runId],
    );
    return rows.map((r) => r.id);
  });
}

async function addEvent(tenantId: string, runId: string, kind: "message" | "compaction"): Promise<string> {
  return runInTenant(tenantId, async () => {
    const event = await insertAgentRunEvent(pool, runId, kind, kind === "compaction" ? { kind } : {});
    return event.id;
  });
}

async function backdate(tenantId: string, runId: string): Promise<void> {
  await runInTenant(tenantId, async () => {
    await pool.query("UPDATE agent_run_events SET at = $2 WHERE agent_run_id = $1", [
      runId,
      new Date(Date.now() - 40 * DAY_MS),
    ]);
  });
}

async function finish(tenantId: string, runId: string): Promise<void> {
  await runInTenant(tenantId, () => finishAgentRun(pool, runId, "done", null));
}

describe("handleAgentRunEventsRetentionTask runs per tenant (issue #987)", () => {
  let tenantZero: string;
  let tenantB: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantZero = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
    const { rows } = await adminPool.query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, 'unused') RETURNING id",
      [`${randomUUID()}@example.com`],
    );
    userId = rows[0]!.id;
  });

  async function seedPair(status: "done" | "running"): Promise<{ zero: Conversation; b: Conversation }> {
    const runZero = await runInTenant(tenantZero, () =>
      createAgentRun(pool, { userId, triggeredBy: "user", unit: "session", task: "chat" }),
    );
    const runB = await runInTenant(tenantB, () =>
      createAgentRun(pool, { userId, triggeredBy: "user", unit: "session", task: "chat" }),
    );
    // Interleave so B's checkpoint id is lower than tenant zero's, and B has events between them.
    const bPre = [await addEvent(tenantB, runB.id, "message"), await addEvent(tenantB, runB.id, "message")];
    const bCheckpoint = await addEvent(tenantB, runB.id, "compaction");
    const zeroPre = [
      await addEvent(tenantZero, runZero.id, "message"),
      await addEvent(tenantZero, runZero.id, "message"),
    ];
    const zeroCheckpoint = await addEvent(tenantZero, runZero.id, "compaction");
    const bPost = [await addEvent(tenantB, runB.id, "message"), await addEvent(tenantB, runB.id, "message")];
    const zeroPost = [
      await addEvent(tenantZero, runZero.id, "message"),
      await addEvent(tenantZero, runZero.id, "message"),
    ];
    await backdate(tenantZero, runZero.id);
    await backdate(tenantB, runB.id);
    if (status === "done") {
      await finish(tenantZero, runZero.id);
      await finish(tenantB, runB.id);
    }
    return {
      zero: { runId: runZero.id, pre: zeroPre, checkpoint: zeroCheckpoint, post: zeroPost },
      b: { runId: runB.id, pre: bPre, checkpoint: bCheckpoint, post: bPost },
    };
  }

  it("keeps each tenant's own checkpoint and tail even when conversation keys are equal", async () => {
    const { zero, b } = await seedPair("done");
    expect(BigInt(b.checkpoint)).toBeLessThan(BigInt(zero.checkpoint));

    const result = await runAsSystem("test", () => handleAgentRunEventsRetentionTask(pool));

    expect(result).toEqual({ deleted: 4 });
    expect(await eventIds(tenantZero, zero.runId)).toEqual([zero.checkpoint, ...zero.post]);
    expect(await eventIds(tenantB, b.runId)).toEqual([b.checkpoint, ...b.post]);
  });

  it("keeps old pre-checkpoint events of a running run in either tenant", async () => {
    const { zero, b } = await seedPair("running");

    const result = await runAsSystem("test", () => handleAgentRunEventsRetentionTask(pool));

    expect(result).toEqual({ deleted: 0 });
    expect(await eventIds(tenantZero, zero.runId)).toEqual([...zero.pre, zero.checkpoint, ...zero.post]);
    expect(await eventIds(tenantB, b.runId)).toEqual([...b.pre, b.checkpoint, ...b.post]);
  });

  it("leaves a suspended tenant's old events alone", async () => {
    const suspended = await createTestTenant(adminPool, { status: "suspended" });
    const run = await runInTenant(suspended, () =>
      createAgentRun(pool, { userId, triggeredBy: "user", unit: "session", task: "chat" }),
    );
    const pre = await addEvent(suspended, run.id, "message");
    const checkpoint = await addEvent(suspended, run.id, "compaction");
    await backdate(suspended, run.id);
    await finish(suspended, run.id);

    const result = await runAsSystem("test", () => handleAgentRunEventsRetentionTask(pool));

    expect(result).toEqual({ deleted: 0 });
    expect(await eventIds(suspended, run.id)).toEqual([pre, checkpoint]);
  });
});
