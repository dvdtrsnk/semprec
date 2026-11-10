import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import { runInTenant } from "@semprec/shared";
import { createAgentRun, finishAgentRun } from "../agentRuns/agentRunsStore.js";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { CORE_AGENT_RUN_ACTION_ID } from "../scheduler/actions.js";
import type { HeartbeatRuleKindRegistry } from "../scheduler/rule.js";
import { createHeartbeat, setHeartbeatEnabled } from "../scheduler/schedulerStore.js";
import { resolveModuleRuleKinds } from "../scheduler/sweep.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getOrCreateTickThread } from "../semp/sempTickThreadStore.js";
import { createSempChatThread, getSempThread } from "../sempThreads/sempThreadsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const WEEKLY = { kind: "weekly", days: ["sun"], at: "21:00" } as const;
/** No module rule kind registered: only core rules validate. */
const CORE_RULES_ONLY: HeartbeatRuleKindRegistry = new Map();

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
  async function tickThread(
    rule: unknown,
    options: { enabled?: boolean } = {},
    moduleRuleKinds: HeartbeatRuleKindRegistry = CORE_RULES_ONLY,
  ) {
    return runInTenant(tenant, async () => {
      const project = await createChokePoint(pool).createItem({
        databaseId: projectsId,
        properties: { name: "Weekly review" },
      });
      return withTransaction(pool, async (client) => {
        const heartbeat = await createHeartbeat(
          client,
          {
            projectItemId: project.id,
            name: "Sunday planning",
            rule,
            actionId: CORE_AGENT_RUN_ACTION_ID,
            actionConfig: { task: "Plan the week" },
            ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
          },
          moduleRuleKinds,
        );
        const thread = await getOrCreateTickThread(client, heartbeat.id);
        return { project, heartbeat, threadId: thread.id };
      });
    });
  }

  function detail(threadId: string, moduleRuleKinds: HeartbeatRuleKindRegistry = CORE_RULES_ONLY) {
    return runInTenant(tenant, () =>
      withTransaction(pool, (client) => getSempThread(client, threadId, moduleRuleKinds)),
    );
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

  it("validates a module-declared rule kind against the active modules: shown while active, refused once inactive or unknown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "semprec-tick-rule-"));
    try {
      // A module declaring its own heartbeat rule kind, loaded through the real module registry.
      const modulePath = join(directory, "rule.mjs");
      await writeFile(
        modulePath,
        `export const manifest = { id: 'fixtureRule', version: '1.0.0', name: 'Fixture Rule', removable: true, systemProject: false, databases: [], capabilities: [], agentTools: [], heartbeatRuleKinds: [{ kind: 'fixtureRule.once', schemaExport: 'ruleSchema', nextFireAtExport: 'nextFireAt' }] };\nexport const ruleSchema = { safeParse: (value) => ({ success: true, data: value }) };\nexport function nextFireAt() { return new Date('2031-01-01T00:00:00.000Z'); }\n`,
      );
      const active = new Set(["fixtureRule"]);
      const registry = new ModuleRegistry(() => active);
      await registry.loadModule(pathToFileURL(modulePath).href);
      const rule = { kind: "fixtureRule.once", at: "2031-01-01" };
      const { heartbeat, threadId } = await tickThread(rule, {}, await resolveModuleRuleKinds(registry));

      expect((await detail(threadId, await resolveModuleRuleKinds(registry)))?.heartbeat).toMatchObject({
        id: heartbeat.id,
        rule,
        canTrigger: true,
      });
      await expect(detail(threadId, CORE_RULES_ONLY)).rejects.toThrow(/Unknown heartbeat rule kind "fixtureRule.once"/);
      active.delete("fixtureRule");
      await expect(detail(threadId, await resolveModuleRuleKinds(registry))).rejects.toThrow(
        /Unknown heartbeat rule kind "fixtureRule.once"/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
    const seen = await runInTenant(other, () =>
      withTransaction(pool, (client) => getSempThread(client, threadId, CORE_RULES_ONLY)),
    );
    expect(seen).toBeNull();
  });
});
