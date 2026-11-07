import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createAgentRun, finishAgentRun } from "../agentRuns/agentRunsStore.js";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { CORE_AGENT_RUN_ACTION_ID } from "../scheduler/actions.js";
import { createHeartbeat, setHeartbeatEnabled } from "../scheduler/schedulerStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getOrCreateTickThread } from "../semp/sempTickThreadStore.js";
import { createSempChatThread, getSempThread } from "../sempThreads/sempThreadsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const WEEKLY = { kind: "weekly", days: ["sun"], at: "21:00" } as const;

let adminPool: Pool;
let pool: Pool;

describe("tick thread header and active run on the thread detail (issue #1562)", () => {
  let tenant: string;
  let projectsId: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenant = await createTestTenant(adminPool);
    // A run records its tenant's user as the actor, so the tenant needs one.
    await createUser(adminPool, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    projectsId = await runInTenant(tenant, async () => {
      const projects = await withTransaction(pool, (client) =>
        databasesStore.getDatabaseByModuleId(client, "projects"),
      );
      if (!projects) throw new Error("Projects was not seeded");
      return projects.id;
    });
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  /** A project, its heartbeat and the heartbeat's tick thread, all through their production writers. */
  async function tickThread(rule: unknown, options: { enabled?: boolean } = {}) {
    return runInTenant(tenant, async () => {
      const project = await createChokePoint(pool).createItem({
        databaseId: projectsId,
        properties: { name: "Weekly review" },
      });
      return withTransaction(pool, async (client) => {
        const heartbeat = await createHeartbeat(client, {
          projectItemId: project.id,
          name: "Sunday planning",
          rule,
          actionId: CORE_AGENT_RUN_ACTION_ID,
          actionConfig: { task: "Plan the week" },
          ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
        });
        const thread = await getOrCreateTickThread(client, heartbeat.id);
        return { project, heartbeat, threadId: thread.id };
      });
    });
  }

  function detail(threadId: string) {
    return runInTenant(tenant, () => withTransaction(pool, (client) => getSempThread(client, threadId)));
  }

  it("returns the header of a weekly heartbeat with its structured rule, and no active run", async () => {
    const { project, heartbeat, threadId } = await tickThread(WEEKLY);
    const thread = await detail(threadId);
    expect(thread).toMatchObject({ id: threadId, kind: "tick", subject: null });
    expect(thread?.heartbeat).toEqual({
      id: heartbeat.id,
      name: "Sunday planning",
      rule: WEEKLY,
      enabled: true,
      projectItemId: project.id,
      projectName: "Weekly review",
      canTrigger: true,
    });
    expect(thread?.activeRun).toBeNull();
  });

  it("reports canTrigger false for a disabled heartbeat", async () => {
    const { heartbeat, threadId } = await tickThread(WEEKLY);
    await runInTenant(tenant, () =>
      withTransaction(pool, (client) => setHeartbeatEnabled(client, heartbeat.id, false)),
    );
    expect((await detail(threadId))?.heartbeat).toMatchObject({ enabled: false, canTrigger: false });
  });

  it("reports canTrigger false for an onItemEvent rule", async () => {
    const tasksId = await runInTenant(tenant, async () => {
      const tasks = await withTransaction(pool, (client) => databasesStore.getDatabaseByModuleId(client, "tasks"));
      return tasks!.id;
    });
    const rule = { kind: "onItemEvent", databaseId: tasksId, event: "create" };
    const { threadId } = await tickThread(rule);
    expect((await detail(threadId))?.heartbeat).toMatchObject({ rule, enabled: true, canTrigger: false });
  });

  it("carries the running run of the thread while it runs, and null once it finished", async () => {
    const { project, heartbeat, threadId } = await tickThread(WEEKLY);
    const run = await runInTenant(tenant, () =>
      createAgentRun(pool, {
        projectItemId: project.id,
        heartbeatId: heartbeat.id,
        threadId,
        triggeredBy: "heartbeat",
        task: "Plan the week",
      }),
    );
    const { rows } = await adminPool.query<{ started_at: Date }>("SELECT started_at FROM agent_runs WHERE id = $1", [
      run.id,
    ]);
    expect((await detail(threadId))?.activeRun).toEqual({
      agentRunId: run.id,
      startedAt: rows[0]!.started_at.toISOString(),
    });

    await runInTenant(tenant, () => finishAgentRun(pool, run.id, "done", "Planned"));
    expect((await detail(threadId))?.activeRun).toBeNull();
  });

  it("does not count a running run of another thread", async () => {
    const first = await tickThread(WEEKLY);
    const second = await tickThread({ kind: "dailyTime", at: "07:00" });
    await runInTenant(tenant, () =>
      createAgentRun(pool, {
        projectItemId: second.project.id,
        heartbeatId: second.heartbeat.id,
        threadId: second.threadId,
        triggeredBy: "heartbeat",
        task: "Other",
      }),
    );
    expect((await detail(first.threadId))?.activeRun).toBeNull();
    expect((await detail(second.threadId))?.activeRun).not.toBeNull();
  });

  it("keeps the header and reports no project name once the project is trashed", async () => {
    const { project, threadId } = await tickThread(WEEKLY);
    await runInTenant(tenant, () => createChokePoint(pool).softDeleteItem(projectsId, project.id));
    expect((await detail(threadId))?.heartbeat).toMatchObject({ projectItemId: project.id, projectName: null });
  });

  it("gives a chat thread neither a heartbeat nor an activeRun key", async () => {
    const threadId = await runInTenant(tenant, () => withTransaction(pool, (client) => createSempChatThread(client)));
    const thread = await detail(threadId);
    expect(thread?.kind).toBe("chat");
    expect(Object.hasOwn(thread ?? {}, "heartbeat")).toBe(false);
    expect(Object.hasOwn(thread ?? {}, "activeRun")).toBe(false);
  });

  it("does not show a tick thread to another tenant", async () => {
    const { threadId } = await tickThread(WEEKLY);
    const other = await createTestTenant(adminPool);
    const seen = await runInTenant(other, () => withTransaction(pool, (client) => getSempThread(client, threadId)));
    expect(seen).toBeNull();
  });
});
