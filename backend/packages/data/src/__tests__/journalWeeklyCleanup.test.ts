import "../domainWriteHooks.js";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { AGENT_TASK_NAMES, CORE_TASK_NAMES } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { hashPassword } from "../auth/passwordHash.js";
import { createUser } from "../auth/usersStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { withTransaction } from "../db/pool.js";
import {
  createJournalWeeklyCleanupAction,
  ensureJournalWeeklyCleanupHeartbeat,
  findDuplicatedJournalPeriods,
  JOURNAL_WEEKLY_CLEANUP_ACTION_ID,
  MAX_LISTED_DUPLICATED_PERIODS,
} from "../journal/journalWeeklyCleanupAction.js";
import { runJournalWeeklyCleanupCutoverMigration } from "../journal/journalWeeklyCleanupCutoverMigration.js";
import type { JournalPeriodType } from "../journal/journalPeriods.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { KNOWN_HEARTBEAT_ACTION_IDS } from "../manifest/knownActionIds.js";
import {
  createActionQueueAffinity,
  createActionRegistry,
  resolveAgentRunLane,
  resolveHeartbeatFireTaskName,
  type ActionContext,
  type RunAgentFn,
} from "../scheduler/actions.js";
import { createHeartbeatFireAgentTask } from "../scheduler/sweep.js";
import { seedSystem } from "../seed/seedSystem.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

// The weekly Journal cleanup heartbeat (issue #1883): its seeding for new tenants, its cutover for existing ones, and
// the action that finds the duplicated periods and starts the agent run. Everything runs on a runtime-role pool inside
// a tenant scope, the way the workers run it; the merge itself is covered by `journalMergeForWriter.test.ts`.

// Seeding the system databases of a tenant is the slow part of this file.
const SEEDING_TEST_TIMEOUT_MS = 120_000;
const CS_TASK = readCatalog("cs")["journalWeeklyCleanup.task"];
const EN_TASK = readCatalog("en")["journalWeeklyCleanup.task"];
const CS_HEADING = readCatalog("cs")["journalWeeklyCleanup.duplicatesHeading"];
const EN_HEADING = readCatalog("en")["journalWeeklyCleanup.duplicatesHeading"];

function readCatalog(locale: "cs" | "en"): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(new URL(`../journal/i18n/${locale}.json`, import.meta.url), "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error(`catalog ${locale} is not an object`);
  const catalog: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new Error(`catalog ${locale} key ${key} is not a string`);
    catalog[key] = value;
  }
  return catalog;
}

interface HeartbeatShape {
  id: string;
  name: string;
  rule: unknown;
  action_config: Record<string, unknown>;
  project_item_id: string;
  last_error: string | null;
}

let admin: Pool;
let pool: Pool;
/** One calendar day per test, so no test sees the entries of another. */
let dayCounter = 0;

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(pool, fn));
}

function nextDay(): string {
  dayCounter += 1;
  return `2037-04-${String(dayCounter).padStart(2, "0")}`;
}

/** A tenant with the system databases seeded and no user yet, as a tenant created before its first sign-in is. */
async function seededTenant(): Promise<string> {
  const tenant = await createTestTenant(admin);
  await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
  return tenant;
}

/** A tenant whose user of `locale` exists before the system databases are seeded, as an installed tenant has. */
async function seededTenantWithUser(locale: string): Promise<{ tenant: string; userId: string }> {
  const tenant = await createTestTenant(admin);
  const user = await createUser(admin, {
    email: `${tenant}@example.test`,
    passwordHash: await hashPassword("s3cret-password"),
    locale,
    tenantId: tenant,
  });
  await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
  return { tenant, userId: user.id };
}

async function cleanupHeartbeats(tenant: string): Promise<HeartbeatShape[]> {
  return inTenant(tenant, async (client) => {
    const { rows } = await client.query<HeartbeatShape>(
      `SELECT id, name, rule, action_config, project_item_id, last_error FROM project_heartbeats
       WHERE action_id = $1 ORDER BY id`,
      [JOURNAL_WEEKLY_CLEANUP_ACTION_ID],
    );
    return rows;
  });
}

/** The Semprec project: the owner project of the System settings database. */
async function semprecProjectId(tenant: string): Promise<string> {
  return inTenant(tenant, async (client) => {
    const { rows } = await client.query<{ owner_project_item_id: string | null }>(
      "SELECT owner_project_item_id FROM databases WHERE owner_module_id = 'systemSettings'",
    );
    const id = rows[0]?.owner_project_item_id;
    if (!id) throw new Error("Semprec project missing");
    return id;
  });
}

/**
 * One live entry of a period. Two live entries of one period are a state the lazy creation never produces (it reuses
 * the live entry), so the fixture creates them directly; entries made one after the other are created first and next.
 */
async function entry(tenant: string, period: string, name: string, type: JournalPeriodType = "day"): Promise<string> {
  return inTenant(tenant, async (client) => {
    const journal = await getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
    if (!journal) throw new Error("Journal missing");
    const item = await createItemWithClient(
      client,
      { databaseId: journal.id, properties: { name, type, period } },
      { allowedSystemKeys: ["name", "type", "period"] },
    );
    return item.id;
  });
}

async function duplicated(tenant: string, period: string, type: JournalPeriodType = "day") {
  const older = await entry(tenant, period, `\u{1F4D3} ${period} first`, type);
  const newer = await entry(tenant, period, `\u{1F4D3} ${period} second`, type);
  return { older, newer };
}

async function liveOf(tenant: string, ids: readonly string[]): Promise<string[]> {
  return inTenant(tenant, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM items WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY id",
      [ids],
    );
    return rows.map((row) => row.id);
  });
}

function find(tenant: string, limit = MAX_LISTED_DUPLICATED_PERIODS) {
  return inTenant(tenant, (client) => findDuplicatedJournalPeriods(client, limit));
}

/** The agent step of a run: records what it was asked to run and finishes the run. */
function recordingRunAgent(): {
  runAgent: RunAgentFn;
  calls: Array<{ task: string; projectItemId: string; agentRunId: string }>;
} {
  const calls: Array<{ task: string; projectItemId: string; agentRunId: string }> = [];
  return {
    calls,
    runAgent: async ({ task, projectItemId, agentRunId }) => {
      calls.push({ task, projectItemId, agentRunId });
    },
  };
}

function cleanupContext(heartbeat: HeartbeatShape): ActionContext {
  return { heartbeatId: heartbeat.id, projectItemId: heartbeat.project_item_id };
}

/** The one cleanup heartbeat of a seeded tenant. */
async function onlyHeartbeat(tenant: string): Promise<HeartbeatShape> {
  const [heartbeat, ...rest] = await cleanupHeartbeats(tenant);
  if (!heartbeat || rest.length > 0) throw new Error("expected exactly one cleanup heartbeat");
  return heartbeat;
}

async function agentRuns(tenant: string) {
  return inTenant(tenant, async (client) => {
    const { rows } = await client.query<{
      project_item_id: string;
      task: string;
      status: string;
      result: string | null;
    }>("SELECT project_item_id, task, status, result FROM agent_runs ORDER BY started_at");
    return rows;
  });
}

/**
 * A tenant that lost its Journal database is a state no production write produces (the system databases are locked),
 * so the fixture removes it with raw SQL on the admin pool to make the duplicate search fail.
 */
async function removeJournal(tenant: string): Promise<void> {
  await admin.query(
    "DELETE FROM items WHERE tenant_id = $1 AND database_id IN (SELECT id FROM databases WHERE tenant_id = $1 AND owner_module_id = 'journal')",
    [tenant],
  );
  await admin.query("DELETE FROM databases WHERE tenant_id = $1 AND owner_module_id = 'journal'", [tenant]);
}

/** Wraps the pool so its first `connect()` calls reject with `errors`, in order (`null` lets that call through). */
function poolWithFailingConnects(errors: (Error | null)[]): Pool {
  const remaining = [...errors];
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "connect") {
        return () => {
          const next = remaining.shift();
          return next ? Promise.reject(next) : target.connect();
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function runCleanup(tenant: string, runAgent: RunAgentFn, actionConfig?: Record<string, unknown>): Promise<void> {
  const heartbeat = await onlyHeartbeat(tenant);
  const handler = createJournalWeeklyCleanupAction(pool, runAgent);
  await runInTenant(tenant, () => handler(actionConfig ?? heartbeat.action_config, cleanupContext(heartbeat)));
}

describe("the weekly Journal cleanup heartbeat (issue #1883)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await resetDatabase(admin);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  describe("registration", () => {
    it("is a known heartbeat action of the systemDatabases manifest", async () => {
      expect(KNOWN_HEARTBEAT_ACTION_IDS.has(JOURNAL_WEEKLY_CLEANUP_ACTION_ID)).toBe(true);
      const registry = await loadFullModuleRegistry();
      expect(await registry.getHeartbeatActions()).toContain(JOURNAL_WEEKLY_CLEANUP_ACTION_ID);
    });

    it("routes onto heartbeatFireAgent and the per-tenant agent-run lane, as core.agentRun does", () => {
      expect(resolveHeartbeatFireTaskName(JOURNAL_WEEKLY_CLEANUP_ACTION_ID)).toBe(
        AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT,
      );
      expect(resolveHeartbeatFireTaskName("core.tasksDayRollover")).toBe(CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE);
      // The lane exists only inside a tenant scope.
      const lane = runInTenant("00000000-0000-4000-8000-000000000001", () =>
        resolveAgentRunLane(JOURNAL_WEEKLY_CLEANUP_ACTION_ID),
      );
      expect(lane).toBe("agent-run:00000000-0000-4000-8000-000000000001");
    });

    it("has a cleanup task text in both catalogs", () => {
      expect(CS_TASK).toBeTruthy();
      expect(EN_TASK).toBeTruthy();
      expect(CS_HEADING).toBeTruthy();
      expect(EN_HEADING).toBeTruthy();
      expect(CS_TASK).not.toBe(EN_TASK);
    });
  });

  describe("seeding", () => {
    it(
      "gives a new tenant exactly one weekly Sunday 21:00 heartbeat on the Semprec project, with the Czech task while it has no user",
      async () => {
        const tenant = await seededTenant();
        const heartbeats = await cleanupHeartbeats(tenant);
        expect(heartbeats).toHaveLength(1);
        expect(heartbeats[0]).toMatchObject({
          name: "Weekly journal cleanup",
          rule: { kind: "weekly", days: ["sun"], at: "21:00" },
          action_config: { task: CS_TASK },
          project_item_id: await semprecProjectId(tenant),
        });
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "writes the English task for a tenant whose user's locale is en",
      async () => {
        const { tenant } = await seededTenantWithUser("en");
        const heartbeats = await cleanupHeartbeats(tenant);
        expect(heartbeats).toHaveLength(1);
        expect(heartbeats[0]?.action_config).toEqual({ task: EN_TASK });
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "creates none on a second call and says so",
      async () => {
        const tenant = await seededTenant();
        const project = await semprecProjectId(tenant);
        const created = await inTenant(tenant, (client) => ensureJournalWeeklyCleanupHeartbeat(client, project));
        expect(created).toBe(false);
        expect(await cleanupHeartbeats(tenant)).toHaveLength(1);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );
  });

  describe("cutover", () => {
    it(
      "gives an existing tenant the same heartbeat, once, and keeps the tenants apart",
      async () => {
        const first = { tenant: await seededTenant() };
        const second = await seededTenantWithUser("en");
        const expectedFirst = await cleanupHeartbeats(first.tenant);
        const expectedSecond = await cleanupHeartbeats(second.tenant);
        // Synthetic previous shape: a tenant seeded before issue #1883 has no cleanup heartbeat.
        for (const tenant of [first.tenant, second.tenant]) {
          await inTenant(tenant, async (client) => {
            const removed = await client.query("DELETE FROM project_heartbeats WHERE action_id = $1", [
              JOURNAL_WEEKLY_CLEANUP_ACTION_ID,
            ]);
            expect(removed.rowCount).toBe(1);
          });
        }
        expect(await cleanupHeartbeats(first.tenant)).toEqual([]);

        await runAsSystem("test:journal-cleanup-cutover", () => runTenantCutoverMigrations(pool));
        const afterFirstRun = [await cleanupHeartbeats(first.tenant), await cleanupHeartbeats(second.tenant)];
        expect(afterFirstRun.map((rows) => rows.length)).toEqual([1, 1]);
        expect(afterFirstRun[0]?.[0]).toMatchObject({
          name: "Weekly journal cleanup",
          rule: { kind: "weekly", days: ["sun"], at: "21:00" },
          action_config: { task: CS_TASK },
          project_item_id: await semprecProjectId(first.tenant),
        });
        expect(afterFirstRun[1]?.[0]).toMatchObject({
          action_config: { task: EN_TASK },
          project_item_id: await semprecProjectId(second.tenant),
        });
        expect(expectedFirst[0]?.project_item_id).toBe(afterFirstRun[0]?.[0]?.project_item_id);
        expect(expectedSecond[0]?.project_item_id).toBe(afterFirstRun[1]?.[0]?.project_item_id);

        await runAsSystem("test:journal-cleanup-cutover", () => runTenantCutoverMigrations(pool));
        expect(await cleanupHeartbeats(first.tenant)).toEqual(afterFirstRun[0]);
        expect(await cleanupHeartbeats(second.tenant)).toEqual(afterFirstRun[1]);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it("does nothing for a tenant without a Semprec project", async () => {
      const tenant = await createTestTenant(admin);
      await runInTenant(tenant, () => runJournalWeeklyCleanupCutoverMigration(pool));
      expect(await cleanupHeartbeats(tenant)).toEqual([]);
    });
  });

  describe("finding the duplicated periods", () => {
    it(
      "lists the periods with more than one live entry and nothing else, in type and period order",
      async () => {
        const tenant = await seededTenant();
        const dayA = nextDay();
        const dayB = nextDay();
        const week = "2037-W20";
        await duplicated(tenant, dayB);
        await duplicated(tenant, dayA);
        await duplicated(tenant, week, "week");
        await entry(tenant, nextDay(), "single day entry");
        const trashed = await duplicated(tenant, nextDay());
        await inTenant(tenant, async (client) => {
          const journal = await getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
          if (!journal) throw new Error("Journal missing");
          await itemDeleteWithClient(client, journal.id, trashed.newer, {
            queueAffinity: createActionQueueAffinity(),
            writer: SYSTEM_WRITER,
          });
        });

        expect(await find(tenant)).toEqual([
          { type: "day", period: dayA },
          { type: "day", period: dayB },
          { type: "week", period: week },
        ]);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "cuts the list to the limit",
      async () => {
        const tenant = await seededTenant();
        const days = [nextDay(), nextDay(), nextDay()];
        for (const day of days) await duplicated(tenant, day);
        expect(await find(tenant, 2)).toEqual([
          { type: "day", period: days[0] },
          { type: "day", period: days[1] },
        ]);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "reads only the tenant's own Journal",
      async () => {
        const first = await seededTenant();
        const second = await seededTenant();
        const day = nextDay();
        await duplicated(first, day);
        expect(await find(first)).toEqual([{ type: "day", period: day }]);
        expect(await find(second)).toEqual([]);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "fails when the tenant has no Journal database, instead of reading it as nothing duplicated",
      async () => {
        const tenant = await createTestTenant(admin);
        await expect(find(tenant)).rejects.toMatchObject({ message: "Journal database not found" });
      },
      SEEDING_TEST_TIMEOUT_MS,
    );
  });

  describe("the action", () => {
    it(
      "leaves both entries live and starts one agent run with the task and the duplicated day",
      async () => {
        const { tenant } = await seededTenantWithUser("en");
        const day = nextDay();
        const { older, newer } = await duplicated(tenant, day);
        const agent = recordingRunAgent();

        await runCleanup(tenant, agent.runAgent);

        const task = [EN_TASK, EN_HEADING, `- day ${day}`].join("\n");
        expect(agent.calls).toEqual([
          { task, projectItemId: await semprecProjectId(tenant), agentRunId: expect.any(String) as string },
        ]);
        expect(await agentRuns(tenant)).toEqual([
          { project_item_id: await semprecProjectId(tenant), task, status: "done", result: null },
        ]);
        expect(await liveOf(tenant, [older, newer])).toEqual([older, newer].sort());
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "names every duplicated period, under the Czech heading for a Czech user",
      async () => {
        const { tenant } = await seededTenantWithUser("cs");
        const day = nextDay();
        await duplicated(tenant, day);
        await duplicated(tenant, "2037-W21", "week");
        const agent = recordingRunAgent();

        await runCleanup(tenant, agent.runAgent);

        expect(agent.calls.map((call) => call.task)).toEqual([
          [CS_TASK, CS_HEADING, `- day ${day}`, "- week 2037-W21"].join("\n"),
        ]);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "runs the agent with the task alone when no period is duplicated",
      async () => {
        const { tenant } = await seededTenantWithUser("en");
        await entry(tenant, nextDay(), "single day entry");
        const agent = recordingRunAgent();

        await runCleanup(tenant, agent.runAgent);

        expect(agent.calls.map((call) => call.task)).toEqual([EN_TASK]);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "refuses a heartbeat whose task is missing or empty, before any agent run",
      async () => {
        const { tenant } = await seededTenantWithUser("en");
        const agent = recordingRunAgent();
        await expect(runCleanup(tenant, agent.runAgent, {})).rejects.toThrow();
        await expect(runCleanup(tenant, agent.runAgent, { task: "" })).rejects.toThrow();
        expect(agent.calls).toEqual([]);
        expect(await agentRuns(tenant)).toEqual([]);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "records a failed duplicate search as an error run with the bare task, rejects with the search's error, and never starts the agent",
      async () => {
        const { tenant } = await seededTenantWithUser("en");
        await removeJournal(tenant);
        const agent = recordingRunAgent();

        await expect(runCleanup(tenant, agent.runAgent)).rejects.toMatchObject({
          message: "Journal database not found",
        });

        expect(agent.calls).toEqual([]);
        expect(await agentRuns(tenant)).toEqual([
          { project_item_id: await semprecProjectId(tenant), task: EN_TASK, status: "error", result: "internal" },
        ]);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "never lets a failure to record the run replace the search's error",
      async () => {
        const { tenant } = await seededTenantWithUser("en");
        await removeJournal(tenant);
        const heartbeat = await onlyHeartbeat(tenant);
        // The first connect is the duplicate search, the second the failed run's start.
        const handler = createJournalWeeklyCleanupAction(
          poolWithFailingConnects([null, new Error("db down")]),
          async () => {
            throw new Error("the agent must not start");
          },
        );

        await expect(
          runInTenant(tenant, () => handler(heartbeat.action_config, cleanupContext(heartbeat))),
        ).rejects.toMatchObject({ message: "Journal database not found" });

        expect(await agentRuns(tenant)).toEqual([]);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );
  });

  describe("fired through the heartbeat fire task", () => {
    function fireTask(runAgent: RunAgentFn) {
      const registry = createActionRegistry();
      registry.set(JOURNAL_WEEKLY_CLEANUP_ACTION_ID, createJournalWeeklyCleanupAction(pool, runAgent));
      return createHeartbeatFireAgentTask(pool, registry);
    }
    /** The final attempt of the job, so a failure is recorded and notified. */
    function finalAttempt(): Parameters<ReturnType<typeof fireTask>>[1] {
      return { job: { id: "job-final", attempts: 3, max_attempts: 3 } } as Parameters<ReturnType<typeof fireTask>>[1];
    }

    it(
      "starts one agent run on the Semprec project whose task names the day, and leaves both entries live",
      async () => {
        const { tenant, userId } = await seededTenantWithUser("en");
        const day = nextDay();
        const { older, newer } = await duplicated(tenant, day);
        const heartbeat = await onlyHeartbeat(tenant);
        const dispatched: string[] = [];
        const task = fireTask(async (input) => {
          dispatched.push(input.task);
        });

        await runInTenant(tenant, () => task({ heartbeatId: heartbeat.id, triggeredByUserId: userId }, finalAttempt()));

        const runs = await agentRuns(tenant);
        expect(runs).toHaveLength(1);
        expect(runs[0]?.project_item_id).toBe(await semprecProjectId(tenant));
        expect(runs[0]?.task).toContain(`- day ${day}`);
        expect(runs[0]?.status).toBe("done");
        expect(dispatched).toEqual([runs[0]?.task]);
        expect(await liveOf(tenant, [older, newer])).toEqual([older, newer].sort());
        expect((await cleanupHeartbeats(tenant))[0]?.last_error).toBeNull();
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "records a failed duplicate search as an error run in the tick thread, a failed fire and notifications, and starts no agent",
      async () => {
        const { tenant, userId } = await seededTenantWithUser("en");
        const heartbeat = await onlyHeartbeat(tenant);
        await removeJournal(tenant);
        const dispatched: string[] = [];
        const task = fireTask(async (input) => {
          dispatched.push(input.task);
        });

        await expect(
          runInTenant(tenant, () => task({ heartbeatId: heartbeat.id, triggeredByUserId: userId }, finalAttempt())),
        ).rejects.toThrow("Journal database not found");

        expect(dispatched).toEqual([]);
        const runs = await agentRuns(tenant);
        expect(runs).toEqual([
          { project_item_id: await semprecProjectId(tenant), task: EN_TASK, status: "error", result: "internal" },
        ]);
        expect((await cleanupHeartbeats(tenant))[0]?.last_error).toBe("Journal database not found");
        const messages = await inTenant(tenant, async (client) => {
          const { rows } = await client.query<{ role: string; status: string }>(
            `SELECT m.role, m.status FROM semp_messages m JOIN semp_threads t ON t.id = m.thread_id
             WHERE t.kind = 'tick' AND t.heartbeat_id = $1`,
            [heartbeat.id],
          );
          return rows;
        });
        expect(messages).toEqual([{ role: "assistant", status: "error" }]);
        const notifications = await inTenant(tenant, async (client) => {
          const { rows } = await client.query<{ kind: string }>("SELECT kind FROM notifications ORDER BY kind");
          return rows.map((row) => row.kind);
        });
        // The failed run's close raises the heartbeat's `agents` problem (one semp_problem notification, issue gh-1911);
        // the failed fire's report merges into that same problem and adds no second one.
        expect(notifications).toEqual(["agent_run_error", "heartbeat_error", "semp_problem"]);
        const problems = await inTenant(tenant, async (client) => {
          const { rows } = await client.query<{ dedupe_key: string; occurrence_count: number }>(
            "SELECT dedupe_key, occurrence_count FROM semp_problems WHERE resolved_at IS NULL",
          );
          return rows;
        });
        expect(problems).toEqual([{ dedupe_key: `agents:heartbeat:${heartbeat.id}`, occurrence_count: 2 }]);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );
  });
});
