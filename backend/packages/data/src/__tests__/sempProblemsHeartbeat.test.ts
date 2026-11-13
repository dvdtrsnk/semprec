import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createAgentRun,
  createChainedAgentRun,
  finishAgentRunWithErrorNotification,
  getRetryChainFirstRunId,
} from "../agentRuns/agentRunsStore.js";
import { insertAgentRunEvent } from "../agentRuns/agentRunEventsStore.js";
import { createUser } from "../auth/usersStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { CORE_AGENT_RUN_ACTION_ID, coreAgentRunAction, createActionRegistry } from "../scheduler/actions.js";
import { createHeartbeat, sweepDueHeartbeats } from "../scheduler/schedulerStore.js";
import { createHeartbeatFireAgentTask, createHeartbeatFireCoreTask } from "../scheduler/sweep.js";
import { finishTickRunWithMessage, getOrCreateTickThread, type TickThreadRef } from "../semp/sempTickThreadStore.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

class RollbackSentinel extends Error {}

let admin: Pool;
let runtime: Pool;
let tenantA: string;
let tenantB: string;
let projectItemId: string;

interface ProblemRow {
  tenant_id: string;
  user_id: string;
  category: string;
  kind: string;
  severity: string;
  source_table: string;
  source_id: string;
  dedupe_key: string;
  project_item_id: string | null;
  occurrence_count: number;
  resolved_at: Date | null;
}

const inA = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(tenantA, fn);

/** The problem rows of `tenant`, read on the superuser pool so that a row in any tenant is seen. */
async function problemsOf(tenant: string): Promise<ProblemRow[]> {
  const { rows } = await admin.query<ProblemRow>(
    `SELECT tenant_id, user_id, category, kind, severity, source_table, source_id, dedupe_key, project_item_id,
            occurrence_count, resolved_at
       FROM semp_problems WHERE tenant_id = $1 ORDER BY first_seen_at, id`,
    [tenant],
  );
  return rows;
}

async function notificationKinds(): Promise<string[]> {
  const { rows } = await admin.query<{ kind: string }>(
    "SELECT kind FROM notifications WHERE kind <> 'semp_problem' ORDER BY kind",
  );
  return rows.map((row) => row.kind);
}

/**
 * Removes the item for good, as the trash purge does. Raw SQL on the superuser pool: the purge's own
 * `hardDeleteItem` needs the Projects database id and the state wanted is only the missing row.
 */
async function purgeItem(itemId: string): Promise<void> {
  await admin.query("DELETE FROM items WHERE id = $1", [itemId]);
}

async function userOf(tenant: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>("SELECT id FROM users WHERE tenant_id = $1", [tenant]);
  const row = rows[0];
  if (!row) throw new Error("The fixture tenant has no user");
  return row.id;
}

async function makeHeartbeat(actionId: string): Promise<string> {
  const heartbeat = await inA(() =>
    withTransaction(runtime, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: `heartbeat ${actionId}`,
        rule: { kind: "interval", minutes: 5 },
        actionId,
        actionConfig: { task: "do it" },
      }),
    ),
  );
  return heartbeat.id;
}

/** The helpers a graphile-worker job hands its task: only the job's identity and attempt counters are read. */
function jobHelpers(id: string, attempts: number, maxAttempts: number) {
  return { job: { id, attempts, max_attempts: maxAttempts } } as Parameters<
    ReturnType<typeof createHeartbeatFireAgentTask>
  >[1];
}

/** Fires the heartbeat's agent task once, as the queue does for an item-event fire, and expects it to fail. */
async function failAgentFire(heartbeatId: string, jobId: string, attempts: number, maxAttempts: number) {
  const registry = createActionRegistry();
  registry.set(
    CORE_AGENT_RUN_ACTION_ID,
    coreAgentRunAction(runtime, async () => {
      throw new Error("agent failure");
    }),
  );
  const task = createHeartbeatFireAgentTask(runtime, registry);
  await expect(
    inA(async () => {
      await task({ heartbeatId, itemId: projectItemId }, jobHelpers(jobId, attempts, maxAttempts));
    }),
  ).rejects.toThrow("agent failure");
}

/** Runs of the user's tenant; a run needs the tenant's user as its actor. */
function newRun(input: Parameters<typeof createAgentRun>[1]) {
  return inA(() => createAgentRun(runtime, input));
}

function closeWithError(runId: string) {
  return inA(() =>
    withTransaction(runtime, (client) => finishAgentRunWithErrorNotification(client, runId, "internal")),
  );
}

/** A tool call of a tick reply: `failed` stores `details.error`, as a failed generic operation does. */
async function storeToolCall(runId: string, toolCallId: string, failed: boolean): Promise<void> {
  await inA(async () => {
    await insertAgentRunEvent(runtime, runId, "tool_use", {
      kind: "tool_use",
      toolCallId,
      name: "database_list",
      arguments: {},
      operation: "database.list",
    });
    await insertAgentRunEvent(runtime, runId, "tool_result", {
      kind: "tool_result",
      toolCallId,
      name: "database_list",
      operation: "database.list",
      result: { content: [{ type: "text", text: "[]" }], details: { error: failed } },
      isError: false,
    });
  });
}

/** A tick run with its thread, as the run action creates them, ready to be closed with a reply. */
async function startTickRun(heartbeatId: string): Promise<{ thread: TickThreadRef; runId: string }> {
  return inA(() =>
    withTransaction(runtime, async (client) => {
      const thread = await getOrCreateTickThread(client, heartbeatId);
      const run = await createAgentRun(client, {
        projectItemId,
        heartbeatId,
        threadId: thread.id,
        triggeredBy: "heartbeat",
        task: "do it",
      });
      return { thread, runId: run.id };
    }),
  );
}

function finishTickDone(thread: TickThreadRef, runId: string, afterWrite?: () => never) {
  return inA(() =>
    withTransaction(runtime, async (client: PoolClient) => {
      const written = await finishTickRunWithMessage(client, {
        thread,
        agentRunId: runId,
        outcome: { status: "done", result: "the answer" },
      });
      afterWrite?.();
      return written;
    }),
  );
}

async function runStatus(runId: string): Promise<string> {
  const { rows } = await admin.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [runId]);
  return rows[0]?.status ?? "missing";
}

describe("agents problems of heartbeat ticks and runs (issue #1911)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenantA = await createTestTenant(admin);
    tenantB = await createTestTenant(admin);
    for (const tenantId of [tenantA, tenantB]) {
      await createUser(admin, { tenantId, email: `${tenantId}@example.test`, passwordHash: "unused" });
    }
    projectItemId = await inA(() => createTestProjectItem(runtime));
  });

  describe("the sweep reports a heartbeat failure", () => {
    it("raises the heartbeat problem next to heartbeat_error in the transaction of the failure record", async () => {
      const heartbeatId = await makeHeartbeat("noop");
      const registry = createActionRegistry();
      registry.set("noop", async () => {
        throw new Error("handler failure");
      });
      const task = createHeartbeatFireCoreTask(runtime, registry);

      await expect(
        inA(async () => {
          await task({ heartbeatId, itemId: projectItemId }, jobHelpers("job-core-1", 1, 1));
        }),
      ).rejects.toThrow("handler failure");

      expect(await notificationKinds()).toEqual(["heartbeat_error"]);
      expect(await problemsOf(tenantA)).toEqual([
        {
          tenant_id: tenantA,
          user_id: await userOf(tenantA),
          category: "agents",
          kind: "agentHeartbeat",
          severity: "warning",
          source_table: "project_heartbeats",
          source_id: heartbeatId,
          dedupe_key: `agents:heartbeat:${heartbeatId}`,
          project_item_id: null,
          occurrence_count: 1,
          resolved_at: null,
        },
      ]);
    });

    it("raises nothing on an attempt that is not the last", async () => {
      const heartbeatId = await makeHeartbeat("noop");
      const registry = createActionRegistry();
      registry.set("noop", async () => {
        throw new Error("handler failure");
      });
      const task = createHeartbeatFireCoreTask(runtime, registry);

      await expect(
        inA(async () => {
          await task({ heartbeatId, itemId: projectItemId }, jobHelpers("job-core-2", 1, 3));
        }),
      ).rejects.toThrow("handler failure");

      expect(await notificationKinds()).toEqual([]);
      expect(await problemsOf(tenantA)).toEqual([]);
    });

    it("leaves no problem, no notification and no failure record when the raise fails in that transaction", async () => {
      const heartbeatId = await makeHeartbeat("noop");
      const registry = createActionRegistry();
      registry.set("noop", async () => {
        throw new Error("handler failure");
      });
      const task = createHeartbeatFireCoreTask(runtime, registry);
      // The raise is the last write of the transaction; a trigger makes it fail after the notification and
      // the failure record were written, which is a failure only a real database error can produce.
      await admin.query(
        `CREATE FUNCTION p1911_reject_problem() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected problem failure'; END $$`,
      );
      await admin.query(
        "CREATE TRIGGER p1911_reject_problem BEFORE INSERT ON semp_problems FOR EACH ROW EXECUTE FUNCTION p1911_reject_problem()",
      );
      try {
        await expect(
          inA(async () => {
            await task({ heartbeatId, itemId: projectItemId }, jobHelpers("job-core-3", 1, 1));
          }),
        ).rejects.toThrow("injected problem failure");
      } finally {
        await admin.query("DROP TRIGGER p1911_reject_problem ON semp_problems");
        await admin.query("DROP FUNCTION p1911_reject_problem()");
      }

      expect(await notificationKinds()).toEqual([]);
      expect(await problemsOf(tenantA)).toEqual([]);
      const { rows } = await admin.query<{ last_error: string | null }>(
        "SELECT last_error FROM project_heartbeats WHERE id = $1",
        [heartbeatId],
      );
      expect(rows).toEqual([{ last_error: null }]);
    });
  });

  describe("a failed heartbeat tick", () => {
    it("gives exactly one active problem with the heartbeat key for heartbeat_error plus agent_run_error", async () => {
      const heartbeatId = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);

      await failAgentFire(heartbeatId, "job-tick-1", 1, 1);

      expect(await notificationKinds()).toEqual(["agent_run_error", "heartbeat_error"]);
      const problems = await problemsOf(tenantA);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({
        category: "agents",
        kind: "agentHeartbeat",
        severity: "warning",
        source_table: "project_heartbeats",
        source_id: heartbeatId,
        dedupe_key: `agents:heartbeat:${heartbeatId}`,
        project_item_id: null,
        // the run's close and the sweep's failure record are two reports of the same tick
        occurrence_count: 2,
        resolved_at: null,
      });
    });

    it("gives one problem for a second failed tick of the same heartbeat", async () => {
      const heartbeatId = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);

      await failAgentFire(heartbeatId, "job-tick-a", 1, 1);
      await failAgentFire(heartbeatId, "job-tick-b", 1, 1);

      const problems = await problemsOf(tenantA);
      expect(problems.map((problem) => [problem.dedupe_key, problem.occurrence_count])).toEqual([
        [`agents:heartbeat:${heartbeatId}`, 4],
      ]);
    });

    it("gives one problem for three failed attempts of the same occurrence, raised by the last one", async () => {
      const heartbeatId = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
      // A due time cannot be set through the heartbeat creation API.
      await admin.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
        heartbeatId,
      ]);
      const sweep = await inA(() => withTransaction(runtime, (client) => sweepDueHeartbeats(client)));
      expect(sweep.fired).toHaveLength(1);
      const { rows: occurrences } = await admin.query<{ id: string }>(
        "SELECT id FROM heartbeat_occurrences WHERE heartbeat_id = $1",
        [heartbeatId],
      );
      const occurrenceId = occurrences[0]?.id;
      if (!occurrenceId) throw new Error("Missing scheduled occurrence");
      const registry = createActionRegistry();
      registry.set(
        CORE_AGENT_RUN_ACTION_ID,
        coreAgentRunAction(runtime, async () => {
          throw new Error("agent failure");
        }),
      );
      const task = createHeartbeatFireAgentTask(runtime, registry);

      for (const attempt of [1, 2, 3]) {
        await expect(
          inA(async () => {
            await task({ heartbeatId, occurrenceId, generation: 1 }, jobHelpers("job-occurrence", attempt, 3));
          }),
        ).rejects.toThrow("agent failure");
        const expected = attempt === 3 ? 1 : 0;
        expect(await problemsOf(tenantA)).toHaveLength(expected);
      }

      const runs = await admin.query<{ attempt: number; status: string }>(
        "SELECT attempt, status FROM agent_runs WHERE heartbeat_id = $1 ORDER BY attempt",
        [heartbeatId],
      );
      expect(runs.rows).toEqual([1, 2, 3].map((attempt) => ({ attempt, status: "error" })));
      const problems = await problemsOf(tenantA);
      expect(problems.map((problem) => [problem.dedupe_key, problem.occurrence_count])).toEqual([
        [`agents:heartbeat:${heartbeatId}`, 2],
      ]);
    });

    it("leaves no problem, no notification and an open run when the failure transaction of the action rolls back", async () => {
      const heartbeatId = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
      const action = coreAgentRunAction(runtime, async () => {
        throw new Error("agent failure");
      });
      // The message insert is the last write of the failure transaction; a trigger makes it fail after the
      // run was closed, the notification written and the problem raised.
      await admin.query(
        `CREATE FUNCTION p1911_reject_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected message failure'; END $$`,
      );
      await admin.query(
        "CREATE TRIGGER p1911_reject_message BEFORE INSERT ON semp_messages FOR EACH ROW EXECUTE FUNCTION p1911_reject_message()",
      );
      try {
        await expect(inA(() => action({ task: "do it" }, { heartbeatId, projectItemId }))).rejects.toThrow(
          "agent failure",
        );
      } finally {
        await admin.query("DROP TRIGGER p1911_reject_message ON semp_messages");
        await admin.query("DROP FUNCTION p1911_reject_message()");
      }

      const runs = await admin.query<{ status: string }>("SELECT status FROM agent_runs WHERE heartbeat_id = $1", [
        heartbeatId,
      ]);
      expect(runs.rows).toEqual([{ status: "running" }]);
      expect(await notificationKinds()).toEqual([]);
      expect(await problemsOf(tenantA)).toEqual([]);
    });

    it("raises nothing for a tick that succeeded", async () => {
      const heartbeatId = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
      const action = coreAgentRunAction(runtime, async () => ({ result: "fine" }));

      await inA(() => action({ task: "do it" }, { heartbeatId, projectItemId }));

      expect(await problemsOf(tenantA)).toEqual([]);
    });

    it("raises the problem of the tenant that failed and none in another tenant", async () => {
      const heartbeatId = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);

      await failAgentFire(heartbeatId, "job-tick-iso", 1, 1);

      expect(await problemsOf(tenantA)).toHaveLength(1);
      expect(await problemsOf(tenantB)).toEqual([]);
      // Through the runtime role, so that row-level security decides what the other tenant sees.
      const seenByB = await withTenantTransaction(runtime, tenantB, (client) =>
        client.query<{ dedupe_key: string }>("SELECT dedupe_key FROM semp_problems"),
      );
      expect(seenByB.rows).toEqual([]);
      const seenByA = await withTenantTransaction(runtime, tenantA, (client) =>
        client.query<{ dedupe_key: string }>("SELECT dedupe_key FROM semp_problems"),
      );
      expect(seenByA.rows).toEqual([{ dedupe_key: `agents:heartbeat:${heartbeatId}` }]);
    });
  });

  describe("a failed run that is not a heartbeat tick", () => {
    it("raises the problem of a failed delegated run, keyed by the run, with its project item", async () => {
      const supervisor = await newRun({ triggeredBy: "user", unit: "session", task: "chat", projectItemId });
      const delegated = await newRun({
        triggeredBy: "supervisor",
        parentRunId: supervisor.id,
        projectItemId,
        task: "delegated",
      });

      await expect(closeWithError(delegated.id)).resolves.toBe(true);

      expect(await notificationKinds()).toEqual(["agent_run_error"]);
      const problems = await problemsOf(tenantA);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({
        category: "agents",
        kind: "agentRun",
        severity: "warning",
        source_table: "agent_runs",
        source_id: delegated.id,
        dedupe_key: `agents:run:${delegated.id}`,
        project_item_id: projectItemId,
        occurrence_count: 1,
        resolved_at: null,
      });
    });

    it("gives one problem keyed by the first run of the chain for three failed attempts of an MCP run", async () => {
      const first = await newRun({ triggeredBy: "mcp", task: "mcp work" });
      const second = await inA(() =>
        createChainedAgentRun(runtime, { triggeredBy: "mcp", task: "mcp work", retryOfRunId: first.id, attempt: 2 }),
      );
      const third = await inA(() =>
        createChainedAgentRun(runtime, {
          triggeredBy: "mcp",
          task: "mcp work",
          retryOfRunId: second?.id ?? "",
          attempt: 3,
        }),
      );
      if (!second || !third) throw new Error("The retry chain was not created");

      for (const run of [first, second, third]) await closeWithError(run.id);

      const problems = await problemsOf(tenantA);
      expect(problems.map((problem) => [problem.dedupe_key, problem.source_id, problem.occurrence_count])).toEqual([
        [`agents:run:${first.id}`, first.id, 3],
      ]);
      expect(problems[0]?.project_item_id).toBeNull();
    });

    it("closes a run whose project item was purged as error and raises its problem without a project", async () => {
      const projectRun = await newRun({ triggeredBy: "mcp", task: "mcp work", projectItemId });
      await purgeItem(projectItemId);

      await expect(closeWithError(projectRun.id)).resolves.toBe(true);

      expect(await runStatus(projectRun.id)).toBe("error");
      expect(await notificationKinds()).toEqual(["agent_run_error"]);
      const problems = await problemsOf(tenantA);
      expect(
        problems.map((problem) => [problem.dedupe_key, problem.occurrence_count, problem.project_item_id]),
      ).toEqual([[`agents:run:${projectRun.id}`, 1, null]]);
    });

    it("merges a failed attempt whose project item was purged into the problem an earlier attempt raised", async () => {
      const first = await newRun({ triggeredBy: "mcp", task: "mcp work", projectItemId });
      await closeWithError(first.id);
      const second = await inA(() =>
        createChainedAgentRun(runtime, {
          triggeredBy: "mcp",
          task: "mcp work",
          retryOfRunId: first.id,
          attempt: 2,
          projectItemId,
        }),
      );
      if (!second) throw new Error("The retry chain was not created");
      await purgeItem(projectItemId);

      await expect(closeWithError(second.id)).resolves.toBe(true);

      expect(await runStatus(second.id)).toBe("error");
      const problems = await problemsOf(tenantA);
      expect(
        problems.map((problem) => [problem.dedupe_key, problem.occurrence_count, problem.project_item_id]),
      ).toEqual([[`agents:run:${first.id}`, 2, projectItemId]]);
    });

    it("raises nothing for a failed chat turn", async () => {
      const chat = await newRun({ triggeredBy: "user", unit: "session", task: "chat", projectItemId });

      await expect(closeWithError(chat.id)).resolves.toBe(true);

      expect(await notificationKinds()).toEqual(["agent_run_error"]);
      expect(await problemsOf(tenantA)).toEqual([]);
    });

    it("raises nothing for a heartbeat-triggered run that names no heartbeat", async () => {
      const run = await newRun({ triggeredBy: "heartbeat", task: "tick without a heartbeat" });

      await expect(closeWithError(run.id)).resolves.toBe(true);

      expect(await notificationKinds()).toEqual(["agent_run_error"]);
      expect(await problemsOf(tenantA)).toEqual([]);
    });

    it("raises nothing when the close lost to another writer", async () => {
      const run = await newRun({ triggeredBy: "mcp", task: "mcp work" });
      await closeWithError(run.id);
      await admin.query("DELETE FROM semp_problems");

      await expect(closeWithError(run.id)).resolves.toBe(false);

      expect(await problemsOf(tenantA)).toEqual([]);
    });

    it("leaves no problem and an open run when the transaction of the close rolls back", async () => {
      const run = await newRun({ triggeredBy: "mcp", task: "mcp work" });

      await expect(
        inA(() =>
          withTransaction(runtime, async (client) => {
            await finishAgentRunWithErrorNotification(client, run.id, "internal");
            throw new RollbackSentinel("a later step of the transaction fails");
          }),
        ),
      ).rejects.toBeInstanceOf(RollbackSentinel);

      expect(await runStatus(run.id)).toBe("running");
      expect(await problemsOf(tenantA)).toEqual([]);
    });

    it("finds the first run of a chain from any of its runs and from a run that retries nothing", async () => {
      const first = await newRun({ triggeredBy: "mcp", task: "mcp work" });
      const second = await inA(() =>
        createChainedAgentRun(runtime, { triggeredBy: "mcp", task: "mcp work", retryOfRunId: first.id, attempt: 2 }),
      );
      if (!second) throw new Error("The retry chain was not created");

      const firstOf = (runId: string, tenant = tenantA) =>
        runInTenant(tenant, () => getRetryChainFirstRunId(runtime, runId));

      await expect(firstOf(second.id)).resolves.toBe(first.id);
      await expect(firstOf(first.id)).resolves.toBe(first.id);
      // another tenant's run is as unknown as a random id
      await expect(firstOf(second.id, tenantB)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("a heartbeat tick whose reply left a failed tool call", () => {
    it("raises the heartbeat problem with the message write although the run is done", async () => {
      const heartbeatId = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
      const { thread, runId } = await startTickRun(heartbeatId);
      await storeToolCall(runId, "call-1", true);

      await expect(finishTickDone(thread, runId)).resolves.toBe(true);

      expect(await runStatus(runId)).toBe("done");
      // no agent_run_error: the run ended done
      expect(await notificationKinds()).toEqual([]);
      const problems = await problemsOf(tenantA);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({
        category: "agents",
        kind: "agentHeartbeat",
        severity: "warning",
        source_table: "project_heartbeats",
        source_id: heartbeatId,
        dedupe_key: `agents:heartbeat:${heartbeatId}`,
        occurrence_count: 1,
      });
    });

    it("raises it through the run action when the agent's tool call failed", async () => {
      const heartbeatId = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
      const action = coreAgentRunAction(runtime, async ({ agentRunId }) => {
        await storeToolCall(agentRunId, "call-action", true);
        return { result: "done anyway" };
      });

      await inA(() => action({ task: "do it" }, { heartbeatId, projectItemId }));

      expect((await problemsOf(tenantA)).map((problem) => problem.dedupe_key)).toEqual([
        `agents:heartbeat:${heartbeatId}`,
      ]);
    });

    it("merges with the problem a failed tick of the same heartbeat raised", async () => {
      const heartbeatId = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
      await failAgentFire(heartbeatId, "job-tick-merge", 1, 1);
      const { thread, runId } = await startTickRun(heartbeatId);
      await storeToolCall(runId, "call-merge", true);

      await finishTickDone(thread, runId);

      const problems = await problemsOf(tenantA);
      expect(problems.map((problem) => [problem.dedupe_key, problem.occurrence_count])).toEqual([
        [`agents:heartbeat:${heartbeatId}`, 3],
      ]);
    });

    it("leaves no problem and an open run when the transaction of the message write rolls back", async () => {
      const heartbeatId = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
      const { thread, runId } = await startTickRun(heartbeatId);
      await storeToolCall(runId, "call-rollback", true);

      await expect(
        finishTickDone(thread, runId, () => {
          throw new RollbackSentinel("a later step of the transaction fails");
        }),
      ).rejects.toBeInstanceOf(RollbackSentinel);

      expect(await runStatus(runId)).toBe("running");
      const { rows } = await admin.query("SELECT id FROM semp_messages WHERE agent_run_id = $1", [runId]);
      expect(rows).toEqual([]);
      expect(await problemsOf(tenantA)).toEqual([]);
    });

    it("raises nothing for a failed call that a later successful call of the same tool made up for", async () => {
      const heartbeatId = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
      const { thread, runId } = await startTickRun(heartbeatId);
      await storeToolCall(runId, "call-failed", true);
      await storeToolCall(runId, "call-retried", false);

      await finishTickDone(thread, runId);

      expect(await problemsOf(tenantA)).toEqual([]);
    });

    it("raises nothing for a reply whose tool calls all succeeded", async () => {
      const heartbeatId = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
      const { thread, runId } = await startTickRun(heartbeatId);
      await storeToolCall(runId, "call-ok", false);

      await finishTickDone(thread, runId);

      expect(await problemsOf(tenantA)).toEqual([]);
    });

    it("raises nothing for a run that stored no events", async () => {
      const heartbeatId = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
      const { thread, runId } = await startTickRun(heartbeatId);

      await finishTickDone(thread, runId);

      const { rows } = await admin.query<{ event_from_id: string | null }>(
        "SELECT event_from_id FROM semp_messages WHERE agent_run_id = $1",
        [runId],
      );
      expect(rows).toEqual([{ event_from_id: null }]);
      expect(await problemsOf(tenantA)).toEqual([]);
    });

    it("writes the message and raises nothing when the tenant has no user", async () => {
      const heartbeatId = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
      const { thread, runId } = await startTickRun(heartbeatId);
      await storeToolCall(runId, "call-no-user", true);
      // The run already carries its actor, so the user can only be removed with the foreign keys switched off.
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL session_replication_role = replica");
        await admin.query("DELETE FROM users WHERE tenant_id = $1", [tenantA]);
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }

      await expect(finishTickDone(thread, runId)).resolves.toBe(true);

      expect(await runStatus(runId)).toBe("done");
      expect(await problemsOf(tenantA)).toEqual([]);
    });

    it("raises nothing when the run was already closed by another writer", async () => {
      const heartbeatId = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
      const { thread, runId } = await startTickRun(heartbeatId);
      await storeToolCall(runId, "call-closed", true);
      await finishTickDone(thread, runId);
      await admin.query("DELETE FROM semp_problems");

      await expect(finishTickDone(thread, runId)).resolves.toBe(false);

      expect(await problemsOf(tenantA)).toEqual([]);
    });
  });
});
