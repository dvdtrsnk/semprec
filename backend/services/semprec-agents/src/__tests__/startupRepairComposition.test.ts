import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import {
  closeIdleThreadSessions,
  createReconstructConversationHistory,
  repairInterruptedRuns,
} from "@semprec/agent-runtime";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  claimSempMessage,
  createAgentRun,
  createUser,
  finishAgentRun,
  getDatabaseByModuleId,
  hashPassword,
  insertAgentRunEvent,
  loadFullModuleRegistry,
  seedSystem,
  sendSempMessage,
  startSempMessageTurn,
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
import { REALTIME_CHANNEL, wireRealtimeHooks } from "@semprec/realtime";
import { createAgentsQueueRuntime, type AgentsQueueRuntime } from "../queueRuntime.js";
import { toPiMessages } from "../piConversationHistory.js";
import { createGracefulShutdown } from "../shutdown.js";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";
import { createSempMessageTask } from "../sempMessageTask.js";
import type { GatewayModel } from "../modelComposition.js";

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
        observeSempSettlement: () => ({ wait: async () => [], snapshotAndDispose: () => [] }),
        queueRuntime: {
          stopForShutdown: () => {
            order.push("queue");
            return {
              general: Promise.resolve({ status: "fulfilled" as const, value: undefined }),
              chat: Promise.resolve({ status: "fulfilled" as const, value: undefined }),
            };
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
    const listener = await pool.connect();
    const observed: Array<{ tenantId: string; threadId: string }> = [];
    listener.on("notification", (notification) => {
      if (notification.channel !== REALTIME_CHANNEL || !notification.payload) return;
      const value: unknown = JSON.parse(notification.payload);
      if (typeof value !== "object" || value === null || !("tenantId" in value) || typeof value.tenantId !== "string")
        return;
      if (!("message" in value) || typeof value.message !== "object" || value.message === null) return;
      const message = value.message;
      if (
        !("type" in message) ||
        message.type !== "invalidation" ||
        !("scope" in message) ||
        message.scope !== "sempThread" ||
        !("threadId" in message) ||
        typeof message.threadId !== "string"
      )
        return;
      observed.push({ tenantId: value.tenantId, threadId: message.threadId });
    });
    let failure: { error: unknown } | undefined;
    try {
      await listener.query(`LISTEN ${REALTIME_CHANNEL}`);
      wireRealtimeHooks(runtimePool);
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
      const completedRun = await runInTenant(getTenantZeroId(), () =>
        createAgentRun(runtimePool, {
          triggeredBy: "user",
          unit: "session",
          task: "completed",
          threadId: first.threadId,
        }),
      );
      const event = await runInTenant(getTenantZeroId(), () =>
        insertAgentRunEvent(runtimePool, completedRun.id, "turn_start", { kind: "turn_start" }),
      );
      expect(
        await runInTenant(getTenantZeroId(), () => finishAgentRun(runtimePool, completedRun.id, "done", null)),
      ).toBe(true);
      await runInTenant(getTenantZeroId(), () =>
        withTransaction(runtimePool, (client) =>
          startSempMessageTurn(client, first.assistantMessageId, completedRun.id, event.id),
        ),
      );
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
      const oldActivity = new Date("2001-01-01T00:00:00.000Z");
      for (const [tenantId, threadId] of [
        [getTenantZeroId(), first.threadId],
        [other, second.threadId],
      ] as const) {
        const backdated = await runInTenant(tenantId, () =>
          runtimePool.query("UPDATE semp_threads SET last_activity_at = $2 WHERE id = $1", [threadId, oldActivity]),
        );
        expect(backdated.rowCount).toBe(1);
      }
      await repairInterruptedRuns(runtimePool);
      const notifyDeadline = Date.now() + 5_000;
      while (observed.length < 2 && Date.now() < notifyDeadline) await sleep(25);
      expect(observed).toContainEqual({ tenantId: getTenantZeroId(), threadId: first.threadId });
      expect(observed).toContainEqual({ tenantId: other, threadId: second.threadId });
      expect(observed).not.toContainEqual({ tenantId: other, threadId: first.threadId });
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
      const completedState = await runInTenant(getTenantZeroId(), () =>
        runtimePool.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [completedRun.id]),
      );
      expect(completedState.rows).toEqual([{ status: "done" }]);
      expect((await read(other, second.assistantMessageId)).rows).toEqual([
        { status: "error", error_code: "interrupted" },
      ]);
      expect((await read(other, first.assistantMessageId)).rows).toEqual([]);
      expect((await read(other, randomUUID())).rows).toEqual([]);
      expect((await read(other, queued.assistantMessageId)).rows).toEqual([{ status: "queued", error_code: null }]);
      expect((await locks()).rows).toEqual(before);
      const snapshot = (tenantId: string, id: string) =>
        runInTenant(tenantId, () =>
          runtimePool.query<{ status: string; error_code: string | null; updated_at: Date; last_activity_at: Date }>(
            `SELECT m.status, m.error_code, m.updated_at, t.last_activity_at
               FROM semp_messages m JOIN semp_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id
              WHERE m.id = $1`,
            [id],
          ),
        );
      const firstBefore = (await snapshot(getTenantZeroId(), first.assistantMessageId)).rows;
      const secondBefore = (await snapshot(other, second.assistantMessageId)).rows;
      expect(firstBefore[0]?.last_activity_at.getTime()).toBeGreaterThan(oldActivity.getTime());
      expect(secondBefore[0]?.last_activity_at.getTime()).toBeGreaterThan(oldActivity.getTime());
      const again = await repairInterruptedRuns(runtimePool);
      expect(again.repairedRunIds).toEqual([]);
      expect((await snapshot(getTenantZeroId(), first.assistantMessageId)).rows).toEqual(firstBefore);
      expect((await snapshot(other, second.assistantMessageId)).rows).toEqual(secondBefore);
      expect((await read(getTenantZeroId(), first.assistantMessageId)).rows).toEqual([
        { status: "error", error_code: "interrupted" },
      ]);
      expect((await locks()).rows).toEqual(before);
    } catch (error) {
      failure = { error };
    }
    const cleanup: unknown[] = [];
    try {
      listener.release(true);
    } catch (error) {
      cleanup.push(error);
    }
    try {
      await runtimePool.end();
    } catch (error) {
      cleanup.push(error);
    }
    if (cleanup.length)
      throw new AggregateError(failure ? [failure.error, ...cleanup] : cleanup, "Repair test cleanup failed", {
        cause: failure?.error,
      });
    if (failure) throw failure.error;
  });

  it("rolls back a tenant's run repair when its Semp repair fails while another tenant commits", async () => {
    const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `test_repair_rollback_${suffix}`;
    const triggerName = `test_repair_rollback_${suffix}`;
    let triggerInstalled = false;
    let failure: { error: unknown } | undefined;
    try {
      const role = await runAsSystem("test:repair-rollback-role", () =>
        runtimePool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const firstTenant = await createTestTenant(pool);
      const secondTenant = await createTestTenant(pool);
      for (const tenantId of [firstTenant, secondTenant])
        await createUser(pool, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
      const makeTurn = (tenantId: string) =>
        runInTenant(tenantId, () =>
          withTransaction(runtimePool, async (client) => {
            const turn = await sendSempMessage(client, { text: "repair rollback", context: [], hasContext: false });
            expect(await claimSempMessage(client, turn.threadId, turn.assistantMessageId)).toBe(true);
            const run = await createAgentRun(client, {
              triggeredBy: "user",
              unit: "session",
              task: "repair rollback",
              threadId: turn.threadId,
            });
            const event = await insertAgentRunEvent(client, run.id, "turn_start", { kind: "turn_start" });
            await startSempMessageTurn(client, turn.assistantMessageId, run.id, event.id);
            return { ...turn, runId: run.id };
          }),
        );
      const first = await makeTurn(firstTenant);
      const second = await makeTurn(secondTenant);
      // DDL identifiers contain only a fixed ASCII prefix and randomUUID hex; the embedded value is validated UUID text.
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(first.assistantMessageId))
        throw new Error("Invalid fixture message UUID");
      await pool.query(
        `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${first.assistantMessageId}'::uuid AND NEW.status = 'error' THEN RAISE EXCEPTION 'repair fixture failure'; END IF; RETURN NEW; END $$`,
      );
      await pool.query(
        `CREATE TRIGGER ${triggerName} BEFORE UPDATE ON semp_messages FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      );
      triggerInstalled = true;
      await expect(repairInterruptedRuns(runtimePool)).rejects.toBeInstanceOf(AggregateError);
      const state = (tenantId: string, id: string) =>
        runInTenant(tenantId, () =>
          runtimePool.query<{ message_status: string; error_code: string | null; run_status: string }>(
            `SELECT m.status AS message_status, m.error_code, r.status AS run_status
               FROM semp_messages m JOIN agent_runs r ON r.tenant_id = m.tenant_id AND r.id = m.agent_run_id
              WHERE m.id = $1`,
            [id],
          ),
        );
      expect((await state(firstTenant, first.assistantMessageId)).rows).toEqual([
        { message_status: "running", error_code: null, run_status: "running" },
      ]);
      expect((await state(secondTenant, second.assistantMessageId)).rows).toEqual([
        { message_status: "error", error_code: "interrupted", run_status: "error" },
      ]);
      expect((await state(secondTenant, first.assistantMessageId)).rows).toEqual([]);
      expect((await state(secondTenant, randomUUID())).rows).toEqual([]);
      const notifications = await runInTenant(firstTenant, () =>
        runtimePool.query<{ count: number }>("SELECT count(*)::int AS count FROM notifications WHERE source_id = $1", [
          first.runId,
        ]),
      );
      expect(notifications.rows).toEqual([{ count: 0 }]);
    } catch (error) {
      failure = { error };
    }
    const cleanup: unknown[] = [];
    for (const action of [
      async () => {
        if (triggerInstalled) await pool.query(`DROP TRIGGER ${triggerName} ON semp_messages`);
      },
      async () => pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`),
      async () => runtimePool.end(),
    ]) {
      try {
        await action();
      } catch (error) {
        cleanup.push(error);
      }
    }
    if (cleanup.length)
      throw new AggregateError(failure ? [failure.error, ...cleanup] : cleanup, "Repair rollback test cleanup failed", {
        cause: failure?.error,
      });
    if (failure) throw failure.error;
  });

  it("processes the next queued message after repairing an interrupted Semp turn", async () => {
    const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    let failure: { error: unknown } | undefined;
    try {
      const role = await runAsSystem("test:recovery-role", () =>
        runtimePool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const tenant = getTenantZeroId();
      await runInTenant(tenant, () => seedSystem(runtimePool));
      const crashed = await runInTenant(tenant, () =>
        withTransaction(runtimePool, async (client) => {
          const inbox = await getDatabaseByModuleId(client, "inbox");
          if (!inbox?.ownerProjectItemId) throw new Error("Missing Semprec project");
          const turn = await sendSempMessage(client, { text: "interrupted question", context: [], hasContext: false });
          expect(await claimSempMessage(client, turn.threadId, turn.assistantMessageId)).toBe(true);
          const run = await createAgentRun(client, {
            projectItemId: inbox.ownerProjectItemId,
            threadId: turn.threadId,
            triggeredBy: "user",
            unit: "session",
            task: "interrupted question",
          });
          const event = await insertAgentRunEvent(client, run.id, "user_message", {
            kind: "user_message",
            text: "interrupted question",
            context: [],
          });
          await startSempMessageTurn(client, turn.assistantMessageId, run.id, event.id);
          return turn;
        }),
      );
      await repairInterruptedRuns(runtimePool);
      const repaired = await runInTenant(tenant, () =>
        runtimePool.query<{ status: string; error_code: string | null }>(
          "SELECT status, error_code FROM semp_messages WHERE id = $1",
          [crashed.assistantMessageId],
        ),
      );
      expect(repaired.rows).toEqual([{ status: "error", error_code: "interrupted" }]);
      const faux = fauxProvider();
      faux.setResponses([fauxAssistantMessage("reply after repair")]);
      const gateway: GatewayModel = {
        model: faux.getModel(),
        streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
        isBudgetRefusal: () => false,
      };
      const registry = await loadFullModuleRegistry();
      runtime = await createAgentsQueueRuntime(runtimePool, registry, {
        sempMessageTask: createSempMessageTask(runtimePool, registry, gateway, createInFlightAgentRuns()),
      });
      const next = await runInTenant(tenant, () =>
        withTransaction(runtimePool, (client) =>
          sendSempMessage(client, {
            threadId: crashed.threadId,
            text: "next question",
            context: [],
            hasContext: false,
          }),
        ),
      );
      const deadline = Date.now() + 15_000;
      let reply = await runInTenant(tenant, () =>
        runtimePool.query<{ status: string; text: string | null }>(
          "SELECT status, text FROM semp_messages WHERE id = $1",
          [next.assistantMessageId],
        ),
      );
      while (reply.rows[0]?.status !== "done" && Date.now() < deadline) {
        await sleep(50);
        reply = await runInTenant(tenant, () =>
          runtimePool.query<{ status: string; text: string | null }>(
            "SELECT status, text FROM semp_messages WHERE id = $1",
            [next.assistantMessageId],
          ),
        );
      }
      expect(reply.rows).toEqual([{ status: "done", text: "reply after repair" }]);
      expect(
        (
          await runInTenant(tenant, () =>
            runtimePool.query("SELECT status, error_code FROM semp_messages WHERE id = $1", [
              crashed.assistantMessageId,
            ]),
          )
        ).rows,
      ).toEqual(repaired.rows);
    } catch (error) {
      failure = { error };
    }
    const cleanupErrors: unknown[] = [];
    try {
      await runtime?.stop();
      runtime = undefined;
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await runtimePool.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
        "Recovery test cleanup failed",
        { cause: failure?.error },
      );
    if (failure) throw failure.error;
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
