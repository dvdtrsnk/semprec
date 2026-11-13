import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createAgentRun,
  createChainedAgentRun,
  finishAgentRun,
  finishAgentRunWithErrorNotification,
} from "../agentRuns/agentRunsStore.js";
import { insertAgentRunEvent } from "../agentRuns/agentRunEventsStore.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { upsertProcessHeartbeat } from "../health/processHeartbeats.js";
import {
  databaseHasItemAutomationError,
  ensureItemAutomation,
  markItemAutomationError,
} from "../library/itemAutomationStore.js";
import {
  enqueueLibraryMetadataProcessing,
  handleProcessLibraryMetadataTask,
  type LibraryMetadataFetcher,
} from "../library/libraryMetadataJob.js";
import { handleObservabilityCheckSystemTask } from "../observability/observabilityCheckSystem.js";
import { RESTORE_TEST_CHECK_KEY, recordRestoreTestResult } from "../observability/restoreTestResult.js";
import { CORE_AGENT_RUN_ACTION_ID, coreAgentRunAction } from "../scheduler/actions.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { raiseAgentHeartbeatProblem, raiseAgentRunProblem } from "../semp/agentProblems.js";
import { agentHeartbeatProblemKey, agentRunProblemKey } from "../semp/agentProblemKeys.js";
import { createGuidanceProblemWriter } from "../semp/guidanceProblemWriter.js";
import { raiseProblem } from "../semp/sempProblemsStore.js";
import { finishTickRunWithMessage, getOrCreateTickThread, type TickThreadRef } from "../semp/sempTickThreadStore.js";
import {
  AGENTS_PROCESS_PROBLEM_KEY,
  BACKUP_RESTORE_PROBLEM_KEY,
  automationProblemKey,
  guidanceProblemKey,
} from "../semp/sourceProblemKeys.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  inTenantZero,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

class RollbackSentinel extends Error {}

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;

interface ProblemRow {
  user_id: string;
  dedupe_key: string;
  occurrence_count: number;
  resolved_at: Date | null;
  resolution_kind: string | null;
}

/** Every problem row of the database, on the superuser pool so that a row of any tenant is seen. */
async function allProblems(): Promise<ProblemRow[]> {
  const { rows } = await admin.query<ProblemRow>(
    `SELECT user_id, dedupe_key, occurrence_count, resolved_at, resolution_kind
       FROM semp_problems ORDER BY dedupe_key, first_seen_at, user_id`,
  );
  return rows;
}

async function problemsOf(tenantId: string): Promise<ProblemRow[]> {
  const { rows } = await admin.query<ProblemRow>(
    `SELECT user_id, dedupe_key, occurrence_count, resolved_at, resolution_kind
       FROM semp_problems WHERE tenant_id = $1 ORDER BY dedupe_key, first_seen_at`,
    [tenantId],
  );
  return rows;
}

/** The state of each problem by dedupe key: `active`, or the resolution kind. Only for rows with distinct keys. */
function states(problems: ProblemRow[]): Record<string, string> {
  return Object.fromEntries(
    problems.map((problem) => [
      problem.dedupe_key,
      problem.resolved_at === null ? "active" : (problem.resolution_kind ?? "resolved"),
    ]),
  );
}

const ACTIVE = { resolved_at: null, resolution_kind: null };
const RECOVERED = { resolved_at: expect.any(Date), resolution_kind: "recovered" };

async function createTenantUser(tenantId: string, role: "admin" | "member"): Promise<string> {
  const user = await createUser(admin, {
    email: `${randomUUID()}@example.test`,
    passwordHash: await hashPassword("s3cret-password"),
    locale: "en",
    tenantId,
    role,
  });
  return user.id;
}

/** An administrator in a tenant of its own (one user per tenant). */
async function createAdminTenant(): Promise<{ tenantId: string; userId: string }> {
  const tenantId = await createTestTenant(admin);
  return { tenantId, userId: await createTenantUser(tenantId, "admin") };
}

describe("semp problems close when their source recovers (issue #1915)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    chokePoint = createChokePoint(admin);
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    await admin.query("DELETE FROM tenant_observability_checks");
  });

  describe("heartbeat ticks and retry chains", () => {
    let tenantA: string;
    let tenantB: string;
    let userA: string;
    let userB: string;
    let projectItemId: string;

    const inA = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(tenantA, fn);

    beforeEach(async () => {
      tenantA = await createTestTenant(admin);
      tenantB = await createTestTenant(admin);
      userA = await createTenantUser(tenantA, "member");
      userB = await createTenantUser(tenantB, "member");
      projectItemId = await inA(() => createTestProjectItem(runtime));
    });

    async function makeHeartbeat(): Promise<string> {
      const heartbeat = await inA(() =>
        withTransaction(runtime, (client) =>
          createHeartbeat(client, {
            projectItemId,
            name: "recovering heartbeat",
            rule: { kind: "interval", minutes: 5 },
            actionId: CORE_AGENT_RUN_ACTION_ID,
            actionConfig: { task: "do it" },
          }),
        ),
      );
      return heartbeat.id;
    }

    /** A tick run with its thread, as the run action creates them, ready to be closed with a reply. */
    function startTickRun(heartbeatId: string): Promise<{ thread: TickThreadRef; runId: string }> {
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

    /** The failure of a tick: its final attempt closes the run as an error, which raises the heartbeat problem. */
    async function failTick(heartbeatId: string): Promise<void> {
      const { runId } = await startTickRun(heartbeatId);
      await inA(() =>
        withTransaction(runtime, (client) => finishAgentRunWithErrorNotification(client, runId, "internal")),
      );
    }

    function raiseHeartbeatProblem(heartbeatId: string, tenantId = tenantA, userId = userA): Promise<unknown> {
      return runInTenant(tenantId, () =>
        withTransaction(runtime, (client) =>
          raiseAgentHeartbeatProblem(client, { userId, heartbeatId, occurrenceKey: randomUUID() }),
        ),
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

    function finishTickDone(thread: TickThreadRef, runId: string, afterWrite?: () => never): Promise<boolean> {
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

    async function runRow(runId: string): Promise<{ status: string; finished_at: Date | null }> {
      const { rows } = await admin.query<{ status: string; finished_at: Date | null }>(
        "SELECT status, finished_at FROM agent_runs WHERE id = $1",
        [runId],
      );
      const row = rows[0];
      if (!row) throw new Error(`run ${runId} is missing`);
      return row;
    }

    /** A first run that failed and a second one that retries it, both of the same tick thread. */
    async function startChain(
      heartbeatId: string,
    ): Promise<{ thread: TickThreadRef; firstRunId: string; retryId: string }> {
      return inA(() =>
        withTransaction(runtime, async (client) => {
          const thread = await getOrCreateTickThread(client, heartbeatId);
          const common = {
            projectItemId,
            heartbeatId,
            threadId: thread.id,
            triggeredBy: "heartbeat" as const,
            task: "do it",
          };
          const first = await createAgentRun(client, common);
          await finishAgentRun(client, first.id, "error", "internal");
          const retry = await createChainedAgentRun(client, { ...common, retryOfRunId: first.id, attempt: 2 });
          if (!retry) throw new Error("The first run was already retried");
          return { thread, firstRunId: first.id, retryId: retry.id };
        }),
      );
    }

    function raiseChainProblem(firstRunId: string): Promise<unknown> {
      return inA(() =>
        withTransaction(runtime, (client) =>
          raiseAgentRunProblem(client, { userId: userA, firstRunId, failedRunId: firstRunId, projectItemId: null }),
        ),
      );
    }

    it("resolves the heartbeat problem of a failed tick in the transaction that closes the later successful run", async () => {
      const heartbeatId = await makeHeartbeat();
      await failTick(heartbeatId);
      expect(await problemsOf(tenantA)).toMatchObject([
        { dedupe_key: agentHeartbeatProblemKey(heartbeatId), ...ACTIVE },
      ]);
      const action = coreAgentRunAction(runtime, async () => ({ result: "all fine" }));

      await inA(() => action({ task: "do it" }, { heartbeatId, projectItemId }));

      const problems = await problemsOf(tenantA);
      expect(problems).toMatchObject([{ dedupe_key: agentHeartbeatProblemKey(heartbeatId), ...RECOVERED }]);
      const { rows } = await admin.query<{ id: string; finished_at: Date }>(
        "SELECT id, finished_at FROM agent_runs WHERE status = 'done'",
      );
      expect(rows).toHaveLength(1);
      // `now()` is the start of the transaction: the same instant on both rows means the same transaction.
      expect(problems[0]?.resolved_at).toEqual(rows[0]?.finished_at);
    });

    it("resolves it for a done run whose events all succeeded", async () => {
      const heartbeatId = await makeHeartbeat();
      await failTick(heartbeatId);
      const { thread, runId } = await startTickRun(heartbeatId);
      await storeToolCall(runId, "call-ok", false);

      await finishTickDone(thread, runId);

      expect(await problemsOf(tenantA)).toMatchObject([RECOVERED]);
    });

    it("resolves it when a failed call was made up for by a later successful call of the same tool", async () => {
      const heartbeatId = await makeHeartbeat();
      await failTick(heartbeatId);
      const { thread, runId } = await startTickRun(heartbeatId);
      await storeToolCall(runId, "call-failed", true);
      await storeToolCall(runId, "call-retried", false);

      await finishTickDone(thread, runId);

      expect(await problemsOf(tenantA)).toMatchObject([RECOVERED]);
    });

    it("keeps the problem active, and merges the new report into it, when the run is done but its reply left a failed tool call", async () => {
      const heartbeatId = await makeHeartbeat();
      await failTick(heartbeatId);
      const { thread, runId } = await startTickRun(heartbeatId);
      await storeToolCall(runId, "call-failed", true);

      await expect(finishTickDone(thread, runId)).resolves.toBe(true);

      expect((await runRow(runId)).status).toBe("done");
      expect(await problemsOf(tenantA)).toMatchObject([
        { dedupe_key: agentHeartbeatProblemKey(heartbeatId), occurrence_count: 2, ...ACTIVE },
      ]);
    });

    it("keeps the problem active through the run action when the agent's tool call failed", async () => {
      const heartbeatId = await makeHeartbeat();
      await failTick(heartbeatId);
      const action = coreAgentRunAction(runtime, async ({ agentRunId }) => {
        await storeToolCall(agentRunId, "call-action", true);
        return { result: "done anyway" };
      });

      await inA(() => action({ task: "do it" }, { heartbeatId, projectItemId }));

      expect(await problemsOf(tenantA)).toMatchObject([
        { dedupe_key: agentHeartbeatProblemKey(heartbeatId), ...ACTIVE },
      ]);
    });

    it("keeps the problem active, and the run open, when the recovery transaction rolls back", async () => {
      const heartbeatId = await makeHeartbeat();
      await failTick(heartbeatId);
      const { thread, runId } = await startTickRun(heartbeatId);

      await expect(
        finishTickDone(thread, runId, () => {
          throw new RollbackSentinel("a later step of the transaction fails");
        }),
      ).rejects.toBeInstanceOf(RollbackSentinel);

      expect((await runRow(runId)).status).toBe("running");
      expect(await problemsOf(tenantA)).toMatchObject([
        { dedupe_key: agentHeartbeatProblemKey(heartbeatId), ...ACTIVE },
      ]);
    });

    it("leaves the problem of another heartbeat active", async () => {
      const heartbeatId = await makeHeartbeat();
      const otherHeartbeatId = randomUUID();
      await raiseHeartbeatProblem(otherHeartbeatId);
      await failTick(heartbeatId);
      const { thread, runId } = await startTickRun(heartbeatId);

      await finishTickDone(thread, runId);

      expect(states(await problemsOf(tenantA))).toEqual({
        [agentHeartbeatProblemKey(heartbeatId)]: "recovered",
        [agentHeartbeatProblemKey(otherHeartbeatId)]: "active",
      });
    });

    it("changes nothing for a done tick that has no problem", async () => {
      const heartbeatId = await makeHeartbeat();
      const { thread, runId } = await startTickRun(heartbeatId);

      await expect(finishTickDone(thread, runId)).resolves.toBe(true);

      expect((await runRow(runId)).status).toBe("done");
      expect(await allProblems()).toEqual([]);
    });

    it("does not resolve the problem of the same key in another tenant", async () => {
      const heartbeatId = await makeHeartbeat();
      await failTick(heartbeatId);
      // Dedupe keys are tenant scoped: tenant B holds an active problem under tenant A's heartbeat key.
      await raiseHeartbeatProblem(heartbeatId, tenantB, userB);
      const { thread, runId } = await startTickRun(heartbeatId);

      await finishTickDone(thread, runId);

      expect(await problemsOf(tenantA)).toMatchObject([RECOVERED]);
      expect(await problemsOf(tenantB)).toMatchObject([
        { dedupe_key: agentHeartbeatProblemKey(heartbeatId), ...ACTIVE },
      ]);
    });

    it("resolves the problem of the retry chain when a run of the chain succeeds", async () => {
      const heartbeatId = await makeHeartbeat();
      const { thread, firstRunId, retryId } = await startChain(heartbeatId);
      const otherChainKey = agentRunProblemKey(randomUUID());
      await raiseChainProblem(firstRunId);
      await inA(() =>
        withTransaction(runtime, (client) =>
          raiseProblem(client, {
            userId: userA,
            category: "agents",
            kind: "agentRun",
            severity: "warning",
            sourceTable: "agent_runs",
            sourceId: firstRunId,
            dedupeKey: otherChainKey,
          }),
        ),
      );

      await finishTickDone(thread, retryId);

      expect(states(await problemsOf(tenantA))).toEqual({
        [agentRunProblemKey(firstRunId)]: "recovered",
        [otherChainKey]: "active",
      });
    });

    it("resolves the chain problem from the first run of a chain of three", async () => {
      const heartbeatId = await makeHeartbeat();
      const { thread, firstRunId, retryId } = await startChain(heartbeatId);
      const third = await inA(() =>
        withTransaction(runtime, async (client) => {
          await finishAgentRun(client, retryId, "error", "internal");
          const run = await createChainedAgentRun(client, {
            projectItemId,
            heartbeatId,
            threadId: thread.id,
            triggeredBy: "heartbeat",
            task: "do it",
            retryOfRunId: retryId,
            attempt: 3,
          });
          if (!run) throw new Error("The second run was already retried");
          return run;
        }),
      );
      await raiseChainProblem(firstRunId);

      await finishTickDone(thread, third.id);

      expect(await problemsOf(tenantA)).toMatchObject([{ dedupe_key: agentRunProblemKey(firstRunId), ...RECOVERED }]);
    });

    it("keeps the chain problem active when the successful run's reply left a failed tool call", async () => {
      const heartbeatId = await makeHeartbeat();
      const { thread, firstRunId, retryId } = await startChain(heartbeatId);
      await raiseChainProblem(firstRunId);
      await storeToolCall(retryId, "call-failed", true);

      await finishTickDone(thread, retryId);

      expect(states(await problemsOf(tenantA))).toEqual({
        [agentHeartbeatProblemKey(heartbeatId)]: "active",
        [agentRunProblemKey(firstRunId)]: "active",
      });
    });

    it("keeps the chain problem active when the recovery transaction rolls back", async () => {
      const heartbeatId = await makeHeartbeat();
      const { thread, firstRunId, retryId } = await startChain(heartbeatId);
      await raiseChainProblem(firstRunId);

      await expect(
        finishTickDone(thread, retryId, () => {
          throw new RollbackSentinel("a later step of the transaction fails");
        }),
      ).rejects.toBeInstanceOf(RollbackSentinel);

      expect(await problemsOf(tenantA)).toMatchObject([{ dedupe_key: agentRunProblemKey(firstRunId), ...ACTIVE }]);
    });
  });

  describe("guidance drift", () => {
    async function inZero<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withTenantTransaction(admin, getTenantZeroId(), fn);
    }

    async function raiseDrift(userId: string, projectItemId: string, fingerprint: string, occurrenceKey: string) {
      await inZero((client) =>
        createGuidanceProblemWriter().raise(client, {
          userId,
          projectItemId,
          fingerprint,
          findingId: randomUUID(),
          occurrenceKey,
        }),
      );
    }

    function resolveDrift(projectItemId: string, fingerprint: string) {
      return inZero((client) => createGuidanceProblemWriter().resolve(client, { projectItemId, fingerprint }));
    }

    it("resolves the problem of one finding and leaves the problem of another finding active", async () => {
      const userId = await createTenantUser(getTenantZeroId(), "admin");
      const projectItemId = await createTestProjectItem(admin);
      await raiseDrift(userId, projectItemId, "fp-a", "fp-a:1");
      await raiseDrift(userId, projectItemId, "fp-b", "fp-b:1");

      await resolveDrift(projectItemId, "fp-a");

      expect(await allProblems()).toMatchObject([
        { dedupe_key: guidanceProblemKey(projectItemId, "fp-a"), ...RECOVERED },
        { dedupe_key: guidanceProblemKey(projectItemId, "fp-b"), ...ACTIVE },
      ]);
    });

    it("starts a new problem when the same finding returns after it was resolved", async () => {
      const userId = await createTenantUser(getTenantZeroId(), "admin");
      const projectItemId = await createTestProjectItem(admin);
      await raiseDrift(userId, projectItemId, "fp-a", "fp-a:1");
      await resolveDrift(projectItemId, "fp-a");

      await raiseDrift(userId, projectItemId, "fp-a", "fp-a:2");

      const problems = await allProblems();
      expect(problems).toMatchObject([
        { occurrence_count: 1, ...RECOVERED },
        { occurrence_count: 1, ...ACTIVE },
      ]);
    });

    it("changes nothing for a finding that has no active problem", async () => {
      const projectItemId = await createTestProjectItem(admin);

      await resolveDrift(projectItemId, "fp-unknown");

      expect(await allProblems()).toEqual([]);
    });

    it("keeps the problem active when the surrounding transaction rolls back", async () => {
      const userId = await createTenantUser(getTenantZeroId(), "admin");
      const projectItemId = await createTestProjectItem(admin);
      await raiseDrift(userId, projectItemId, "fp-a", "fp-a:1");

      await expect(
        inZero(async (client) => {
          await createGuidanceProblemWriter().resolve(client, { projectItemId, fingerprint: "fp-a" });
          throw new RollbackSentinel();
        }),
      ).rejects.toBeInstanceOf(RollbackSentinel);

      expect(await allProblems()).toMatchObject([ACTIVE]);
    });
  });

  describe("restore test", () => {
    function record(result: Parameters<typeof recordRestoreTestResult>[1]) {
      return runAsSystem("test", () => recordRestoreTestResult(runtime, result));
    }

    async function restoreCheckStatus(): Promise<string | undefined> {
      const { rows } = await admin.query<{ status: string }>(
        "SELECT status FROM observability_checks WHERE check_key = $1",
        [RESTORE_TEST_CHECK_KEY],
      );
      return rows[0]?.status;
    }

    it("resolves the backup problem of each administrator in that administrator's tenant when the test passes", async () => {
      const first = await createAdminTenant();
      const second = await createAdminTenant();
      await record({ runId: "20260101T000000Z-1", status: "failed", failedCheck: "itemsCount" });
      expect(await allProblems()).toMatchObject([
        { dedupe_key: BACKUP_RESTORE_PROBLEM_KEY, ...ACTIVE },
        { dedupe_key: BACKUP_RESTORE_PROBLEM_KEY, ...ACTIVE },
      ]);

      await record({ runId: "20260201T000000Z-2", status: "passed" });

      const problems = await allProblems();
      expect(problems.map((problem) => problem.user_id).sort()).toEqual([first.userId, second.userId].sort());
      for (const problem of problems)
        expect(problem).toMatchObject({ dedupe_key: BACKUP_RESTORE_PROBLEM_KEY, ...RECOVERED });
      expect(await restoreCheckStatus()).toBe("ok");
    });

    it("leaves the same-keyed problem of a tenant without an administrator active", async () => {
      await createAdminTenant();
      const memberTenant = await createTestTenant(admin);
      const memberId = await createTenantUser(memberTenant, "member");
      await runInTenant(memberTenant, () =>
        withTransaction(runtime, (client) =>
          raiseProblem(client, {
            userId: memberId,
            category: "backup",
            kind: "backupRestore",
            severity: "critical",
            sourceTable: "observability_checks",
            sourceId: randomUUID(),
            dedupeKey: BACKUP_RESTORE_PROBLEM_KEY,
          }),
        ),
      );
      await record({ runId: "20260101T000000Z-1", status: "failed", failedCheck: "itemsCount" });

      await record({ runId: "20260201T000000Z-2", status: "passed" });

      expect(await problemsOf(memberTenant)).toMatchObject([{ dedupe_key: BACKUP_RESTORE_PROBLEM_KEY, ...ACTIVE }]);
      expect((await allProblems()).filter((problem) => problem.resolved_at !== null)).toHaveLength(1);
    });

    it("changes nothing for a passed test with no earlier failure", async () => {
      await createAdminTenant();

      await record({ runId: "20260101T000000Z-1", status: "passed" });

      expect(await allProblems()).toEqual([]);
    });

    it("keeps the problem active and the check alerting when resolving it fails", async () => {
      const { tenantId } = await createAdminTenant();
      await record({ runId: "20260101T000000Z-1", status: "failed", failedCheck: "itemsCount" });
      // Fault injection: no production path deliberately fails the resolution.
      await admin.query(
        `CREATE FUNCTION p1915_reject_resolution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected resolution failure'; END $$`,
      );
      await admin.query(
        "CREATE TRIGGER p1915_reject_resolution BEFORE UPDATE ON semp_problems FOR EACH ROW EXECUTE FUNCTION p1915_reject_resolution()",
      );
      try {
        await expect(record({ runId: "20260201T000000Z-2", status: "passed" })).rejects.toThrow(AggregateError);
      } finally {
        await admin.query("DROP TRIGGER p1915_reject_resolution ON semp_problems");
        await admin.query("DROP FUNCTION p1915_reject_resolution()");
      }

      expect(await problemsOf(tenantId)).toMatchObject([ACTIVE]);
      expect(await restoreCheckStatus()).toBe("alerting");
    });
  });

  describe("stale agents process", () => {
    async function markAllProcessesFresh(): Promise<void> {
      for (const process of ["api", "agents", "transcribe", "ai-gateway"]) {
        await upsertProcessHeartbeat(admin, { process, pid: 1, version: "1.0.0" }, new Date());
      }
    }

    async function makeStale(process: string): Promise<void> {
      await admin.query(`UPDATE process_heartbeats SET beat_at = now() - interval '5 minutes' WHERE process = $1`, [
        process,
      ]);
    }

    async function makeFresh(process: string): Promise<void> {
      await admin.query(`UPDATE process_heartbeats SET beat_at = now() WHERE process = $1`, [process]);
    }

    function runCheck(): Promise<void> {
      return runAsSystem("test", () => handleObservabilityCheckSystemTask(runtime, { job: { id: randomUUID() } }));
    }

    it("resolves the agents problem of each administrator when the process beats again", async () => {
      const first = await createAdminTenant();
      const second = await createAdminTenant();
      await markAllProcessesFresh();
      await makeStale("agents");
      await runCheck();
      expect(await allProblems()).toMatchObject([
        { dedupe_key: AGENTS_PROCESS_PROBLEM_KEY, ...ACTIVE },
        { dedupe_key: AGENTS_PROCESS_PROBLEM_KEY, ...ACTIVE },
      ]);

      await makeFresh("agents");
      await runCheck();

      const problems = await allProblems();
      expect(problems.map((problem) => problem.user_id).sort()).toEqual([first.userId, second.userId].sort());
      for (const problem of problems)
        expect(problem).toMatchObject({ dedupe_key: AGENTS_PROCESS_PROBLEM_KEY, ...RECOVERED });
    });

    it("keeps the problem active while the process stays stale", async () => {
      await createAdminTenant();
      await markAllProcessesFresh();
      await makeStale("agents");

      await runCheck();
      await runCheck();

      expect(await allProblems()).toMatchObject([
        { dedupe_key: AGENTS_PROCESS_PROBLEM_KEY, occurrence_count: 1, ...ACTIVE },
      ]);
    });

    it("keeps the agents problem active when another process recovers", async () => {
      await createAdminTenant();
      await markAllProcessesFresh();
      await makeStale("agents");
      await makeStale("transcribe");
      await runCheck();

      await makeFresh("transcribe");
      await runCheck();

      expect(await allProblems()).toMatchObject([{ dedupe_key: AGENTS_PROCESS_PROBLEM_KEY, ...ACTIVE }]);
    });

    it("changes nothing when the process was never stale", async () => {
      await createAdminTenant();
      await markAllProcessesFresh();

      await runCheck();
      await runCheck();

      expect(await allProblems()).toEqual([]);
    });
  });

  describe("library automation", () => {
    const failingFetcher: LibraryMetadataFetcher = async () => {
      throw new Error("source unavailable");
    };
    const succeedingFetcher: LibraryMetadataFetcher = async () => ({ status: "found", source: "tmdb" });
    const notFoundFetcher: LibraryMetadataFetcher = async () => ({ status: "notFound", source: "tmdb" });

    interface Fixture {
      moviesId: string;
      booksId: string;
      userId: string;
    }

    async function fixture(): Promise<Fixture> {
      await seedSystem(admin);
      const userId = await createTenantUser(getTenantZeroId(), "admin");
      const { rows } = await admin.query<{ id: string; owner_module_id: string }>(
        "SELECT id, owner_module_id FROM databases WHERE owner_module_id IN ('movies', 'books')",
      );
      const moviesId = rows.find((row) => row.owner_module_id === "movies")?.id;
      const booksId = rows.find((row) => row.owner_module_id === "books")?.id;
      if (!moviesId || !booksId) throw new Error("The seed has no Movies or Books database");
      return { moviesId, booksId, userId };
    }

    function newItem(databaseId: string, name: string): Promise<string> {
      return inTenantZero(async () => (await chokePoint.createItem({ databaseId, properties: { name } })).id);
    }

    function payloadOf(databaseId: string, itemId: string) {
      return { itemId, databaseId, config: { source: "tmdb", coverKey: "cover" } };
    }

    async function runJob(databaseId: string, itemId: string, fetcher: LibraryMetadataFetcher, jobId = randomUUID()) {
      const payload = payloadOf(databaseId, itemId);
      await inTenantZero(() =>
        withTenantTransaction(admin, getTenantZeroId(), async (client) => {
          await enqueueLibraryMetadataProcessing(client, payload);
        }),
      );
      await handleProcessLibraryMetadataTask(admin, payload, fetcher, { job: { id: jobId } });
    }

    async function failJob(databaseId: string, itemId: string) {
      await expect(runJob(databaseId, itemId, failingFetcher)).rejects.toThrow("Library metadata processing failed");
    }

    it("resolves the problem only when the last item with an error has been completed", async () => {
      const { moviesId } = await fixture();
      const first = await newItem(moviesId, "First");
      const second = await newItem(moviesId, "Second");
      await failJob(moviesId, first);
      await failJob(moviesId, second);

      await runJob(moviesId, first, succeedingFetcher);
      expect(await allProblems()).toMatchObject([{ dedupe_key: automationProblemKey(moviesId), ...ACTIVE }]);

      await runJob(moviesId, second, succeedingFetcher);
      expect(await allProblems()).toMatchObject([{ dedupe_key: automationProblemKey(moviesId), ...RECOVERED }]);
    });

    it("resolves the problem when the last item with an error is found to have no match", async () => {
      const { moviesId } = await fixture();
      const item = await newItem(moviesId, "Unknown film");
      await failJob(moviesId, item);

      await runJob(moviesId, item, notFoundFetcher);

      expect(await allProblems()).toMatchObject([{ dedupe_key: automationProblemKey(moviesId), ...RECOVERED }]);
    });

    it("is not held back by an error in another database, and does not resolve that database's problem", async () => {
      const { moviesId, booksId } = await fixture();
      const film = await newItem(moviesId, "Film");
      const book = await newItem(booksId, "Book");
      await failJob(moviesId, film);
      await failJob(booksId, book);

      await runJob(moviesId, film, succeedingFetcher);

      expect(states(await allProblems())).toEqual({
        [automationProblemKey(booksId)]: "active",
        [automationProblemKey(moviesId)]: "recovered",
      });
    });

    it("is not held back by an item with an error that was moved to the trash", async () => {
      const { moviesId } = await fixture();
      const kept = await newItem(moviesId, "Kept");
      const trashed = await newItem(moviesId, "Trashed");
      await failJob(moviesId, kept);
      await failJob(moviesId, trashed);
      await inTenantZero(() => chokePoint.softDeleteItem(moviesId, trashed));

      await runJob(moviesId, kept, succeedingFetcher);

      expect(await allProblems()).toMatchObject([{ dedupe_key: automationProblemKey(moviesId), ...RECOVERED }]);
    });

    it("starts a new problem when an item fails again after the problem was resolved", async () => {
      const { moviesId } = await fixture();
      const item = await newItem(moviesId, "Flaky");
      await failJob(moviesId, item);
      await runJob(moviesId, item, succeedingFetcher);

      await failJob(moviesId, item);

      expect(await allProblems()).toMatchObject([{ ...RECOVERED }, { ...ACTIVE }]);
    });

    it("changes nothing for a successful job when the database has no problem", async () => {
      const { moviesId } = await fixture();
      const item = await newItem(moviesId, "Fine");

      await runJob(moviesId, item, succeedingFetcher);

      expect(await allProblems()).toEqual([]);
    });

    it("reports whether any item of a database has an automation error", async () => {
      const { moviesId, booksId } = await fixture();
      const film = await newItem(moviesId, "Film");
      await inTenantZero(() =>
        withTenantTransaction(admin, getTenantZeroId(), async (client) => {
          await ensureItemAutomation(client, film);
          expect(await databaseHasItemAutomationError(client, moviesId)).toBe(false);
          await markItemAutomationError(client, film, "boom");
          expect(await databaseHasItemAutomationError(client, moviesId)).toBe(true);
          expect(await databaseHasItemAutomationError(client, booksId)).toBe(false);
        }),
      );
    });

    it("keeps the problem active when a failing job of another item commits while the successful job waits for the problem's lock", async () => {
      const { moviesId, userId } = await fixture();
      const recovering = await newItem(moviesId, "Recovering");
      const failing = await newItem(moviesId, "Failing");
      await failJob(moviesId, recovering);
      const key = automationProblemKey(moviesId);

      // The failing job of the other item has written its error and holds the problem's lock, uncommitted.
      const holder = await admin.connect();
      let succeeded: Promise<void> | undefined;
      try {
        await holder.query("BEGIN");
        await ensureItemAutomation(holder, failing);
        await markItemAutomationError(holder, failing, "boom");
        await raiseProblem(holder, {
          userId,
          category: "automation",
          kind: "libraryAutomation",
          severity: "warning",
          sourceTable: "item_automation",
          sourceId: failing,
          dedupeKey: key,
          occurrenceKey: "failing-job",
        });
        succeeded = runJob(moviesId, recovering, succeedingFetcher);
        succeeded.catch(() => undefined);
        await waitForAdvisoryLockWaiter();
        await holder.query("COMMIT");
      } catch (error) {
        await holder.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        holder.release();
      }
      await succeeded;

      expect(await allProblems()).toMatchObject([{ dedupe_key: key, occurrence_count: 2, ...ACTIVE }]);
    });

    async function waitForAdvisoryLockWaiter(): Promise<void> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await admin.query<{ waiting: string }>(
          "SELECT count(*)::text AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
        );
        if (Number(rows[0]?.waiting) > 0) return;
        if (Date.now() > deadline) throw new Error("No transaction is waiting for the problem's lock");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });
});
