import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@semprec/shared";
import {
  createTenantZeroUser,
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { createAgentRun, getAgentRun } from "../agentRunsStore.js";
import { createUser } from "../../auth/usersStore.js";
import { withTransaction } from "../../db/pool.js";
import { mintMcpRunCredential } from "../../mcp/mcpRunCredentialAction.js";

let pool: Pool;

async function insertThread(tenantId?: string): Promise<string> {
  const { rows } = tenantId
    ? await pool.query<{ id: string }>("INSERT INTO semp_threads (tenant_id, kind) VALUES ($1, 'chat') RETURNING id", [
        tenantId,
      ])
    : await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
  return rows[0]!.id;
}

describe("agent_runs.thread_id (issue #1452)", () => {
  beforeAll(() => {
    pool = getTestPool();
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    await createTenantZeroUser(pool);
  });

  it("stores the thread of a run created with a threadId and returns it from the reads", async () => {
    const threadId = await insertThread();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId });
    expect(run.threadId).toBe(threadId);
    expect((await getAgentRun(pool, run.id))?.threadId).toBe(threadId);
  });

  it("copies the parent's thread into a delegated run and lets an explicit threadId win", async () => {
    const threadId = await insertThread();
    const otherThreadId = await insertThread();
    const parent = await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId });
    const child = await createAgentRun(pool, { triggeredBy: "supervisor", task: "sub", parentRunId: parent.id });
    expect(child.threadId).toBe(threadId);
    const explicit = await createAgentRun(pool, {
      triggeredBy: "supervisor",
      task: "sub",
      parentRunId: parent.id,
      threadId: otherThreadId,
    });
    expect(explicit.threadId).toBe(otherThreadId);
    const cleared = await createAgentRun(pool, {
      triggeredBy: "supervisor",
      task: "sub",
      parentRunId: parent.id,
      threadId: null,
    });
    expect(cleared.threadId).toBeNull();
    expect((await getAgentRun(pool, cleared.id))?.threadId).toBeNull();
  });

  it("leaves thread_id NULL for a run with no thread, such as an MCP run", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "mcp", task: "mcp" });
    expect(run.threadId).toBeNull();
    const child = await createAgentRun(pool, { triggeredBy: "supervisor", task: "sub", parentRunId: run.id });
    expect(child.threadId).toBeNull();
  });

  it("sets thread_id to NULL when the thread is deleted and keeps tenant_id", async () => {
    const threadId = await insertThread();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId });
    await pool.query("DELETE FROM semp_threads WHERE id = $1", [threadId]);
    const { rows } = await pool.query<{ thread_id: string | null; tenant_id: string }>(
      "SELECT thread_id, tenant_id FROM agent_runs WHERE id = $1",
      [run.id],
    );
    expect(rows[0]).toEqual({ thread_id: null, tenant_id: getTenantZeroId() });
  });

  it("refuses a run that references another tenant's thread", async () => {
    const tenantB = await createTestTenant(pool);
    const threadB = await insertThread(tenantB);
    await expect(createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId: threadB })).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("enforces thread and parent isolation using the runtime role", async () => {
    const tenantB = await createTestTenant(pool);
    const threadB = await insertThread(tenantB);
    const threadA = await insertThread();
    const parentA = await createAgentRun(pool, { triggeredBy: "user", task: "chat", threadId: threadA });
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      await withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
        const child = await createAgentRun(client, { triggeredBy: "supervisor", task: "sub", parentRunId: parentA.id });
        expect(child.threadId).toBe(threadA);
      });
      await expect(
        withTenantTransaction(runtime, getTenantZeroId(), (client) =>
          createAgentRun(client, { triggeredBy: "user", task: "chat", threadId: threadB }),
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await withTenantTransaction(runtime, tenantB, async (client) => {
        expect(await getAgentRun(client, parentA.id)).toBeNull();
        await expect(
          createAgentRun(client, { triggeredBy: "supervisor", task: "sub", parentRunId: parentA.id }),
        ).rejects.toThrow("does not exist");
      });
    } finally {
      await runtime.end();
    }
  });

  it("mints real MCP runs with no thread in each runtime tenant", async () => {
    const tenantA = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    const userB = await createUser(pool, {
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
      tenantId: tenantB,
    });
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE tenant_id = $1", [tenantA]);
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      for (const [tenantId, userId] of [
        [tenantA, rows[0]!.id],
        [tenantB, userB.id],
      ] as const) {
        await runInTenant(tenantId, async () => {
          const projectItemId = await createTestProjectItem(runtime);
          const minted = await withTransaction(runtime, (client) =>
            mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.read"], userId }),
          );
          expect(minted.run.threadId).toBeNull();
          expect((await getAgentRun(runtime, minted.run.id))?.threadId).toBeNull();
        });
      }
    } finally {
      await runtime.end();
    }
  });
});
