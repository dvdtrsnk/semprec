import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { closeIdleThreadSessions, createBoundedSempHistory } from "@semprec/agent-runtime";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  claimSempMessage,
  createAgentRun,
  createUser,
  enqueueSempThreadTitleIfFirst,
  finishSempMessageTurn,
  insertAgentRunEvent,
  loadFullModuleRegistry,
  seedSystem,
  sendSempMessage,
  startSempMessageTurn,
  withTransaction,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import type { ModuleRegistry } from "@semprec/module-registry";
import { AGENT_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";
import type { GatewayModel } from "../modelComposition.js";
import { createAgentsQueueRuntime, type AgentsQueueRuntime } from "../queueRuntime.js";
import { createSempMessageTask } from "../sempMessageTask.js";
import { createGracefulShutdown } from "../shutdown.js";
import { logger } from "../logger.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let registry: ModuleRegistry;
let runtime: AgentsQueueRuntime | undefined;

describe("queued Semp messages", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tenant = await createTestTenant(admin);
    await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(tenant, () => seedSystem(pool));
    registry = await loadFullModuleRegistry();
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      await runtime?.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await pool?.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      await admin?.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Semp test cleanup failed", { cause: errors[0] });
  });

  it("runs two queued turns in their stored order through the real agents runtime", async () => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    runtime = await createAgentsQueueRuntime(pool, registry, {
      sempMessageTask: createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns()),
    });
    const first = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => sendSempMessage(client, { text: "first", context: [], hasContext: false })),
    );
    const second = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, { threadId: first.threadId, text: "second", context: [], hasContext: false }),
      ),
    );
    const read = () =>
      runInTenant(tenant, () =>
        pool.query<{
          id: string;
          text: string | null;
          status: string | null;
          agent_run_id: string | null;
          event_from_id: string | null;
          event_to_id: string | null;
        }>(
          "SELECT id, text, status, agent_run_id, event_from_id, event_to_id FROM semp_messages WHERE id = ANY($1::uuid[]) ORDER BY created_at, id",
          [[first.assistantMessageId, second.assistantMessageId]],
        ),
      );
    const deadline = Date.now() + 15_000;
    let rows = (await read()).rows;
    while (rows.some((row) => row.status !== "done") && Date.now() < deadline) {
      await sleep(50);
      rows = (await read()).rows;
    }
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.id, row.text, row.status])).toEqual([
      [first.assistantMessageId, "first answer", "done"],
      [second.assistantMessageId, "second answer", "done"],
    ]);
    for (const row of rows) {
      expect(row.agent_run_id).toEqual(expect.any(String));
      expect(row.event_from_id).toEqual(expect.any(String));
      expect(row.event_to_id).toEqual(expect.any(String));
    }
  });

  it("rolls back a title job observed in the same transaction as the done transition", async () => {
    await runtime?.stop();
    runtime = undefined;
    const turn = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, { text: "title rollback", context: [], hasContext: false }),
      ),
    );
    const eventId = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        expect(await claimSempMessage(client, turn.threadId, turn.assistantMessageId)).toBe(true);
        const run = await createAgentRun(client, {
          triggeredBy: "user",
          unit: "session",
          task: "title rollback",
          threadId: turn.threadId,
        });
        const event = await insertAgentRunEvent(client, run.id, "message", { kind: "message", text: "answer" });
        await startSempMessageTurn(client, turn.assistantMessageId, run.id, event.id);
        return event.id;
      }),
    );
    await expect(
      runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          expect(
            await finishSempMessageTurn(client, turn.assistantMessageId, {
              status: "done",
              text: "answer",
              lastEventId: eventId,
            }),
          ).toBe(true);
          await enqueueSempThreadTitleIfFirst(client, turn.threadId, turn.assistantMessageId);
          const job = await client.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = $1", [
            `sempThreadTitle:${turn.threadId}`,
          ]);
          expect(job.rows).toEqual([{ key: `sempThreadTitle:${turn.threadId}` }]);
          throw new Error("rollback sentinel");
        }),
      ),
    ).rejects.toThrow("rollback sentinel");
    const after = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => ({
        message: await client.query<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [
          turn.assistantMessageId,
        ]),
        job: await client.query("SELECT key FROM graphile_worker.jobs WHERE key = $1", [
          `sempThreadTitle:${turn.threadId}`,
        ]),
      })),
    );
    expect(after.message.rows).toEqual([{ status: "running" }]);
    expect(after.job.rows).toEqual([]);
  });

  it("stores a provider failure once, continues the thread and ignores redelivery of its completed reply", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider refused" }),
      fauxAssistantMessage("recovered"),
      fauxAssistantMessage("must not be used"),
    ]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    runtime = await createAgentsQueueRuntime(pool, registry, {
      sempMessageTask: createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns()),
    });
    const first = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => sendSempMessage(client, { text: "fail", context: [], hasContext: false })),
    );
    const read = (id: string) =>
      runInTenant(
        tenant,
        async () =>
          (
            await pool.query<{ status: string; text: string | null }>(
              "SELECT status, text FROM semp_messages WHERE id = $1",
              [id],
            )
          ).rows[0],
      );
    const awaitStatus = async (id: string, status: string) => {
      const deadline = Date.now() + 15_000;
      let row = await read(id);
      while (row?.status !== status && Date.now() < deadline) {
        await sleep(50);
        row = await read(id);
      }
      expect(row?.status).toBe(status);
      return row;
    };
    await awaitStatus(first.assistantMessageId, "error");
    const failedJob = await admin.query("SELECT id FROM graphile_worker.jobs WHERE key = $1", [
      `sempMessage:${first.assistantMessageId}`,
    ]);
    expect(failedJob.rows).toEqual([]);
    const second = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, { threadId: first.threadId, text: "continue", context: [], hasContext: false }),
      ),
    );
    expect(await awaitStatus(second.assistantMessageId, "done")).toEqual({ status: "done", text: "recovered" });
    const redeliveryKey = `redelivery:${randomUUID()}`;
    await runInTenant(tenant, () =>
      enqueueJob(
        pool,
        AGENT_TASK_NAMES.SEMP_MESSAGE,
        { threadId: second.threadId, assistantMessageId: second.assistantMessageId },
        { jobKey: redeliveryKey, maxAttempts: 1 },
      ),
    );
    const deadline = Date.now() + 15_000;
    let job = await admin.query("SELECT id FROM graphile_worker.jobs WHERE key = $1", [redeliveryKey]);
    while (job.rowCount && Date.now() < deadline) {
      await sleep(50);
      job = await admin.query("SELECT id FROM graphile_worker.jobs WHERE key = $1", [redeliveryKey]);
    }
    expect(job.rows).toEqual([]);
    expect(await read(second.assistantMessageId)).toEqual({ status: "done", text: "recovered" });
    expect(faux.getPendingResponseCount()).toBe(1);
  });

  it("runs turns for different tenants concurrently on the dedicated runner", async () => {
    await runtime?.stop();
    runtime = undefined;
    const other = await createTestTenant(admin);
    await createUser(admin, { tenantId: other, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(other, () => seedSystem(pool));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const faux = fauxProvider();
    faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage("first tenant");
      },
      async () => {
        await gate;
        return fauxAssistantMessage("second tenant");
      },
    ]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    runtime = await createAgentsQueueRuntime(pool, registry, {
      sempMessageTask: createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns()),
    });
    try {
      const a = await runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          sendSempMessage(client, { text: "first tenant", context: [], hasContext: false }),
        ),
      );
      const b = await runInTenant(other, () =>
        withTransaction(pool, (client) =>
          sendSempMessage(client, { text: "second tenant", context: [], hasContext: false }),
        ),
      );
      const deadline = Date.now() + 15_000;
      while (faux.state.callCount < 2 && Date.now() < deadline) await sleep(50);
      expect(faux.state.callCount).toBe(2);
      for (const [scope, id] of [
        [tenant, a.assistantMessageId],
        [other, b.assistantMessageId],
      ] as const) {
        const row = await runInTenant(scope, () =>
          pool.query<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [id]),
        );
        expect(row.rows).toEqual([{ status: "running" }]);
      }
    } finally {
      release();
      await runtime.stop();
      runtime = undefined;
    }
  });

  it("refuses oversized stored history before a model call without writing a checkpoint", async () => {
    const turn = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const first = await sendSempMessage(client, { text: "earlier", context: [], hasContext: false });
        expect(await claimSempMessage(client, first.threadId, first.assistantMessageId)).toBe(true);
        const run = await createAgentRun(client, {
          triggeredBy: "user",
          unit: "session",
          task: "earlier",
          threadId: first.threadId,
        });
        const event = await insertAgentRunEvent(client, run.id, "message", {
          kind: "message",
          text: "ě".repeat(131_073),
        });
        await startSempMessageTurn(client, first.assistantMessageId, run.id, event.id);
        expect(
          await finishSempMessageTurn(client, first.assistantMessageId, {
            status: "done",
            text: "earlier answer",
            lastEventId: event.id,
          }),
        ).toBe(true);
        return first;
      }),
    );
    const next = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, { threadId: turn.threadId, text: "next", context: [], hasContext: false }),
      ),
    );
    await expect(
      runInTenant(tenant, () => createBoundedSempHistory()(pool, { threadId: turn.threadId, projectItemId: "unused" })),
    ).rejects.toThrow("Semp conversation history exceeds replay limits");
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("must not run")]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    runtime = await createAgentsQueueRuntime(pool, registry, {
      sempMessageTask: createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns()),
    });
    const deadline = Date.now() + 15_000;
    let rows = await runInTenant(tenant, () =>
      pool.query<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [next.assistantMessageId]),
    );
    while (rows.rows[0]?.status !== "error" && Date.now() < deadline) {
      await sleep(50);
      rows = await runInTenant(tenant, () =>
        pool.query<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [next.assistantMessageId]),
      );
    }
    expect(rows.rows).toEqual([{ status: "error" }]);
    expect(faux.state.callCount).toBe(0);
    const checkpoints = await runInTenant(tenant, () =>
      pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM agent_run_events e JOIN agent_runs r ON r.id = e.agent_run_id WHERE r.thread_id = $1 AND e.kind = 'compaction'",
        [turn.threadId],
      ),
    );
    expect(checkpoints.rows).toEqual([{ count: 0 }]);
  });

  it("rejects shutdown when a real worker absorbs a terminal persistence failure", async () => {
    await runtime?.stop();
    runtime = undefined;
    const shutdownPool = await createRuntimeRolePool(admin, "semprec_data");
    const inFlight = createInFlightAgentRuns();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const faux = fauxProvider();
    faux.setResponses([
      async () => {
        entered();
        await gate;
        return fauxAssistantMessage("reply");
      },
    ]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    let actualRuntime: AgentsQueueRuntime | undefined;
    let closed = false;
    let triggerInstalled = false;
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `test_semp_terminal_${suffix}`;
    const triggerName = `test_semp_terminal_${suffix}`;
    let failure: { error: unknown } | undefined;
    try {
      actualRuntime = await createAgentsQueueRuntime(shutdownPool, registry, {
        sempMessageTask: createSempMessageTask(shutdownPool, registry, gateway, inFlight),
      });
      const turn = await runInTenant(tenant, () =>
        withTransaction(shutdownPool, (client) =>
          sendSempMessage(client, { text: "fail terminal persistence", context: [], hasContext: false }),
        ),
      );
      await started;
      // Fault injection is scoped to this one synthetic message in this suite's owned database.
      await admin.query(
        `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${turn.assistantMessageId}'::uuid AND NEW.status IN ('done', 'error') THEN RAISE EXCEPTION 'terminal fixture failure'; END IF; RETURN NEW; END $$`,
      );
      await admin.query(
        `CREATE TRIGGER ${triggerName} BEFORE UPDATE ON semp_messages FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      );
      triggerInstalled = true;
      let runnerStopped = false;
      const currentRuntime = actualRuntime;
      const queueRuntime = {
        stop: async () => {
          await currentRuntime.stop();
          runnerStopped = true;
        },
      };
      const shutdown = createGracefulShutdown({
        queueRuntime,
        tenantDeactivationListener: { close: async () => {} },
        pool: shutdownPool,
        logger,
        closeIdleThreadSessions,
        abortSempTurns: () => {
          inFlight.abortSemp();
        },
        observeSempSettlement: () => inFlight.observeSempSettlement(),
      })("SIGTERM");
      release();
      const error: unknown = await shutdown.catch((reason: unknown) => reason);
      closed = true;
      expect(runnerStopped).toBe(true);
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw new Error("Expected persistence failure");
      expect(error.errors).toHaveLength(2);
      expect(error.cause).toBe(error.errors[0]);
      const status = await runInTenant(tenant, () =>
        pool.query<{ status: string; error_code: string | null }>(
          "SELECT status, error_code FROM semp_messages WHERE id = $1",
          [turn.assistantMessageId],
        ),
      );
      expect(status.rows).toEqual([{ status: "running", error_code: null }]);
    } catch (error) {
      failure = { error };
    }
    release();
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      async () => {
        if (!closed) await actualRuntime?.stop();
      },
      async () => {
        if (!closed) await shutdownPool.end();
      },
      async () => {
        if (triggerInstalled) await admin.query(`DROP TRIGGER ${triggerName} ON semp_messages`);
      },
      async () => {
        await admin.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
        "Semp shutdown test cleanup failed",
        { cause: failure?.error },
      );
    if (failure) throw failure.error;
  });

  it("stores interrupted status when the Semp shutdown controller aborts actual work", async () => {
    const shutdownPool = await createRuntimeRolePool(admin, "semprec_data");
    const inFlight = createInFlightAgentRuns();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const faux = fauxProvider();
    faux.setResponses([
      async (_context, options) => {
        if (!options?.signal) throw new Error("Missing provider abort signal");
        const signal = options.signal;
        entered();
        return new Promise((_, reject) => {
          if (signal.aborted) reject(new Error("provider aborted"));
          else signal.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true });
        });
      },
    ]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    let actualRuntime: AgentsQueueRuntime | undefined;
    let closed = false;
    let failure: { error: unknown } | undefined;
    try {
      actualRuntime = await createAgentsQueueRuntime(shutdownPool, registry, {
        sempMessageTask: createSempMessageTask(shutdownPool, registry, gateway, inFlight),
      });
      const turn = await runInTenant(tenant, () =>
        withTransaction(shutdownPool, (client) =>
          sendSempMessage(client, { text: "interrupt", context: [], hasContext: false }),
        ),
      );
      await started;
      const shutdown = createGracefulShutdown({
        queueRuntime: actualRuntime,
        tenantDeactivationListener: { close: async () => {} },
        pool: shutdownPool,
        logger,
        closeIdleThreadSessions,
        abortSempTurns: () => {
          inFlight.abortSemp();
        },
        observeSempSettlement: () => inFlight.observeSempSettlement(),
      })("SIGTERM");
      // Exercise the real deadline action without advancing or shortening the production timer.
      expect(inFlight.abortSemp()).toBe(1);
      await shutdown;
      closed = true;
      const status = await runInTenant(tenant, () =>
        pool.query<{ status: string; error_code: string | null }>(
          "SELECT status, error_code FROM semp_messages WHERE id = $1",
          [turn.assistantMessageId],
        ),
      );
      expect(status.rows).toEqual([{ status: "error", error_code: "interrupted" }]);
    } catch (error) {
      failure = { error };
    }
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      async () => {
        if (!closed) {
          inFlight.abortSemp();
          await actualRuntime?.stop();
        }
      },
      async () => {
        if (!closed) await shutdownPool.end();
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
        "Semp abort test cleanup failed",
        { cause: failure?.error },
      );
    if (failure) throw failure.error;
  });
});
