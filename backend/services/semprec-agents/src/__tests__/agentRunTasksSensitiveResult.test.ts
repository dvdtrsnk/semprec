import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { AgentMessage, AgentSession, CreateAgentSession } from "@semprec/agent-runtime";
import { createAgentRun, createUser, loadFullModuleRegistry } from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import type { ModuleRegistry } from "@semprec/module-registry";
import { runInTenant } from "@semprec/shared";
import { createAgentRunTask, createRunAgentForHeartbeats } from "../agentRunTasks.js";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";
import type { GatewayModel } from "../modelComposition.js";

const PROJECT_ITEM_ID = "00000000-0000-4000-8000-0000000000f1";
const JOB_HELPERS = { job: { id: "1" } };
const MARKER = "[redacted: sensitive]";
const QUOTED_VALUE = "Quoted diagnosis";
const sessionsByRunId = new Map<string, CreateAgentSession>();

// The session composition needs a gateway and tool wiring that this result path does not exercise: the factory
// is replaced with one that hands out the test's own fake session per run.
vi.mock("../agentSessionComposition.js", () => ({
  createAgentSessionFactoryForRun: (
    _pool: Pool,
    _registry: ModuleRegistry,
    _gateway: GatewayModel,
    run: { id: string },
  ) => {
    const factory = sessionsByRunId.get(run.id);
    if (!factory) throw new Error(`no fake session for run ${run.id}`);
    return Promise.resolve(factory);
  },
}));

/** A turn that reads a sensitive item (the tool marks its answer, issue #1827) and then quotes it in its reply. */
function quotingSession(read: boolean): CreateAgentSession {
  const messages: AgentMessage[] = [
    { kind: "turn_start" },
    ...(read
      ? ([
          { kind: "tool_use", toolCallId: "call-1", name: "item_get", operation: "item.get", arguments: {} },
          {
            kind: "tool_result",
            toolCallId: "call-1",
            name: "item_get",
            operation: "item.get",
            result: { content: [{ type: "text", text: QUOTED_VALUE }], details: { error: false, sensitive: true } },
            isError: false,
          },
        ] satisfies AgentMessage[])
      : []),
    { kind: "message", role: "assistant", text: `The record says ${QUOTED_VALUE}` },
    { kind: "turn_end" },
  ];
  return (): AgentSession => ({
    async *messages() {
      yield* messages;
    },
  });
}

describe("the result of a queued or heartbeat agent run after a sensitive read (issue #2001)", () => {
  let adminPool: Pool;
  let agentsPool: Pool;
  let moduleRegistry: ModuleRegistry;
  let tenantId: string;
  let userId: string;
  const gateway = {} as GatewayModel;

  beforeAll(async () => {
    adminPool = getTestPool();
    agentsPool = await createRuntimeRolePool(adminPool, "semprec_data");
    moduleRegistry = await loadFullModuleRegistry();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    sessionsByRunId.clear();
    tenantId = await createTestTenant(adminPool);
    userId = (
      await createUser(adminPool, {
        email: `member-${tenantId}@example.test`,
        passwordHash: "unused",
        tenantId,
        role: "member",
      })
    ).id;
  });

  afterAll(async () => {
    await agentsPool?.end();
  });

  function openRun() {
    return runInTenant(tenantId, () => createAgentRun(agentsPool, { triggeredBy: "user", task: "work", userId }));
  }

  async function storedResult(runId: string): Promise<string | null> {
    return runInTenant(tenantId, async () => {
      const { rows } = await agentsPool.query<{ result: string | null }>(
        "SELECT result FROM agent_runs WHERE id = $1",
        [runId],
      );
      return rows[0]!.result;
    });
  }

  it.each([
    [true, MARKER],
    [false, `The record says ${QUOTED_VALUE}`],
  ])("closes a queued run whose turn read a sensitive item = %s with %j as its result", async (read, expected) => {
    const run = await openRun();
    sessionsByRunId.set(run.id, quotingSession(read));
    const task = createAgentRunTask(agentsPool, moduleRegistry, gateway, createInFlightAgentRuns());
    await runInTenant(tenantId, () => task({ agentRunId: run.id }, JOB_HELPERS));
    expect(await storedResult(run.id)).toBe(expected);
  });

  it.each([
    [true, MARKER],
    [false, `The record says ${QUOTED_VALUE}`],
  ])("hands a heartbeat run whose turn read a sensitive item = %s the result %j", async (read, expected) => {
    const run = await openRun();
    sessionsByRunId.set(run.id, quotingSession(read));
    const heartbeat = createRunAgentForHeartbeats(agentsPool, moduleRegistry, gateway, createInFlightAgentRuns());
    const outcome = await runInTenant(tenantId, () =>
      heartbeat({ agentRunId: run.id, projectItemId: PROJECT_ITEM_ID, task: "work" }),
    );
    expect(outcome).toEqual({ result: expected });
  });
});
