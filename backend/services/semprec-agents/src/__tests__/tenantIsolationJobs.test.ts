import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { escapeIdentifier, type Pool } from "pg";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { AGENT_TASK_NAMES, TASK_TENANCY, enqueueJob, runOnce, type TaskList, type TaskTenancy } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  CORE_AGENT_RUN_ACTION_ID,
  assertTaskListMatchesAffinity,
  createAgentRun,
  createAgentTaskList,
  createUser,
  loadFullModuleRegistry,
  mergeModuleTaskListForAffinity,
  provisionTenant,
  resolveTaskAffinitySets,
  withTransaction,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import { createAgentsActionRegistry } from "../actionRegistryComposition.js";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";
import { createAgentRunTask, createRunAgentForHeartbeats } from "../agentRunTasks.js";
import type { GatewayModel } from "../modelComposition.js";

/**
 * Two-tenant proof that every task of the `agents` affinity set keeps its data, notifications and
 * side effects inside the tenant it runs for (issue #1056). The task list is composed as
 * `createAgentsQueueRuntime` composes it, over the `semprec_data` pool semprec-agents runs on, with
 * the faux model the other agents tests use; jobs are enqueued with `enqueueJob` and drained with
 * `runOnce`, under strict tenant-scope enforcement.
 */

interface Tenant {
  tenantId: string;
  userId: string;
}

type Payload = Record<string, unknown>;

interface TenantTaskCase {
  tenancy: "tenant";
  /** Seeds `tenant`'s fixture rows and returns the job payload naming them. */
  seed(tenant: Tenant): Promise<Payload>;
  /** Asserts, inside `tenant`, the effect a completed job with `payload` had. */
  expectDone(tenant: Tenant, payload: Payload): Promise<void>;
}

type TaskCase = TenantTaskCase;

/** One table's share of a tenant fingerprint. */
interface TableFingerprint {
  count: number;
  md5: string;
}
type Fingerprint = Record<string, TableFingerprint>;

interface JobOutcome {
  /** `null` once the job completed and graphile-worker deleted its row. */
  attempts: number | null;
  lastError: string | null;
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

let previousScope: string | undefined;
let adminPool: Pool;
let pool: Pool;
let taskList: TaskList;
let affinitySet: ReadonlySet<string>;
let tenantTables: string[];
let faux: FauxProviderHandle;
let tenantA: Tenant;
let tenantB: Tenant;
let tenantZero: Tenant;

const moduleRegistry = await loadFullModuleRegistry();

async function buildTenant(tenantId: string): Promise<Tenant> {
  await provisionTenant(pool, tenantId);
  const user = await runAsSystem("test:create-user", () =>
    createUser(adminPool, { email: `${randomUUID()}@example.com`, passwordHash: "unused", tenantId }),
  );
  return { tenantId, userId: user.id };
}

/** Every table whose catalog comment classifies it as tenant data (partitions count with their parent). */
async function loadTenantTables(): Promise<string[]> {
  const { rows } = await adminPool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND obj_description(c.oid, 'pg_class') = 'semprec:tenancy=tenant'
      ORDER BY c.relname`,
  );
  return rows.map((row) => row.relname);
}

/** `tenant`'s fingerprint: per tenant table, read inside `runInTenant(tenant)`, its row count and an md5 over its ordered row texts. */
async function fingerprint(tenant: Tenant): Promise<Fingerprint> {
  return runInTenant(tenant.tenantId, () =>
    withTransaction(pool, async (client) => {
      const result: Fingerprint = {};
      for (const table of tenantTables) {
        const { rows } = await client.query<{ count: number; md5: string }>(
          `SELECT count(*)::int AS count, md5(COALESCE(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS md5
             FROM ${escapeIdentifier(table)} t`,
        );
        const row = rows[0];
        if (!row) throw new Error(`fingerprint: no aggregate row for ${table}`);
        result[table] = { count: row.count, md5: row.md5 };
      }
      return result;
    }),
  );
}

/** Ids of every notification visible inside `tenant`, with the user each is addressed to. */
async function notifications(tenant: Tenant): Promise<Map<string, string>> {
  return runInTenant(tenant.tenantId, async () => {
    const { rows } = await pool.query<{ id: string; user_id: string }>("SELECT id, user_id FROM notifications");
    return new Map(rows.map((row) => [row.id, row.user_id]));
  });
}

/** Asserts every notification `tenant` gained since `before` is addressed to `tenant`'s own user. */
async function expectNewNotificationsAddressedTo(tenant: Tenant, before: Map<string, string>): Promise<void> {
  const after = await notifications(tenant);
  const added = [...after].filter(([id]) => !before.has(id)).map(([, userId]) => userId);
  expect(added.filter((userId) => userId !== tenant.userId)).toEqual([]);
}

/** The job's final state, read through graphile-worker's public `jobs` view. */
async function jobOutcome(jobKey: string): Promise<JobOutcome> {
  const { rows } = await adminPool.query<{ attempts: number; last_error: string | null }>(
    "SELECT attempts, last_error FROM graphile_worker.jobs WHERE key = $1",
    [jobKey],
  );
  const row = rows[0];
  if (!row) return { attempts: null, lastError: null };
  return { attempts: row.attempts, lastError: row.last_error?.replace(UUID_PATTERN, "<id>") ?? null };
}

/** Removes a job a case left failed in the queue, so it cannot run again in a later case. */
async function removeJob(jobKey: string): Promise<void> {
  await adminPool.query("SELECT graphile_worker.remove_job($1)", [jobKey]);
}

/** Enqueues `name` inside `tenant` under a fresh job key, drains the queue once and returns the key. */
async function runJobIn(tenant: Tenant, name: string, payload: Payload): Promise<string> {
  const jobKey = randomUUID();
  await runInTenant(tenant.tenantId, () => enqueueJob(pool, name, payload, { jobKey }));
  await runOnce({ pgPool: pool, taskList });
  return jobKey;
}

/** `value` with every UUID inside it replaced by a fresh random one. */
function withRandomIds(value: unknown): unknown {
  if (typeof value === "string") return value.replace(UUID_PATTERN, () => randomUUID());
  if (Array.isArray(value)) return value.map(withRandomIds);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withRandomIds(entry)]));
  }
  return value;
}

function randomizedPayload(payload: Payload): Payload {
  const randomized = withRandomIds(payload);
  if (typeof randomized !== "object" || randomized === null || Array.isArray(randomized)) {
    throw new Error("withRandomIds: expected an object payload");
  }
  return Object.fromEntries(Object.entries(randomized));
}

function tenancyOf(name: string): TaskTenancy {
  return Object.hasOwn(TASK_TENANCY, name) ? TASK_TENANCY[name as keyof typeof TASK_TENANCY] : "tenant";
}

async function seededSemprecProjectItemId(tenant: Tenant): Promise<string> {
  return runInTenant(tenant.tenantId, async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE properties ->> 'name' = 'Semprec'");
    const row = rows[0];
    if (!row || rows.length !== 1) throw new Error("expected exactly one seeded Semprec project item");
    return row.id;
  });
}

async function runRow(tenant: Tenant, runId: string): Promise<{ status: string; result: string | null } | undefined> {
  return runInTenant(tenant.tenantId, async () => {
    const { rows } = await pool.query<{ status: string; result: string | null }>(
      "SELECT status, result FROM agent_runs WHERE id = $1",
      [runId],
    );
    return rows[0];
  });
}

function requirePayloadString(payload: Payload, field: string): string {
  const value = payload[field];
  if (typeof value !== "string") throw new Error(`expected payload field ${field} to be a string`);
  return value;
}

/** A user-triggered run on `tenant`'s seeded project, answered by the faux model with `reply`. */
function agentRunCase(reply: string): TenantTaskCase {
  return {
    tenancy: "tenant",
    async seed(tenant) {
      const projectItemId = await seededSemprecProjectItemId(tenant);
      const run = await runInTenant(tenant.tenantId, () =>
        createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" }),
      );
      faux.setResponses([fauxAssistantMessage(reply)]);
      return { agentRunId: run.id };
    },
    async expectDone(tenant, payload) {
      expect(await runRow(tenant, requirePayloadString(payload, "agentRunId"))).toEqual({
        status: "done",
        result: reply,
      });
    },
  };
}

const cases: Record<string, TaskCase> = {
  [AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT]: {
    tenancy: "tenant",
    async seed(tenant) {
      const heartbeatId = await runInTenant(tenant.tenantId, async () => {
        const { rows } = await pool.query<{ id: string; project_item_id: string }>(
          "SELECT id, project_item_id FROM project_heartbeats WHERE action_id = $1",
          [CORE_AGENT_RUN_ACTION_ID],
        );
        const row = rows[0];
        if (!row || rows.length !== 1) throw new Error("expected exactly one seeded core.agentRun heartbeat");
        return row.id;
      });
      const projectItemId = await seededSemprecProjectItemId(tenant);
      // A manual (`triggeredByRunId`) fire skips the seeded rule's item-relation filter.
      const parentRun = await runInTenant(tenant.tenantId, () =>
        createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "trigger the heartbeat" }),
      );
      faux.setResponses([fauxAssistantMessage("Heartbeat handled.")]);
      return { heartbeatId, triggeredByRunId: parentRun.id };
    },
    async expectDone(tenant, payload) {
      const runs = await runInTenant(tenant.tenantId, async () => {
        const { rows } = await pool.query<{ status: string; result: string | null }>(
          "SELECT status, result FROM agent_runs WHERE heartbeat_id = $1",
          [requirePayloadString(payload, "heartbeatId")],
        );
        return rows;
      });
      expect(runs).toEqual([{ status: "done", result: "Heartbeat handled." }]);
    },
  },
  [AGENT_TASK_NAMES.AGENT_RUN]: agentRunCase("Hello from the agent."),
  [AGENT_TASK_NAMES.DELEGATED_AGENT_RUN]: agentRunCase("Hello from the delegated agent."),
};

describe("background task isolation across two tenants: agents runtime (issue #1056)", () => {
  beforeAll(async () => {
    previousScope = process.env.SEMPREC_TENANT_SCOPE;
    process.env.SEMPREC_TENANT_SCOPE = "strict";

    adminPool = getTestPool();
    await resetDatabase(adminPool);
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
    tenantTables = await loadTenantTables();

    faux = fauxProvider();
    const streamFn: StreamFn = (model, context, options) => faux.provider.streamSimple(model, context, options);
    const gateway: GatewayModel = { model: faux.getModel(), streamFn };

    // Composed as createAgentsQueueRuntime composes it, with serve.ts's session wiring.
    const actionRegistry = createAgentsActionRegistry(
      pool,
      createRunAgentForHeartbeats(pool, moduleRegistry, gateway, createInFlightAgentRuns()),
    );
    const coreTaskList = createAgentTaskList(
      pool,
      actionRegistry,
      moduleRegistry,
      createAgentRunTask(pool, moduleRegistry, gateway, createInFlightAgentRuns()),
      createAgentRunTask(pool, moduleRegistry, gateway, createInFlightAgentRuns()),
    );
    taskList = await mergeModuleTaskListForAffinity(coreTaskList, moduleRegistry, "agents");
    affinitySet = (await resolveTaskAffinitySets(moduleRegistry)).agents;
    assertTaskListMatchesAffinity(taskList, affinitySet, "agents");

    tenantZero = await buildTenant(getTenantZeroId());
    tenantA = await buildTenant(await createTestTenant(adminPool));
    tenantB = await buildTenant(await createTestTenant(adminPool));
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
    if (previousScope === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
    else process.env.SEMPREC_TENANT_SCOPE = previousScope;
  });

  it("has exactly one case per task of the agents affinity set", async () => {
    const set = (await resolveTaskAffinitySets(await loadFullModuleRegistry())).agents;
    const withoutCase = [...set].filter((name) => !Object.hasOwn(cases, name)).sort();
    const outsideSet = Object.keys(cases)
      .filter((name) => !set.has(name))
      .sort();
    expect({ withoutCase, outsideSet }).toEqual({ withoutCase: [], outsideSet: [] });
  });

  it.each(Object.keys(cases))("%s: its case matches the task's declared tenancy", (name) => {
    expect(cases[name]?.tenancy).toBe(tenancyOf(name));
  });

  describe("tenant tasks", () => {
    const tenantCases = Object.entries(cases);

    it.each(tenantCases)(
      "%s (a): a job of A naming A's rows completes and changes nothing of B or tenant zero",
      async (name, c) => {
        const payload = await c.seed(tenantA);
        const beforeB = await fingerprint(tenantB);
        const beforeZero = await fingerprint(tenantZero);
        const notificationsBefore = await notifications(tenantA);

        const jobKey = await runJobIn(tenantA, name, payload);

        expect(await jobOutcome(jobKey)).toEqual({ attempts: null, lastError: null });
        await c.expectDone(tenantA, payload);
        expect(await fingerprint(tenantB)).toEqual(beforeB);
        expect(await fingerprint(tenantZero)).toEqual(beforeZero);
        await expectNewNotificationsAddressedTo(tenantA, notificationsBefore);
      },
    );

    it.each(tenantCases)(
      "%s (b): a job of B naming A's rows ends like one naming random ids and leaves A unchanged",
      async (name, c) => {
        const payload = await c.seed(tenantA);
        const beforeA = await fingerprint(tenantA);

        const foreignKey = await runJobIn(tenantB, name, payload);
        const foreign = await jobOutcome(foreignKey);
        const randomKey = await runJobIn(tenantB, name, randomizedPayload(payload));
        const random = await jobOutcome(randomKey);
        await removeJob(foreignKey);
        await removeJob(randomKey);

        expect(foreign).toEqual(random);
        expect(await fingerprint(tenantA)).toEqual(beforeA);
      },
    );
  });
});
