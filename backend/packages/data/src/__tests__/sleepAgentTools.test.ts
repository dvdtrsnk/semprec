import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { resolveModuleAgentToolsForRun, type ResolvedModuleAgentTool } from "../agentTools/moduleAgentTools.js";
import { createUser } from "../auth/usersStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { registerItemCreateHook, registerItemUpdateHook } from "../chokePoint/hooks.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import {
  createSleepNightSetTool,
  createSleepNightsGetTool,
  sleepNightSetArgsSchema,
  sleepNightsGetArgsSchema,
} from "../sleep/sleepAgentTools.js";
import { sleepNightPut, sleepNightsGet } from "../sleep/sleepRouteHandlers.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";

// A seeded tenant has the settings item (enabled, prepReminder 30 minutes before bed) and two plans: wake days mon to
// fri from 23:00 to 06:45 with the alarm, and sat and sun from 00:00 to 08:30 without it. Its time zone is
// Europe/Prague, which is at +02:00 on the dates below. 2026-10-16 is a Friday, so its night is a weekend night.
// The sleep databases are owned by the system project "Sleep", so a run of that project holds the sleep
// capabilities; the user's grants on the sensitive databases (issue gh-1810) decide what its calls may do.

const NIGHT = "2026-10-16";
const USER = { writerKind: "user" } as const;

const nightSchema = z
  .object({
    night: z.string(),
    planId: z.string().nullable(),
    planName: z.string().nullable(),
    bedTime: z.string(),
    wakeTime: z.string(),
    alarm: z.boolean(),
    changed: z.boolean(),
    bedAt: z.string(),
    wakeAt: z.string(),
    durationMinutes: z.number(),
    prepReminderAt: z.string().nullable(),
  })
  .strict();
const setResultSchema = z.object({ night: nightSchema.nullable() }).strict();
const refusalSchema = z.object({
  status: z.number(),
  error: z.string(),
  message: z.string(),
  field: z.string().optional(),
});
const nightsResultSchema = z.object({ nights: z.array(nightSchema) }).passthrough();

interface SleepTenant {
  tenantId: string;
  userId: string;
  settingsDatabaseId: string;
  plansDatabaseId: string;
  nightsDatabaseId: string;
  /** The system project "Sleep", the owner of the three sleep databases. */
  sleepProjectId: string;
  weekendPlanId: string;
}

interface PlanRow {
  id: string;
  properties: Record<string, unknown>;
  updated_at: string;
}

let adminPool: Pool;
let dataPool: Pool;
let tenant: SleepTenant;
let other: SleepTenant;
let registry: Awaited<ReturnType<typeof loadFullModuleRegistry>>;

const createdBy: WriterIdentity[] = [];
const updatedBy: WriterIdentity[] = [];

// Hooks cannot be unregistered; these recorders stay registered for this file's process only and are emptied before
// each test. They record the writer of a write to the sleep nights database.
registerItemCreateHook(async ({ database, writer }) => {
  if (database.ownerModuleId === SLEEP_NIGHTS_MODULE_ID) createdBy.push(writer);
});
registerItemUpdateHook(async ({ database, writer }) => {
  if (database.ownerModuleId === SLEEP_NIGHTS_MODULE_ID) updatedBy.push(writer);
});

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

async function seededTenant(): Promise<SleepTenant> {
  const tenantId = await createTestTenant(adminPool);
  const user = await createUser(adminPool, {
    tenantId,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    locale: "en",
  });
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  const database = async (moduleId: string) => {
    const found = await inTenant(tenantId, (client) => databasesStore.getDatabaseByModuleId(client, moduleId));
    if (!found) throw new Error(`The tenant has no ${moduleId} database`);
    return found;
  };
  const settings = await database(SLEEP_SETTINGS_MODULE_ID);
  const plans = await database(SLEEP_PLANS_MODULE_ID);
  const nights = await database(SLEEP_NIGHTS_MODULE_ID);
  if (!nights.ownerProjectItemId) throw new Error("The sleep databases have no owner project");
  const planRows = await inTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ id: string; properties: { wakeDays: string[] } }>(
      "SELECT id, properties FROM items WHERE database_id = $1 AND deleted_at IS NULL",
      [plans.id],
    );
    return rows;
  });
  const weekend = planRows.find((row) => row.properties.wakeDays.includes("sat"));
  if (!weekend) throw new Error("No seeded plan wakes on sat");
  return {
    tenantId,
    userId: user.id,
    settingsDatabaseId: settings.id,
    plansDatabaseId: plans.id,
    nightsDatabaseId: nights.id,
    sleepProjectId: nights.ownerProjectItemId,
    weekendPlanId: weekend.id,
  };
}

/** Stores the user's decision of `access` for the Sleep project on the given databases (default: all three). */
async function grant(
  t: SleepTenant,
  access: "none" | "read" | "write",
  databaseIds: readonly string[] = [t.settingsDatabaseId, t.plansDatabaseId, t.nightsDatabaseId],
): Promise<void> {
  await inTenant(t.tenantId, async (client) => {
    for (const databaseId of databaseIds) {
      await setAgentDatabaseGrant(client, { projectItemId: t.sleepProjectId, databaseId, access });
    }
  });
}

async function grantAll(t: SleepTenant): Promise<void> {
  await grant(t, "read", [t.settingsDatabaseId, t.plansDatabaseId]);
  await grant(t, "write", [t.nightsDatabaseId]);
}

function runOf(t: SleepTenant, projectItemId: string = t.sleepProjectId) {
  return runInTenant(t.tenantId, () =>
    createAgentRun(dataPool, { projectItemId, userId: t.userId, triggeredBy: "user", task: "sleep" }),
  );
}

/**
 * Takes the sleep module away from the tenant: the Sleep project item and the run stay, but no system database belongs
 * to the sleep module any more.
 */
async function removeSleepModule(t: SleepTenant): Promise<void> {
  await adminPool.query("UPDATE databases SET owner_module_id = 'removed-' || owner_module_id WHERE id = ANY($1)", [
    [t.settingsDatabaseId, t.plansDatabaseId, t.nightsDatabaseId],
  ]);
}

/** The sleep tools composed for the run of the project, as a session composes them. */
function toolsFor(
  t: SleepTenant,
  runId: string,
  projectItemId: string = t.sleepProjectId,
  effectiveCapabilities?: ReadonlySet<string>,
): Promise<ResolvedModuleAgentTool[]> {
  return runInTenant(t.tenantId, () =>
    resolveModuleAgentToolsForRun(dataPool, registry, runId, projectItemId, effectiveCapabilities),
  );
}

async function toolNamed(t: SleepTenant, runId: string, name: string): Promise<ResolvedModuleAgentTool> {
  const tool = (await toolsFor(t, runId)).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`The run has no tool ${name}`);
  return tool;
}

function call(t: SleepTenant, tool: ResolvedModuleAgentTool, args: unknown) {
  return runInTenant(t.tenantId, () => tool.invoke(args));
}

interface Exception {
  id: string;
  properties: Record<string, unknown>;
  deleted_at: string | null;
}

function exceptionsOf(t: SleepTenant, night: string): Promise<Exception[]> {
  return inTenant(t.tenantId, async (client) => {
    const { rows } = await client.query<Exception>(
      `SELECT id, properties, deleted_at::text AS deleted_at FROM items
        WHERE database_id = $1 AND properties ->> 'night' = $2 ORDER BY id`,
      [t.nightsDatabaseId, night],
    );
    return rows;
  });
}

function plansOf(t: SleepTenant): Promise<PlanRow[]> {
  return inTenant(t.tenantId, async (client) => {
    const { rows } = await client.query<PlanRow>(
      "SELECT id, properties, updated_at::text AS updated_at FROM items WHERE database_id = $1 ORDER BY id",
      [t.plansDatabaseId],
    );
    return rows;
  });
}

/** The keys of the pending `sleep.resync` jobs, read through the public view of the queue schema. */
async function resyncKeys(): Promise<string[]> {
  const { rows } = await adminPool.query<{ key: string }>(
    "SELECT key FROM graphile_worker.jobs WHERE task_identifier = 'sleep.resync' ORDER BY key",
  );
  return rows.map((row) => row.key);
}

async function clearResyncJobs(): Promise<void> {
  for (const key of await resyncKeys()) await adminPool.query("SELECT graphile_worker.remove_job($1)", [key]);
}

describe("the sleep agent tools (issue gh-1840)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    registry = await loadFullModuleRegistry();
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenant = await seededTenant();
    other = await seededTenant();
    await clearResyncJobs();
    createdBy.length = 0;
    updatedBy.length = 0;
  });

  describe("composition", () => {
    it("lists both tools for a run of the project that owns the sleep databases and classifies them", async () => {
      await grantAll(tenant);
      const run = await runOf(tenant);

      const tools = (await toolsFor(tenant, run.id)).filter((tool) => tool.name.startsWith("sleepNight"));

      expect(tools.map((tool) => tool.name).sort()).toEqual(["sleepNightSet", "sleepNightsGet"]);
      expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.requiresApproval]))).toEqual({
        sleepNightSet: false,
        sleepNightsGet: false,
      });
      expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.riskClass]))).toEqual({
        sleepNightSet: "write",
        sleepNightsGet: "read",
      });
    });

    it("lists the tools also without a grant: the grant decides the call, not the presence", async () => {
      const run = await runOf(tenant);

      const names = (await toolsFor(tenant, run.id)).map((tool) => tool.name);

      expect(names).toEqual(expect.arrayContaining(["sleepNightSet", "sleepNightsGet"]));
    });

    it("leaves out both tools for a run of a project that does not own the sleep databases", async () => {
      await grantAll(tenant);
      const projects = await inTenant(tenant.tenantId, (client) =>
        databasesStore.getDatabaseByModuleId(client, "inbox"),
      );
      if (!projects?.ownerProjectItemId) throw new Error("Missing Semprec project");
      const semprecProjectId = projects.ownerProjectItemId;
      const run = await runOf(tenant, semprecProjectId);

      const names = (await toolsFor(tenant, run.id, semprecProjectId)).map((tool) => tool.name);

      expect(names).not.toContain("sleepNightSet");
      expect(names).not.toContain("sleepNightsGet");
    });

    it("leaves out the write tool without sleep.write and the read tool without sleep.read", async () => {
      const run = await runOf(tenant);

      const readOnly = await toolsFor(tenant, run.id, tenant.sleepProjectId, new Set(["sleep.read"]));
      const writeOnly = await toolsFor(tenant, run.id, tenant.sleepProjectId, new Set(["sleep.write"]));
      const neither = await toolsFor(tenant, run.id, tenant.sleepProjectId, new Set());

      const sleepNames = (tools: ResolvedModuleAgentTool[]) =>
        tools.map((tool) => tool.name).filter((name) => name.startsWith("sleepNight"));
      expect(sleepNames(readOnly)).toEqual(["sleepNightsGet"]);
      expect(sleepNames(writeOnly)).toEqual(["sleepNightSet"]);
      expect(sleepNames(neither)).toEqual([]);
    });

    it("declares argument schemas that refuse an unknown key and a wrongly typed value", async () => {
      const run = await runOf(tenant);
      const set = await toolNamed(tenant, run.id, "sleepNightSet");
      const get = await toolNamed(tenant, run.id, "sleepNightsGet");

      expect(set.acceptsArguments({ night: NIGHT, wakeTime: "07:00", alarm: true })).toBe(true);
      expect(set.acceptsArguments({ night: NIGHT, wakeTime: null, alarm: null })).toBe(true);
      expect(set.acceptsArguments({ night: NIGHT, extra: 1 })).toBe(false);
      expect(set.acceptsArguments({ night: NIGHT, alarm: "yes" })).toBe(false);
      expect(set.acceptsArguments({ wakeTime: "07:00" })).toBe(false);
      expect(get.acceptsArguments({ from: NIGHT, to: NIGHT })).toBe(true);
      expect(get.acceptsArguments({ from: NIGHT })).toBe(false);
      expect(get.acceptsArguments({ from: NIGHT, to: NIGHT, limit: 1 })).toBe(false);
      await expect(call(tenant, set, { night: NIGHT, extra: 1 })).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("sleepNightSet", () => {
    it("with the grants sets the night from 00:00 to 07:00 with an alarm, leaves the weekend plan, and enqueues the resync job", async () => {
      await grantAll(tenant);
      const run = await runOf(tenant);
      const plansBefore = await plansOf(tenant);
      const set = await toolNamed(tenant, run.id, "sleepNightSet");

      const answer = await call(tenant, set, { night: NIGHT, wakeTime: "07:00", alarm: true });

      expect(answer.error).toBe(false);
      expect(answer.sensitive).toBe(true);
      const resolved = setResultSchema.parse(JSON.parse(answer.result)).night;
      expect(resolved).toMatchObject({
        night: NIGHT,
        planId: tenant.weekendPlanId,
        bedTime: "00:00",
        wakeTime: "07:00",
        alarm: true,
        changed: true,
        bedAt: "2026-10-17T00:00:00+02:00",
        wakeAt: "2026-10-17T07:00:00+02:00",
        durationMinutes: 420,
      });
      const stored = await exceptionsOf(tenant, NIGHT);
      expect(stored.map((row) => [row.properties, row.deleted_at])).toEqual([
        [{ night: NIGHT, wakeTime: "07:00", alarm: true }, null],
      ]);
      expect(await plansOf(tenant)).toEqual(plansBefore);
      expect(await resyncKeys()).toEqual([`sleep-resync:${tenant.tenantId}`]);
      const approvals = await adminPool.query("SELECT 1 FROM approval_requests WHERE tenant_id = $1", [
        tenant.tenantId,
      ]);
      expect(approvals.rowCount).toBe(0);
    });

    it("writes as the agent of the run and its project, acting for the run's user", async () => {
      await grantAll(tenant);
      const run = await runOf(tenant);
      const set = await toolNamed(tenant, run.id, "sleepNightSet");

      await call(tenant, set, { night: NIGHT, wakeTime: "07:00" });
      await call(tenant, set, { night: NIGHT, wakeTime: "07:30" });

      const expected: WriterIdentity = {
        writerKind: "agent",
        agentRunId: run.id,
        agentProjectItemId: tenant.sleepProjectId,
        onBehalfOfUserId: tenant.userId,
      };
      expect(createdBy).toEqual([expected]);
      expect(updatedBy).toEqual([expected]);
    });

    it("patches only the differing fields of an existing exception and keeps the others", async () => {
      await grantAll(tenant);
      const run = await runOf(tenant);
      const set = await toolNamed(tenant, run.id, "sleepNightSet");
      await call(tenant, set, { night: NIGHT, wakeTime: "07:00", alarm: true });

      const answer = await call(tenant, set, { night: NIGHT, bedTime: "23:30" });

      expect(setResultSchema.parse(JSON.parse(answer.result)).night).toMatchObject({
        bedTime: "23:30",
        wakeTime: "07:00",
        alarm: true,
      });
      const stored = await exceptionsOf(tenant, NIGHT);
      expect(stored.map((row) => row.properties)).toEqual([
        { night: NIGHT, bedTime: "23:30", wakeTime: "07:00", alarm: true },
      ]);
    });

    it("never deletes: null follows the plan again and the exception stays with that field null", async () => {
      await grantAll(tenant);
      const run = await runOf(tenant);
      const set = await toolNamed(tenant, run.id, "sleepNightSet");
      await call(tenant, set, { night: NIGHT, wakeTime: "07:00", alarm: true });

      const answer = await call(tenant, set, { night: NIGHT, wakeTime: null, alarm: null });

      expect(setResultSchema.parse(JSON.parse(answer.result)).night).toMatchObject({
        wakeTime: "08:30",
        alarm: false,
        changed: false,
      });
      const stored = await exceptionsOf(tenant, NIGHT);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.deleted_at).toBeNull();
      expect(stored[0]?.properties).toEqual({ night: NIGHT, wakeTime: null, alarm: null });
    });

    it("answers a 403 forbidden and writes nothing and enqueues nothing without any grant", async () => {
      const run = await runOf(tenant);
      const set = await toolNamed(tenant, run.id, "sleepNightSet");

      const answer = await call(tenant, set, { night: NIGHT, wakeTime: "07:00", alarm: true });

      expect(answer.error).toBe(true);
      expect(answer.sensitive).toBeUndefined();
      expect(refusalSchema.parse(JSON.parse(answer.result))).toMatchObject({ status: 403, error: "forbidden" });
      expect(answer.result).not.toContain("07:00");
      expect(await exceptionsOf(tenant, NIGHT)).toEqual([]);
      expect(await resyncKeys()).toEqual([]);
      expect(createdBy).toEqual([]);
    });

    it("answers a 403 forbidden also for a call that would change nothing", async () => {
      const run = await runOf(tenant);
      const set = await toolNamed(tenant, run.id, "sleepNightSet");

      const answer = await call(tenant, set, { night: NIGHT, wakeTime: null });

      expect(answer.error).toBe(true);
      expect(refusalSchema.parse(JSON.parse(answer.result))).toMatchObject({ status: 403, error: "forbidden" });
    });

    it("answers a 403 forbidden for a call that would change nothing with read grants on all three databases", async () => {
      await grant(tenant, "read");
      const run = await runOf(tenant);
      const set = await toolNamed(tenant, run.id, "sleepNightSet");

      const answer = await call(tenant, set, { night: NIGHT, wakeTime: null });

      expect(answer.error).toBe(true);
      expect(answer.sensitive).toBeUndefined();
      expect(refusalSchema.parse(JSON.parse(answer.result))).toMatchObject({ status: 403, error: "forbidden" });
      expect(await exceptionsOf(tenant, NIGHT)).toEqual([]);
      expect(await resyncKeys()).toEqual([]);
    });

    it("answers the unchanged night for a call that would change nothing when the grants are there", async () => {
      await grantAll(tenant);
      const run = await runOf(tenant);
      const set = await toolNamed(tenant, run.id, "sleepNightSet");

      const answer = await call(tenant, set, { night: NIGHT, wakeTime: null });

      expect(answer.error).toBe(false);
      expect(setResultSchema.parse(JSON.parse(answer.result)).night).toMatchObject({
        night: NIGHT,
        wakeTime: "08:30",
        alarm: false,
        changed: false,
      });
      expect(await exceptionsOf(tenant, NIGHT)).toEqual([]);
      expect(await resyncKeys()).toEqual([]);
    });

    it("answers a 403 forbidden with a read grant on the nights database, and writes nothing", async () => {
      await grant(tenant, "read");
      const run = await runOf(tenant);
      const set = await toolNamed(tenant, run.id, "sleepNightSet");

      const answer = await call(tenant, set, { night: NIGHT, wakeTime: "07:00" });

      expect(refusalSchema.parse(JSON.parse(answer.result))).toMatchObject({ status: 403, error: "forbidden" });
      expect(await exceptionsOf(tenant, NIGHT)).toEqual([]);
      expect(await resyncKeys()).toEqual([]);
    });

    it("answers a 403 forbidden with a write grant on the nights database only, since the answer reads the plans and the settings", async () => {
      await grant(tenant, "write", [tenant.nightsDatabaseId]);
      const run = await runOf(tenant);
      const set = await toolNamed(tenant, run.id, "sleepNightSet");

      const answer = await call(tenant, set, { night: NIGHT, wakeTime: "07:00" });

      expect(refusalSchema.parse(JSON.parse(answer.result))).toMatchObject({ status: 403, error: "forbidden" });
      expect(await exceptionsOf(tenant, NIGHT)).toEqual([]);
      expect(await resyncKeys()).toEqual([]);
    });

    it("answers a 403 forbidden after the user revokes the grant it had", async () => {
      await grantAll(tenant);
      const run = await runOf(tenant);
      const set = await toolNamed(tenant, run.id, "sleepNightSet");
      expect((await call(tenant, set, { night: NIGHT, wakeTime: "07:00" })).error).toBe(false);
      await grant(tenant, "none", [tenant.nightsDatabaseId]);

      const answer = await call(tenant, set, { night: NIGHT, wakeTime: "07:30" });

      expect(refusalSchema.parse(JSON.parse(answer.result))).toMatchObject({ status: 403, error: "forbidden" });
      expect((await exceptionsOf(tenant, NIGHT)).map((row) => row.properties.wakeTime)).toEqual(["07:00"]);
    });

    it.each([
      ["a night that is not a calendar date", { night: "2026-13-01", wakeTime: "07:00" }, "night"],
      ["a night with a day that does not exist", { night: "2026-02-30" }, "night"],
      ["a wake time that is not HH:MM", { night: NIGHT, wakeTime: "7:5" }, "wakeTime"],
      ["a bed time of 24:00", { night: NIGHT, bedTime: "24:00" }, "bedTime"],
    ])("answers a 400 validation_failed naming the field for %s, and writes nothing", async (_name, args, field) => {
      await grantAll(tenant);
      const run = await runOf(tenant);
      const set = await toolNamed(tenant, run.id, "sleepNightSet");

      const answer = await call(tenant, set, args);

      expect(answer.error).toBe(true);
      expect(refusalSchema.parse(JSON.parse(answer.result))).toMatchObject({
        status: 400,
        error: "validation_failed",
        field,
      });
      expect(await exceptionsOf(tenant, args.night)).toEqual([]);
      expect(await resyncKeys()).toEqual([]);
    });

    it("answers a 400 for arguments that do not have the shape of the schema when the handler is called directly", async () => {
      await grantAll(tenant);
      const run = await runOf(tenant);

      const answer = await runInTenant(tenant.tenantId, () =>
        createSleepNightSetTool(dataPool)(run.id, { night: NIGHT, extra: 1 }),
      );

      expect(answer.error).toBe(true);
      expect(refusalSchema.parse(JSON.parse(answer.result))).toMatchObject({ status: 400, error: "validation_failed" });
      expect(await exceptionsOf(tenant, NIGHT)).toEqual([]);
    });

    it.each([
      ["sleepNightSet", createSleepNightSetTool, { night: NIGHT, wakeTime: "07:00" }],
      ["sleepNightsGet", createSleepNightsGetTool, { from: NIGHT, to: NIGHT }],
    ])(
      "%s answers a 404 not_found for a tenant without the sleep module, and writes nothing",
      async (_name, createTool, args) => {
        await grantAll(tenant);
        const run = await runOf(tenant);
        await removeSleepModule(tenant);

        const answer = await runInTenant(tenant.tenantId, () => createTool(dataPool)(run.id, args));

        expect(answer.error).toBe(true);
        expect(answer.sensitive).toBeUndefined();
        expect(refusalSchema.parse(JSON.parse(answer.result))).toMatchObject({ status: 404, error: "not_found" });
        expect(await exceptionsOf(tenant, NIGHT)).toEqual([]);
        expect(await resyncKeys()).toEqual([]);
      },
    );

    it("answers a 403 for a run that has no project, and writes nothing", async () => {
      await grantAll(tenant);
      const run = await runInTenant(tenant.tenantId, () =>
        createAgentRun(dataPool, { userId: tenant.userId, triggeredBy: "user", task: "sleep" }),
      );

      const answer = await runInTenant(tenant.tenantId, () =>
        createSleepNightSetTool(dataPool)(run.id, { night: NIGHT, wakeTime: "07:00" }),
      );

      expect(refusalSchema.parse(JSON.parse(answer.result))).toMatchObject({ status: 403, error: "forbidden" });
      expect(await exceptionsOf(tenant, NIGHT)).toEqual([]);
    });

    it("lets an error that is not a refusal propagate and writes nothing", async () => {
      await grantAll(tenant);
      const run = await runOf(tenant);
      // A stored plan whose value types the resolver cannot read fails the read of the answer after the write.
      await adminPool.query("UPDATE items SET properties = properties || '{\"bedTime\": 7}'::jsonb WHERE id = $1", [
        tenant.weekendPlanId,
      ]);

      await expect(
        runInTenant(tenant.tenantId, () =>
          createSleepNightSetTool(dataPool)(run.id, { night: NIGHT, wakeTime: "07:00" }),
        ),
      ).rejects.toBeInstanceOf(z.ZodError);

      expect(await exceptionsOf(tenant, NIGHT)).toEqual([]);
      expect(await resyncKeys()).toEqual([]);
    });
  });

  describe("sleepNightsGet", () => {
    it("with the grants returns the same nights as GET /api/sleep/nights for the range", async () => {
      await grantAll(tenant);
      const run = await runOf(tenant);
      const set = await toolNamed(tenant, run.id, "sleepNightSet");
      await call(tenant, set, { night: NIGHT, wakeTime: "07:00", alarm: true });
      const get = await toolNamed(tenant, run.id, "sleepNightsGet");

      const answer = await call(tenant, get, { from: "2026-10-14", to: "2026-10-18" });

      expect(answer.error).toBe(false);
      expect(answer.sensitive).toBe(true);
      const route = await runInTenant(tenant.tenantId, () =>
        sleepNightsGet(dataPool)({ req: { url: "/api/sleep/nights?from=2026-10-14&to=2026-10-18" } }),
      );
      expect(route.status).toBe(200);
      expect(JSON.parse(answer.result)).toEqual(JSON.parse(JSON.stringify(route.body)));
      const nights = nightsResultSchema.parse(JSON.parse(answer.result)).nights;
      expect(nights.map((night) => night.night)).toEqual([
        "2026-10-14",
        "2026-10-15",
        "2026-10-16",
        "2026-10-17",
        "2026-10-18",
      ]);
      expect(nights.find((night) => night.night === NIGHT)).toMatchObject({ wakeTime: "07:00", alarm: true });
    });

    it("answers a 403 forbidden and returns no sleep data without a grant", async () => {
      const run = await runOf(tenant);
      const get = await toolNamed(tenant, run.id, "sleepNightsGet");

      const answer = await call(tenant, get, { from: NIGHT, to: NIGHT });

      expect(answer.error).toBe(true);
      expect(answer.sensitive).toBeUndefined();
      expect(refusalSchema.parse(JSON.parse(answer.result))).toMatchObject({ status: 403, error: "forbidden" });
      expect(answer.result).not.toContain("nights");
      expect(answer.result).not.toContain("timezone");
    });

    it.each([
      ["settings", (t: SleepTenant) => t.settingsDatabaseId],
      ["plans", (t: SleepTenant) => t.plansDatabaseId],
      ["nights", (t: SleepTenant) => t.nightsDatabaseId],
    ])("answers a 403 forbidden when the %s database is the one without a read grant", async (_name, missing) => {
      await grant(
        tenant,
        "read",
        [tenant.settingsDatabaseId, tenant.plansDatabaseId, tenant.nightsDatabaseId].filter(
          (id) => id !== missing(tenant),
        ),
      );
      const run = await runOf(tenant);
      const get = await toolNamed(tenant, run.id, "sleepNightsGet");

      const answer = await call(tenant, get, { from: NIGHT, to: NIGHT });

      expect(refusalSchema.parse(JSON.parse(answer.result))).toMatchObject({ status: 403, error: "forbidden" });
    });

    it("succeeds with read grants only: a write grant is not needed to read", async () => {
      await grant(tenant, "read");
      const run = await runOf(tenant);
      const get = await toolNamed(tenant, run.id, "sleepNightsGet");

      const answer = await call(tenant, get, { from: NIGHT, to: NIGHT });

      expect(answer.error).toBe(false);
      expect(nightsResultSchema.parse(JSON.parse(answer.result)).nights).toHaveLength(1);
    });

    it.each([
      ["a from that is not a calendar date", { from: "2026-13-01", to: NIGHT }, "from"],
      ["a to that is not a calendar date", { from: NIGHT, to: "2026-10-32" }, "to"],
      ["a from after the to", { from: "2026-10-18", to: NIGHT }, "from"],
      ["a range of more than 62 nights", { from: "2026-01-01", to: "2026-03-05" }, "to"],
    ])("answers a 400 validation_failed naming the field for %s", async (_name, args, field) => {
      await grant(tenant, "read");
      const run = await runOf(tenant);
      const get = await toolNamed(tenant, run.id, "sleepNightsGet");

      const answer = await call(tenant, get, args);

      expect(answer.error).toBe(true);
      expect(refusalSchema.parse(JSON.parse(answer.result))).toMatchObject({
        status: 400,
        error: "validation_failed",
        field,
      });
    });

    it("answers a 400 for arguments that do not have the shape of the schema when the handler is called directly", async () => {
      await grant(tenant, "read");
      const run = await runOf(tenant);

      const answer = await runInTenant(tenant.tenantId, () =>
        createSleepNightsGetTool(dataPool)(run.id, { from: NIGHT }),
      );

      expect(answer.error).toBe(true);
      expect(refusalSchema.parse(JSON.parse(answer.result))).toMatchObject({ status: 400, error: "validation_failed" });
    });
  });

  describe("other tenants", () => {
    it("leaves the nights, the jobs and the data of another tenant untouched, and does not see its nights", async () => {
      await grantAll(tenant);
      await grantAll(other);
      const run = await runOf(tenant);
      const otherRun = await runOf(other);
      await call(other, await toolNamed(other, otherRun.id, "sleepNightSet"), {
        night: NIGHT,
        wakeTime: "06:00",
        alarm: false,
      });
      await clearResyncJobs();
      const otherPlans = await plansOf(other);

      await call(tenant, await toolNamed(tenant, run.id, "sleepNightSet"), {
        night: NIGHT,
        wakeTime: "07:00",
        alarm: true,
      });

      expect((await exceptionsOf(other, NIGHT)).map((row) => row.properties)).toEqual([
        { night: NIGHT, wakeTime: "06:00", alarm: false },
      ]);
      expect(await plansOf(other)).toEqual(otherPlans);
      expect(await resyncKeys()).toEqual([`sleep-resync:${tenant.tenantId}`]);
      const read = await call(other, await toolNamed(other, otherRun.id, "sleepNightsGet"), {
        from: NIGHT,
        to: NIGHT,
      });
      expect(nightsResultSchema.parse(JSON.parse(read.result)).nights[0]).toMatchObject({ wakeTime: "06:00" });
    });

    it("answers a 404 not_found for the run of another tenant, and writes and reads nothing", async () => {
      await grantAll(tenant);
      await grantAll(other);
      const foreignRun = await runOf(other);

      const written = await runInTenant(tenant.tenantId, () =>
        createSleepNightSetTool(dataPool)(foreignRun.id, { night: NIGHT, wakeTime: "07:00" }),
      );
      const read = await runInTenant(tenant.tenantId, () =>
        createSleepNightsGetTool(dataPool)(foreignRun.id, { from: NIGHT, to: NIGHT }),
      );

      for (const answer of [written, read]) {
        expect(answer.error).toBe(true);
        expect(answer.sensitive).toBeUndefined();
        expect(refusalSchema.parse(JSON.parse(answer.result))).toMatchObject({ status: 404, error: "not_found" });
      }
      expect(await exceptionsOf(tenant, NIGHT)).toEqual([]);
      expect(await exceptionsOf(other, NIGHT)).toEqual([]);
      expect(await resyncKeys()).toEqual([]);
    });
  });

  describe("schemas", () => {
    it("are strict and keep the canonical camelCase keys", () => {
      expect(Object.keys(sleepNightSetArgsSchema.shape)).toEqual(["night", "bedTime", "wakeTime", "alarm"]);
      expect(Object.keys(sleepNightsGetArgsSchema.shape)).toEqual(["from", "to"]);
      expect(sleepNightSetArgsSchema.safeParse({ night: NIGHT, wake_time: "07:00" }).success).toBe(false);
    });
  });

  it("keeps the PUT route a user write", async () => {
    // The route calls `upsertSleepNight` with the human writer; the agent tools above call it with the agent writer.
    await runInTenant(tenant.tenantId, () =>
      sleepNightPut(dataPool)({
        params: { night: NIGHT },
        body: { wakeTime: "07:00" },
        identity: { user: { id: tenant.userId } },
      }),
    );

    expect(createdBy).toEqual([USER]);
  });
});
