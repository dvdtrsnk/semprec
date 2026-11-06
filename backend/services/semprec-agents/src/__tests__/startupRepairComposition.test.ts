import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import {
  closeIdleThreadSessions,
  createReconstructConversationHistory,
  repairInterruptedRuns,
} from "@semprec/agent-runtime";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  claimSempMessage,
  createAgentRun,
  createUser,
  hashPassword,
  insertAgentRunEvent,
  sendSempMessage,
  withTransaction,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import { runAsSystem, runInTenant, type Logger } from "@semprec/shared";
import { ModuleRegistry } from "@semprec/module-registry";
import { createAgentsQueueRuntime, type AgentsQueueRuntime } from "../queueRuntime.js";
import { toPiMessages } from "../piConversationHistory.js";
import { createGracefulShutdown } from "../shutdown.js";

let pool: Pool;
let runtime: AgentsQueueRuntime | undefined;

describe("semprec-agents startup repair (issue #642)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await pool.query("TRUNCATE graphile_worker._private_known_crontabs");
    const passwordHash = await hashPassword("s3cret-password");
    await createUser(pool, { email: "owner@example.test", passwordHash, locale: "en", tenantId: getTenantZeroId() });
    runtime = undefined;
  });

  afterEach(async () => {
    await runtime?.stop();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("composes graceful shutdown with the real idle sweep before ending its runtime pool", async () => {
    const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    let ended = false;
    let failure: { error: unknown } | undefined;
    const order: string[] = [];
    const originalEnd = runtimePool.end.bind(runtimePool);
    const endDescriptor = Object.getOwnPropertyDescriptor(runtimePool, "end");
    Object.defineProperty(runtimePool, "end", {
      configurable: true,
      value: () => {
        order.push("end");
        return originalEnd().then(() => {
          ended = true;
        });
      },
    });
    try {
      const thread = await runInTenant(getTenantZeroId(), () =>
        withTransaction(runtimePool, (client) =>
          client.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id"),
        ),
      );
      const run = await runInTenant(getTenantZeroId(), () =>
        createAgentRun(runtimePool, {
          triggeredBy: "user",
          unit: "session",
          task: "idle",
          threadId: thread.rows[0]!.id,
        }),
      );
      await runInTenant(getTenantZeroId(), () =>
        insertAgentRunEvent(runtimePool, run.id, "turn_end", { kind: "turn_end" }),
      );
      const logger = { info: () => {}, error: () => {} } as unknown as Logger;
      const shutdown = createGracefulShutdown({
        pool: runtimePool,
        logger,
        abortSempTurns: () => {},
        observeSempSettlement: () => async () => [],
        queueRuntime: {
          stop: async () => {
            order.push("queue");
          },
        },
        tenantDeactivationListener: {
          close: async () => {
            order.push("listener");
          },
        },
        closeIdleThreadSessions: async (client) => {
          const result = await closeIdleThreadSessions(client);
          order.push("sweep");
          return result;
        },
      });
      await shutdown("SIGTERM");
      expect(order).toEqual(["listener", "queue", "sweep", "end"]);
      const rows = await pool.query<{ status: string; notifications: string }>(
        "SELECT status, (SELECT count(*)::text FROM notifications WHERE source_id = $1::text AND kind = 'agent_run_error') AS notifications FROM agent_runs WHERE id = $1::uuid",
        [run.id],
      );
      expect(rows.rows).toEqual([{ status: "done", notifications: "0" }]);
      const source = await readFile(new URL("../serve.ts", import.meta.url), "utf8");
      expect(source).toMatch(/createGracefulShutdown\(\{[\s\S]*?\bcloseIdleThreadSessions\s*[,}]/);
    } catch (error) {
      failure = { error };
    }
    if (endDescriptor) Object.defineProperty(runtimePool, "end", endDescriptor);
    else Reflect.deleteProperty(runtimePool, "end");
    if (!ended) {
      try {
        await originalEnd();
      } catch (error) {
        if (failure) throw new AggregateError([failure.error, error], "Shutdown test cleanup failed", { cause: error });
        throw error;
      }
    }
    if (failure) throw failure.error;
  });

  it("repairs orphaned runs, skips mcp-credential runs, and creates the queue runtime", async () => {
    const orphan = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "search something" });
    await insertAgentRunEvent(pool, orphan.id, "tool_use", { kind: "tool_use", tool: "search", toolCallId: "call-1" });
    const mcpRun = await createAgentRun(pool, { triggeredBy: "mcp", task: "mcp credential" });
    await insertAgentRunEvent(pool, mcpRun.id, "turn_start", { kind: "turn_start" });

    const { repairedRunIds } = await repairInterruptedRuns(pool);
    runtime = await createAgentsQueueRuntime(pool, new ModuleRegistry(() => new Set()));

    expect(runtime).toBeDefined();
    expect(repairedRunIds).toEqual([orphan.id]);

    const { rows: runs } = await pool.query<{ id: string; status: string; result: string | null }>(
      `SELECT id, status, result FROM agent_runs WHERE id = ANY($1)`,
      [[orphan.id, mcpRun.id]],
    );
    const byId = new Map(runs.map((r) => [r.id, r]));
    expect(byId.get(orphan.id)).toEqual({ id: orphan.id, status: "error", result: "interrupted_by_restart" });
    expect(byId.get(mcpRun.id)).toEqual({ id: mcpRun.id, status: "running", result: null });

    const { rows: orphanEvents } = await pool.query<{
      kind: string;
      payload: unknown;
    }>(`SELECT kind, payload FROM agent_run_events WHERE agent_run_id = $1 AND kind <> 'run_status' ORDER BY id ASC`, [
      orphan.id,
    ]);
    expect(orphanEvents.map((r) => r.kind)).toEqual(["tool_use", "tool_result"]);
    expect(orphanEvents[1]!.payload).toMatchObject({ toolCallId: "call-1", isError: true });

    const { rows: mcpEvents } = await pool.query<{ kind: string }>(
      `SELECT kind FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC`,
      [mcpRun.id],
    );
    expect(mcpEvents.map((r) => r.kind)).toEqual(["turn_start"]);
  });

  it("repairs running Semp rows idempotently without modifying existing job or queue lock markers", async () => {
    const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const role = await runAsSystem("test:repair-role", () =>
        runtimePool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const other = await createTestTenant(pool);
      await createUser(pool, { email: "other@example.test", passwordHash: "unused", tenantId: other });
      const createTurn = (tenant: string) =>
        runInTenant(tenant, () =>
          withTransaction(runtimePool, async (client) => {
            const turn = await sendSempMessage(client, { text: "repair", context: [], hasContext: false });
            expect(await claimSempMessage(client, turn.threadId, turn.assistantMessageId)).toBe(true);
            return turn;
          }),
        );
      const first = await createTurn(getTenantZeroId());
      const second = await createTurn(other);
      const queued = await runInTenant(other, () =>
        withTransaction(runtimePool, (client) =>
          sendSempMessage(client, { text: "queued", context: [], hasContext: false }),
        ),
      );
      const key = `sempMessage:${second.assistantMessageId}`;
      // A stored lock marker is a fixture for preservation only; it makes no claim about worker liveness.
      const job = await pool.query<{ job_queue_id: string }>(
        "UPDATE graphile_worker._private_jobs SET locked_at = now(), locked_by = 'pool-fixture' WHERE key = $1 RETURNING job_queue_id::text",
        [key],
      );
      expect(job.rowCount).toBe(1);
      const queue = await pool.query(
        "UPDATE graphile_worker._private_job_queues SET locked_at = now(), locked_by = 'pool-fixture' WHERE id = $1::int",
        [job.rows[0]?.job_queue_id],
      );
      expect(queue.rowCount).toBe(1);
      const locks = () =>
        pool.query<{
          job_owner: string | null;
          queue_owner: string | null;
          job_time: Date | null;
          queue_time: Date | null;
        }>(
          `SELECT j.locked_by AS job_owner, q.locked_by AS queue_owner, j.locked_at AS job_time, q.locked_at AS queue_time
           FROM graphile_worker._private_jobs j JOIN graphile_worker._private_job_queues q ON q.id = j.job_queue_id WHERE j.key = $1`,
          [key],
        );
      const before = (await locks()).rows;
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ job_owner: "pool-fixture", queue_owner: "pool-fixture" });
      await repairInterruptedRuns(runtimePool);
      const read = (tenant: string, id: string) =>
        runInTenant(tenant, () =>
          runtimePool.query<{ status: string; error_code: string | null }>(
            "SELECT status, error_code FROM semp_messages WHERE id = $1",
            [id],
          ),
        );
      expect((await read(getTenantZeroId(), first.assistantMessageId)).rows).toEqual([
        { status: "error", error_code: "interrupted" },
      ]);
      expect((await read(other, second.assistantMessageId)).rows).toEqual([
        { status: "error", error_code: "interrupted" },
      ]);
      expect((await read(other, first.assistantMessageId)).rows).toEqual([]);
      expect((await read(other, randomUUID())).rows).toEqual([]);
      expect((await read(other, queued.assistantMessageId)).rows).toEqual([{ status: "queued", error_code: null }]);
      expect((await locks()).rows).toEqual(before);
      const again = await repairInterruptedRuns(runtimePool);
      expect(again.repairedRunIds).toEqual([]);
      expect((await read(getTenantZeroId(), first.assistantMessageId)).rows).toEqual([
        { status: "error", error_code: "interrupted" },
      ]);
      expect((await locks()).rows).toEqual(before);
    } finally {
      await runtimePool.end();
    }
  });

  it("converts the actually repaired stored history into pi messages", async () => {
    const { rows } = await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
    const threadId = rows[0]!.id;
    const run = await createAgentRun(pool, { triggeredBy: "user", unit: "session", task: "test", threadId });
    await insertAgentRunEvent(pool, run.id, "user_message", { kind: "user_message", text: "question", context: [] });
    await insertAgentRunEvent(pool, run.id, "tool_use", {
      kind: "tool_use",
      toolCallId: "call-1",
      name: "search",
      arguments: { query: "test" },
    });
    await repairInterruptedRuns(pool);
    const reconstruct = createReconstructConversationHistory({
      estimateContextTokens: (messages) => messages.length,
      shouldCompact: () => false,
      prepareCompaction: (entries) => entries,
      compact: () => {
        throw new Error("unexpected compaction");
      },
      contextWindow: 1_000_000,
      settings: {},
    });
    const history = await reconstruct(pool, { threadId, projectItemId: "unused" });
    expect(history).not.toBeNull();
    const converted = toPiMessages(history!.entries, fauxProvider().getModel());
    expect(converted[0]).toMatchObject({ role: "user", content: "question" });
    expect(converted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "search",
          isError: true,
          details: { error: true },
        }),
      ]),
    );
  });
});
