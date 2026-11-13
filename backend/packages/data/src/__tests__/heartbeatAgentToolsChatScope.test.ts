import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import { removeAgentDatabaseGrant, setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import type { AgentDatabaseAccess } from "../agentGrants/agentDatabaseGrantsStore.js";
import { createAgentRun, finishAgentRun } from "../agentRuns/agentRunsStore.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import {
  createHeartbeatHistoryTool,
  createHeartbeatListTool,
  createHeartbeatTriggerTool,
  type HeartbeatAgentToolResult,
} from "../scheduler/heartbeatAgentTools.js";
import { createHeartbeat, manualHeartbeatFireJobKey } from "../scheduler/schedulerStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { HEALTH_RECORDS_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getOrCreateTickThread } from "../semp/sempTickThreadStore.js";
import { createSempChatThread } from "../sempThreads/sempThreadsStore.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import type { DatabaseRow } from "../types.js";

// Seeding the system databases of one tenant is the slow part of this file.
const SEEDING_TEST_TIMEOUT_MS = 120_000;
const DAILY_RULE = { kind: "dailyTime", at: "09:00" } as const;

let adminPool: Pool;
let dataPool: Pool;
let cp: ChokePoint;
let tenantA: string;
let tenantB: string;
let health: DatabaseRow;
let otherSensitiveId: string;
let projectsDatabase: DatabaseRow;
let semprecProjectId: string;

function inTenantA<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenantA, fn);
}

const listEntrySchema = z.record(z.string(), z.unknown()).and(z.object({ id: z.string() }));
const historyEntrySchema = z.object({ id: z.string(), status: z.string(), result: z.string().nullable() });

/** The entries of a successful `heartbeat.list`. */
function listEntries(outcome: HeartbeatAgentToolResult): z.infer<typeof listEntrySchema>[] {
  expect(outcome.error).toBe(false);
  return z.array(listEntrySchema).parse(JSON.parse(outcome.result));
}

function listedIds(outcome: HeartbeatAgentToolResult): string[] {
  return listEntries(outcome).map((entry) => entry.id);
}

async function newProject(name: string): Promise<string> {
  const item = await inTenantA(() => cp.createItem({ databaseId: projectsDatabase.id, properties: { name } }));
  return item.id;
}

async function newHeartbeat(projectItemId: string, name: string, tenantId = tenantA): Promise<string> {
  return runInTenant(tenantId, async () => {
    const heartbeat = await withTransaction(dataPool, (client) =>
      createHeartbeat(client, { projectItemId, name, rule: DAILY_RULE, actionId: "core.agentRun" }),
    );
    return heartbeat.id;
  });
}

/** A run on a fresh Semp chat thread, or a run delegated from `parentRunId`, which inherits the parent's thread (issue #1452). */
async function chatRun(projectItemId: string, options: { parentRunId?: string } = {}): Promise<string> {
  return inTenantA(async () => {
    const threadId = options.parentRunId ? undefined : await withTransaction(dataPool, createSempChatThread);
    const run = await createAgentRun(dataPool, {
      projectItemId,
      triggeredBy: "user",
      task: "answer a question",
      ...(threadId ? { threadId } : {}),
      ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    });
    return run.id;
  });
}

async function runOnThread(projectItemId: string, threadId: string | null, triggeredBy: "user" | "heartbeat" = "user") {
  return inTenantA(async () => {
    const run = await createAgentRun(dataPool, { projectItemId, triggeredBy, task: "look around", threadId });
    return run.id;
  });
}

function list(runId: string, tenantId = tenantA): Promise<HeartbeatAgentToolResult> {
  return runInTenant(tenantId, () => createHeartbeatListTool(dataPool)(runId, {}));
}

function history(runId: string, heartbeatId: string): Promise<HeartbeatAgentToolResult> {
  return inTenantA(() => createHeartbeatHistoryTool(dataPool)(runId, { heartbeatId }));
}

function trigger(runId: string, heartbeatId: string): Promise<HeartbeatAgentToolResult> {
  return inTenantA(() => createHeartbeatTriggerTool(dataPool)(runId, { heartbeatId }));
}

function setGrant(projectItemId: string, databaseId: string, access: AgentDatabaseAccess) {
  return inTenantA(() =>
    withTransaction(dataPool, (client) => setAgentDatabaseGrant(client, { projectItemId, databaseId, access })),
  );
}

function removeGrant(projectItemId: string, databaseId: string) {
  return inTenantA(() =>
    withTransaction(dataPool, (client) => removeAgentDatabaseGrant(client, projectItemId, databaseId)),
  );
}

/** The runs a heartbeat started: the history rows the tool must return. */
async function startHeartbeatRun(projectItemId: string, heartbeatId: string, result: string): Promise<string> {
  const run = await inTenantA(() =>
    createAgentRun(dataPool, { projectItemId, heartbeatId, triggeredBy: "heartbeat", task: "tick" }),
  );
  await inTenantA(() => finishAgentRun(dataPool, run.id, "done", result));
  return run.id;
}

async function pendingManualFireJobs(heartbeatId: string): Promise<number> {
  const { rows } = await adminPool.query<{ key: string }>(
    "SELECT key FROM graphile_worker._private_jobs WHERE key = $1",
    [manualHeartbeatFireJobKey(heartbeatId)],
  );
  return rows.length;
}

describe("heartbeat agent tools: the tenant scope of a Semp chat run (issue #2018)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    await resetDatabase(adminPool);
    tenantA = await createTestTenant(adminPool);
    tenantB = await createTestTenant(adminPool);
    // Every agent run needs the tenant's user as its actor.
    await createUser(adminPool, { email: `${randomUUID()}@example.com`, passwordHash: "unused", tenantId: tenantA });
    await inTenantA(() => seedSystem(dataPool, createViewTypeRegistry()));
    cp = createChokePoint(dataPool);
    await inTenantA(async () => {
      await withTransaction(dataPool, async (client) => {
        const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
        const healthDatabase = await getDatabaseByModuleId(client, HEALTH_RECORDS_MODULE_ID);
        if (!projects || !healthDatabase) throw new Error("The seeded system databases are missing");
        projectsDatabase = projects;
        health = healthDatabase;
        const { rows } = await client.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = $1 AND properties->>'name' = 'Semprec' AND deleted_at IS NULL",
          [projects.id],
        );
        const semprec = rows[0];
        if (!semprec) throw new Error("The seeded Semprec project is missing");
        semprecProjectId = semprec.id;
        const { rows: sensitiveRows } = await client.query<{ id: string }>(
          "SELECT id FROM databases WHERE sensitive AND id <> $1 ORDER BY id LIMIT 1",
          [healthDatabase.id],
        );
        const other = sensitiveRows[0];
        if (!other) throw new Error("A second sensitive system database is missing");
        otherSensitiveId = other.id;
      });
    });
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await dataPool?.end();
  });

  describe("heartbeat.list", () => {
    it("gives a chat run the heartbeats of the Semprec project and of another project with their project names", async () => {
      const garden = await newProject("Garden");
      const ownHeartbeat = await newHeartbeat(semprecProjectId, "Weekly journal cleanup");
      const gardenHeartbeat = await newHeartbeat(garden, "Water the plants");
      const run = await chatRun(semprecProjectId);

      const entries = listEntries(await list(run));

      expect(entries.find((entry) => entry.id === ownHeartbeat)).toMatchObject({
        name: "Weekly journal cleanup",
        projectItemId: semprecProjectId,
        projectName: "Semprec",
        enabled: true,
        rule: DAILY_RULE,
        lastFiredAt: null,
      });
      expect(entries.find((entry) => entry.id === gardenHeartbeat)).toMatchObject({
        name: "Water the plants",
        projectItemId: garden,
        projectName: "Garden",
      });
    });

    it("gives a null project name to a heartbeat whose project item has no name", async () => {
      const unnamed = await inTenantA(() => createTestProjectItem(dataPool));
      const unnamedHeartbeat = await newHeartbeat(unnamed, "Nameless project job");
      const run = await chatRun(semprecProjectId);

      const entry = listEntries(await list(run)).find((candidate) => candidate.id === unnamedHeartbeat);

      expect(entry).toMatchObject({ projectItemId: unnamed, projectName: null });
    });

    it("gives a run delegated from a chat run the same tenant scope, through the inherited thread", async () => {
      const garden = await newProject("Greenhouse");
      const gardenHeartbeat = await newHeartbeat(garden, "Check the greenhouse");
      const semprecHeartbeat = await newHeartbeat(semprecProjectId, "Delegated visibility check");
      const parent = await chatRun(semprecProjectId);
      const child = await chatRun(garden, { parentRunId: parent });

      const ids = listedIds(await list(child));

      expect(ids).toContain(gardenHeartbeat);
      expect(ids).toContain(semprecHeartbeat);
    });

    it("never lists another tenant's heartbeats to a chat run", async () => {
      const foreignProject = await runInTenant(tenantB, () => createTestProjectItem(dataPool));
      const foreignHeartbeat = await newHeartbeat(foreignProject, "Tenant B secret job", tenantB);
      const ownHeartbeat = await newHeartbeat(semprecProjectId, "Tenant A job");
      const run = await chatRun(semprecProjectId);

      const entries = listEntries(await list(run));

      expect(entries.map((entry) => entry.id)).toContain(ownHeartbeat);
      expect(entries.map((entry) => entry.id)).not.toContain(foreignHeartbeat);
      expect(entries.map((entry) => entry.projectItemId)).not.toContain(foreignProject);
    });

    it("keeps a run without a thread, an item thread run, a tick thread run and a heartbeat run on their own project", async () => {
      const garden = await newProject("Own project only");
      const gardenHeartbeat = await newHeartbeat(garden, "Own heartbeat");
      const semprecHeartbeat = await newHeartbeat(semprecProjectId, "Foreign heartbeat");
      const itemThread = await inTenantA(() =>
        withTransaction(dataPool, async (client) => {
          // Raw SQL: the thread's subject is an Inbox item this test does not need; the column has no foreign key.
          const { rows } = await client.query<{ id: string }>(
            "INSERT INTO semp_threads (kind, subject_inbox_item_id) VALUES ('item', gen_random_uuid()) RETURNING id",
          );
          return z.string().parse(rows[0]?.id);
        }),
      );
      const tickThread = await inTenantA(() =>
        withTransaction(dataPool, (client) => getOrCreateTickThread(client, gardenHeartbeat)),
      );

      const runs = [
        await runOnThread(garden, null),
        await runOnThread(garden, itemThread),
        await runOnThread(garden, tickThread.id, "heartbeat"),
      ];
      for (const run of runs) {
        const entries = listEntries(await list(run));
        expect(entries.map((entry) => entry.id)).toContain(gardenHeartbeat);
        expect(entries.map((entry) => entry.id)).not.toContain(semprecHeartbeat);
        // The own-project entry keeps the shape it had before the tenant scope existed.
        const own = entries.find((entry) => entry.id === gardenHeartbeat);
        expect(own).not.toHaveProperty("projectItemId");
        expect(own).not.toHaveProperty("projectName");
      }
    });

    it("fails for a run id that does not exist, without leaking other heartbeats", async () => {
      const outcome = await inTenantA(() =>
        createHeartbeatListTool(dataPool)("00000000-0000-4000-8000-000000000000", {}),
      );
      expect(outcome).toEqual({
        error: true,
        result: "No project context for run 00000000-0000-4000-8000-000000000000",
      });
    });
  });

  describe("the sensitive-project rule", () => {
    it("leaves out the heartbeat of a project with a grant on a sensitive database that the chat run's project lacks, and keeps it once the run's project has one", async () => {
      const medical = await newProject("Medical");
      const medicalHeartbeat = await newHeartbeat(medical, "Summarise lab results");
      const caller = await newProject("Chat caller");
      await setGrant(medical, health.id, "read");
      const run = await chatRun(caller);

      expect(listedIds(await list(run))).not.toContain(medicalHeartbeat);

      await setGrant(caller, health.id, "read");
      expect(listedIds(await list(run))).toContain(medicalHeartbeat);
    });

    it("lets a write grant of the chat run's project through as well, and drops the heartbeat again when the grant is removed", async () => {
      const medical = await newProject("Medical write");
      const medicalHeartbeat = await newHeartbeat(medical, "Write-side job");
      const caller = await newProject("Chat caller with write");
      await setGrant(medical, health.id, "write");
      await setGrant(caller, health.id, "write");
      const run = await chatRun(caller);

      expect(listedIds(await list(run))).toContain(medicalHeartbeat);

      await removeGrant(caller, health.id);
      expect(listedIds(await list(run))).not.toContain(medicalHeartbeat);
    });

    it("does not count an explicit none on the chat run's project as a grant", async () => {
      const medical = await newProject("Medical refused");
      const medicalHeartbeat = await newHeartbeat(medical, "Refused caller job");
      const caller = await newProject("Chat caller refused");
      await setGrant(medical, health.id, "read");
      await setGrant(caller, health.id, "none");
      const run = await chatRun(caller);

      expect(listedIds(await list(run))).not.toContain(medicalHeartbeat);
    });

    it("keeps the heartbeat of a project whose own row on a sensitive database is none", async () => {
      const refused = await newProject("Refused project");
      const refusedHeartbeat = await newHeartbeat(refused, "Refused project job");
      const caller = await newProject("Chat caller without grant");
      await setGrant(refused, health.id, "none");
      const run = await chatRun(caller);

      expect(listedIds(await list(run))).toContain(refusedHeartbeat);
    });

    it("keeps the heartbeat of a project whose grant is on a database that is not sensitive", async () => {
      const notes = await inTenantA(() => cp.createDatabase({ name: "Plain notes" }));
      const plain = await newProject("Plain grants");
      const plainHeartbeat = await newHeartbeat(plain, "Plain grant job");
      const caller = await newProject("Chat caller plain");
      await setGrant(plain, notes.id, "read");
      const run = await chatRun(caller);

      expect(listedIds(await list(run))).toContain(plainHeartbeat);
    });

    it("leaves a heartbeat out when the chat run's project holds only some of the sensitive grants of its project", async () => {
      const broad = await newProject("Broad grants");
      const broadHeartbeat = await newHeartbeat(broad, "Broad grant job");
      const caller = await newProject("Chat caller partial");
      await setGrant(broad, health.id, "read");
      await setGrant(broad, otherSensitiveId, "read");
      await setGrant(caller, health.id, "read");
      const run = await chatRun(caller);

      expect(listedIds(await list(run))).not.toContain(broadHeartbeat);

      await setGrant(caller, otherSensitiveId, "read");
      expect(listedIds(await list(run))).toContain(broadHeartbeat);
    });

    it("applies the same rule to heartbeat.history: not found without the grant, the runs with it", async () => {
      const medical = await newProject("Medical history");
      const medicalHeartbeat = await newHeartbeat(medical, "History job");
      const medicalRun = await startHeartbeatRun(medical, medicalHeartbeat, "lab values summarised");
      const caller = await newProject("Chat caller history");
      await setGrant(medical, health.id, "read");
      const run = await chatRun(caller);

      expect(await history(run, medicalHeartbeat)).toEqual({
        error: true,
        result: `Heartbeat ${medicalHeartbeat} not found`,
      });

      await setGrant(caller, health.id, "read");
      const entries = z.array(historyEntrySchema).parse(JSON.parse((await history(run, medicalHeartbeat)).result));
      expect(entries).toEqual([{ id: medicalRun, status: "done", result: "lab values summarised" }]);
    });
  });

  describe("heartbeat.history", () => {
    it("gives a chat run the runs of another project's heartbeat", async () => {
      const garden = await newProject("History garden");
      const gardenHeartbeat = await newHeartbeat(garden, "History garden job");
      const gardenRun = await startHeartbeatRun(garden, gardenHeartbeat, "watered");
      const run = await chatRun(semprecProjectId);

      const outcome = await history(run, gardenHeartbeat);

      expect(outcome.error).toBe(false);
      expect(z.array(historyEntrySchema).parse(JSON.parse(outcome.result))).toEqual([
        { id: gardenRun, status: "done", result: "watered" },
      ]);
    });

    it("answers another tenant's heartbeat id and an unknown id for a chat run with the same not-found error", async () => {
      const foreignProject = await runInTenant(tenantB, () => createTestProjectItem(dataPool));
      const foreignHeartbeat = await newHeartbeat(foreignProject, "Tenant B history job", tenantB);
      const unknown = "00000000-0000-4000-8000-0000000000aa";
      const run = await chatRun(semprecProjectId);

      expect(await history(run, foreignHeartbeat)).toEqual({
        error: true,
        result: `Heartbeat ${foreignHeartbeat} not found`,
      });
      expect(await history(run, unknown)).toEqual({ error: true, result: `Heartbeat ${unknown} not found` });
    });

    it("keeps a run that is not a chat run on its own project: another project's heartbeat id is not found", async () => {
      const garden = await newProject("History own only");
      const other = await newProject("History other");
      const otherHeartbeat = await newHeartbeat(other, "Other project job");
      await startHeartbeatRun(other, otherHeartbeat, "done elsewhere");
      const itemRun = await runOnThread(garden, null);

      expect(await history(itemRun, otherHeartbeat)).toEqual({
        error: true,
        result: `Heartbeat ${otherHeartbeat} not found`,
      });
    });
  });

  describe("heartbeat.trigger", () => {
    it("answers another project's heartbeat from a chat run with the not-found error and enqueues nothing", async () => {
      const garden = await newProject("Trigger garden");
      const gardenHeartbeat = await newHeartbeat(garden, "Trigger garden job");
      const run = await chatRun(semprecProjectId);

      expect(await trigger(run, gardenHeartbeat)).toEqual({
        error: true,
        result: `Heartbeat ${gardenHeartbeat} not found`,
      });
      expect(await pendingManualFireJobs(gardenHeartbeat)).toBe(0);
    });

    it("still triggers a heartbeat of the chat run's own project", async () => {
      const caller = await newProject("Trigger caller");
      const ownHeartbeat = await newHeartbeat(caller, "Trigger own job");
      const run = await chatRun(caller);

      expect(await trigger(run, ownHeartbeat)).toEqual({
        error: false,
        result: JSON.stringify({ heartbeatId: ownHeartbeat }),
      });
      expect(await pendingManualFireJobs(ownHeartbeat)).toBe(1);
    });
  });
});
