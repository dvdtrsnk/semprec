import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  AgentRunCancelledError,
  type AgentMessage,
  type AgentSession,
  type CreateAgentSession,
} from "@semprec/agent-runtime";
import {
  createAgentRun,
  createUser,
  loadFullModuleRegistry,
  startTenantDeactivationListener,
  suspendAccount,
  withTransaction,
  type TenantDeactivationListener,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import type { ModuleRegistry } from "@semprec/module-registry";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createAgentRunTask, createRunAgentForHeartbeats } from "../agentRunTasks.js";
import { createInFlightAgentRuns, type InFlightAgentRuns } from "../inFlightAgentRuns.js";
import type { GatewayModel } from "../modelComposition.js";

const PROJECT_ITEM_ID = "00000000-0000-4000-8000-0000000000f1";
const JOB_HELPERS = { job: { id: "1" } };
const sessionsByRunId = new Map<string, CreateAgentSession>();
let composedRunIds: string[] = [];
const compositionGates = new Map<string, Promise<void>>();

// The session composition needs a gateway and tool wiring that cancellation does not exercise: the
// factory is replaced with one that hands out the test's own fake session per run.
vi.mock("../agentSessionComposition.js", () => ({
  createAgentSessionFactoryForRun: async (
    _pool: Pool,
    _registry: ModuleRegistry,
    _gateway: GatewayModel,
    run: { id: string },
  ) => {
    composedRunIds.push(run.id);
    const factory = sessionsByRunId.get(run.id);
    if (!factory) throw new Error(`no fake session for run ${run.id}`);
    await compositionGates.get(run.id);
    return factory;
  },
}));

interface Account {
  userId: string;
  tenantId: string;
}

/** A session that yields `turn_start`, signals it started, then hangs until the gate opens; `return()` is recorded. */
function slowSession(): {
  factory: CreateAgentSession;
  started: Promise<void>;
  openGate: () => void;
  returned: () => boolean;
  signal: () => AbortSignal | undefined;
} {
  let returned = false;
  let sessionSignal: AbortSignal | undefined;
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const factory: CreateAgentSession = (options): AgentSession => {
    sessionSignal = options.signal;
    return {
      messages() {
        let step = 0;
        const iterator: AsyncIterator<AgentMessage> = {
          async next() {
            step += 1;
            if (step === 1) {
              markStarted();
              return { done: false, value: { kind: "turn_start" } };
            }
            if (step === 2) {
              await gate;
              return { done: false, value: { kind: "message", text: "finished" } };
            }
            return { done: true, value: undefined };
          },
          return() {
            returned = true;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
        return { [Symbol.asyncIterator]: () => iterator };
      },
    };
  };
  return { factory, started, openGate, returned: () => returned, signal: () => sessionSignal };
}

describe("agents process cancels a deactivated tenant's in-flight runs (issue #1050)", () => {
  let adminPool: Pool;
  let dataPool: Pool;
  let agentsPool: Pool;
  let listenerPool: Pool;
  let listener: TenantDeactivationListener | null;
  let inFlight: InFlightAgentRuns;
  let moduleRegistry: ModuleRegistry;
  let actor: Account;
  let a: Account;
  let b: Account;
  const gateway = {} as GatewayModel;

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    agentsPool = await createRuntimeRolePool(adminPool, "semprec_data");
    listenerPool = await createRuntimeRolePool(adminPool, "semprec_data");
    moduleRegistry = await loadFullModuleRegistry();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    await adminPool.query("DELETE FROM admin_audit_log");
    sessionsByRunId.clear();
    compositionGates.clear();
    composedRunIds = [];
    inFlight = createInFlightAgentRuns();
    listener = null;
    actor = await makeAccount("admin");
    a = await makeAccount("member");
    b = await makeAccount("member");
  });

  afterEach(async () => {
    await listener?.close();
  });

  afterAll(async () => {
    await Promise.all([dataPool?.end(), agentsPool?.end(), listenerPool?.end()]);
  });

  async function makeAccount(role: "admin" | "member"): Promise<Account> {
    const tenantId = await createTestTenant(adminPool);
    const user = await createUser(adminPool, {
      email: `${role}-${tenantId}@example.test`,
      passwordHash: "unused",
      tenantId,
      role,
    });
    return { userId: user.id, tenantId };
  }

  function openRun(account: Account) {
    return runInTenant(account.tenantId, () =>
      createAgentRun(agentsPool, { triggeredBy: "user", task: "work", userId: account.userId }),
    );
  }

  async function runStatus(account: Account, runId: string): Promise<string> {
    return runInTenant(account.tenantId, async () => {
      const { rows } = await agentsPool.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [
        runId,
      ]);
      return rows[0]!.status;
    });
  }

  async function errorNotificationCount(account: Account, runId: string): Promise<number> {
    return runInTenant(account.tenantId, async () => {
      const { rows } = await agentsPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM notifications WHERE kind = 'agent_run_error' AND source_id = $1",
        [runId],
      );
      return Number(rows[0]!.count);
    });
  }

  async function terminalEvents(account: Account, runId: string): Promise<string[]> {
    return runInTenant(account.tenantId, async () => {
      const { rows } = await agentsPool.query<{ status: string }>(
        `SELECT payload->>'status' AS status FROM agent_run_events
         WHERE agent_run_id = $1 AND kind = 'run_status' AND payload->>'status' <> 'running' ORDER BY id`,
        [runId],
      );
      return rows.map((row) => row.status);
    });
  }

  function suspend(target: Account): Promise<unknown> {
    return runAsSystem("agentRunCancellationTest", () =>
      withTransaction(dataPool, (client) =>
        suspendAccount(client, { actorUserId: actor.userId, targetUserId: target.userId }),
      ),
    );
  }

  it("aborts the suspended tenant's agentRun and leaves the other tenant's run to complete", async () => {
    const runA = await openRun(a);
    const runB = await openRun(b);
    const sessionA = slowSession();
    const sessionB = slowSession();
    sessionsByRunId.set(runA.id, sessionA.factory);
    sessionsByRunId.set(runB.id, sessionB.factory);
    listener = await startTenantDeactivationListener(listenerPool, async (tenantId) => {
      inFlight.abortTenant(tenantId);
    });
    const task = createAgentRunTask(agentsPool, moduleRegistry, gateway, inFlight);

    const jobA = runInTenant(a.tenantId, () => task({ agentRunId: runA.id }, JOB_HELPERS));
    const jobB = runInTenant(b.tenantId, () => task({ agentRunId: runB.id }, JOB_HELPERS));
    // Settle both jobs' outcomes up front so neither rejection is ever unhandled while the test waits.
    const settledA = jobA.then(
      () => null,
      (err: unknown) => err,
    );
    const settledB = jobB.then(
      () => null,
      (err: unknown) => err,
    );
    await Promise.all([sessionA.started, sessionB.started]);

    await suspend(b);
    const errorB = await settledB;
    sessionA.openGate();
    const errorA = await settledA;

    expect(errorB).toBeInstanceOf(AgentRunCancelledError);
    expect(sessionB.returned()).toBe(true);
    expect(sessionB.signal()?.aborted).toBe(true);
    expect(await runStatus(b, runB.id)).toBe("error");
    expect(await errorNotificationCount(b, runB.id)).toBe(1);
    sessionB.openGate();
    expect(errorA).toBeNull();
    expect(await runStatus(a, runA.id)).toBe("done");
    expect(await errorNotificationCount(a, runA.id)).toBe(0);
    expect(inFlight.abortTenant(a.tenantId)).toBe(0);
    expect(inFlight.abortTenant(b.tenantId)).toBe(0);
  });

  it("aborts a suspended tenant's heartbeat agent run and unregisters it", async () => {
    const runB = await openRun(b);
    const sessionB = slowSession();
    sessionsByRunId.set(runB.id, sessionB.factory);
    listener = await startTenantDeactivationListener(listenerPool, async (tenantId) => {
      inFlight.abortTenant(tenantId);
    });
    const runAgent = createRunAgentForHeartbeats(agentsPool, moduleRegistry, gateway, inFlight);

    const job = runInTenant(b.tenantId, () =>
      runAgent({ agentRunId: runB.id, projectItemId: PROJECT_ITEM_ID, task: "work" }),
    );
    const settled = job.then(
      () => null,
      (err: unknown) => err,
    );
    await sessionB.started;
    await suspend(b);

    expect(await settled).toBeInstanceOf(AgentRunCancelledError);
    expect(sessionB.returned()).toBe(true);
    expect(sessionB.signal()?.aborted).toBe(true);
    expect(await terminalEvents(b, runB.id)).toEqual(["error"]);
    expect(inFlight.abortTenant(b.tenantId)).toBe(0);
    sessionB.openGate();
  });

  it.each(["job", "heartbeat"] as const)("cancels a %s deactivated before registration", async (kind) => {
    const run = await openRun(b);
    const createSession = vi.fn(slowSession().factory);
    sessionsByRunId.set(run.id, createSession);
    await suspend(b);
    // The notification found no registration. The post-registration read must catch this.
    expect(inFlight.abortTenant(b.tenantId)).toBe(0);
    const task = createAgentRunTask(agentsPool, moduleRegistry, gateway, inFlight);
    const heartbeat = createRunAgentForHeartbeats(agentsPool, moduleRegistry, gateway, inFlight);
    await expect(
      runInTenant(b.tenantId, () =>
        kind === "job"
          ? task({ agentRunId: run.id }, JOB_HELPERS)
          : heartbeat({ agentRunId: run.id, projectItemId: PROJECT_ITEM_ID, task: "work" }),
      ),
    ).rejects.toThrow(AgentRunCancelledError);
    expect(createSession).not.toHaveBeenCalled();
    expect(await terminalEvents(b, run.id)).toEqual(["error"]);
    if (kind === "job") {
      expect(await runStatus(b, run.id)).toBe("error");
      expect(await errorNotificationCount(b, run.id)).toBe(1);
    }
    expect(inFlight.abortTenant(b.tenantId)).toBe(0);
  });

  it.each(["job", "heartbeat"] as const)("cancels a %s deactivated during session composition", async (kind) => {
    const run = await openRun(b);
    const createSession = vi.fn(slowSession().factory);
    sessionsByRunId.set(run.id, createSession);
    let release!: () => void;
    compositionGates.set(
      run.id,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    let notified!: () => void;
    const deactivated = new Promise<void>((resolve) => {
      notified = resolve;
    });
    listener = await startTenantDeactivationListener(listenerPool, async (tenantId) => {
      inFlight.abortTenant(tenantId);
      if (tenantId === b.tenantId) notified();
    });
    const task = createAgentRunTask(agentsPool, moduleRegistry, gateway, inFlight);
    const heartbeat = createRunAgentForHeartbeats(agentsPool, moduleRegistry, gateway, inFlight);
    const result = runInTenant(b.tenantId, () =>
      kind === "job"
        ? task({ agentRunId: run.id }, JOB_HELPERS)
        : heartbeat({ agentRunId: run.id, projectItemId: PROJECT_ITEM_ID, task: "work" }),
    ).then(
      () => null,
      (err: unknown) => err,
    );
    try {
      await vi.waitFor(() => expect(composedRunIds).toEqual([run.id]));
      await suspend(b);
      await deactivated;
    } finally {
      release();
    }
    expect(await result).toBeInstanceOf(AgentRunCancelledError);
    expect(createSession).not.toHaveBeenCalled();
    expect(await terminalEvents(b, run.id)).toEqual(["error"]);
    if (kind === "job") {
      expect(await runStatus(b, run.id)).toBe("error");
      expect(await errorNotificationCount(b, run.id)).toBe(1);
    }
    expect(inFlight.abortTenant(b.tenantId)).toBe(0);
  });

  it("throws before composing a session when the job runs outside a tenant scope", async () => {
    const runB = await openRun(b);
    const task = createAgentRunTask(agentsPool, moduleRegistry, gateway, inFlight);

    await expect(task({ agentRunId: runB.id }, JOB_HELPERS)).rejects.toThrow("tenant scope");

    expect(composedRunIds).toEqual([]);
    expect(await runStatus(b, runB.id)).toBe("running");
  });

  it("throws before composing a session when the heartbeat run executes outside a tenant scope", async () => {
    const runB = await openRun(b);
    const runAgent = createRunAgentForHeartbeats(agentsPool, moduleRegistry, gateway, inFlight);

    await expect(runAgent({ agentRunId: runB.id, projectItemId: PROJECT_ITEM_ID, task: "work" })).rejects.toThrow(
      "tenant scope",
    );

    expect(composedRunIds).toEqual([]);
  });
});
