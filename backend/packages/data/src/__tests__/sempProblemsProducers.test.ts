import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { enqueueJob } from "@semprec/queue";
import { runAsSystem } from "@semprec/shared";
import {
  createTestTenant,
  createTestProjectItem,
  getTenantZeroId,
  getTestPool,
  inTenantZero,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { upsertProcessHeartbeat } from "../health/processHeartbeats.js";
import {
  enqueueLibraryMetadataProcessing,
  handleProcessLibraryMetadataTask,
  type LibraryMetadataFetcher,
} from "../library/libraryMetadataJob.js";
import { getItemAutomation } from "../library/itemAutomationStore.js";
import { handleObservabilityCheckSystemTask } from "../observability/observabilityCheckSystem.js";
import { recordRestoreTestResult } from "../observability/restoreTestResult.js";
import { createGuidanceProblemWriter } from "../semp/guidanceProblemWriter.js";
import {
  AGENTS_PROCESS_PROBLEM_KEY,
  BACKUP_RESTORE_PROBLEM_KEY,
  automationProblemKey,
  guidanceProblemKey,
} from "../semp/sourceProblemKeys.js";

let pool: Pool;
let chokePoint: ChokePoint;

async function createTestUser(tenantId = getTenantZeroId(), role: "admin" | "member" = "admin"): Promise<string> {
  const passwordHash = await hashPassword("s3cret-password");
  const user = await createUser(pool, {
    email: `${randomUUID()}@example.test`,
    passwordHash,
    locale: "en",
    tenantId,
    role,
  });
  return user.id;
}

interface ProblemRow {
  user_id: string;
  category: string;
  kind: string;
  severity: string;
  dedupe_key: string;
  occurrence_count: number;
  source_table: string;
  project_item_id: string | null;
  resolved_at: Date | null;
}

async function listProblems(): Promise<ProblemRow[]> {
  const { rows } = await pool.query<ProblemRow>(
    `SELECT user_id, category, kind, severity, dedupe_key, occurrence_count, source_table, project_item_id, resolved_at
       FROM semp_problems ORDER BY dedupe_key, user_id`,
  );
  return rows;
}

async function markAllProcessesFresh(): Promise<void> {
  for (const process of ["api", "agents", "transcribe", "ai-gateway"]) {
    await upsertProcessHeartbeat(pool, { process, pid: 1, version: "1.0.0" }, new Date());
  }
}

async function makeStale(process: string): Promise<void> {
  await pool.query(`UPDATE process_heartbeats SET beat_at = now() - interval '5 minutes' WHERE process = $1`, [
    process,
  ]);
}

function runCheck(): Promise<void> {
  return runAsSystem("test", () => handleObservabilityCheckSystemTask(pool, { job: { id: randomUUID() } }));
}

describe("semp problem producers (issue #1465)", () => {
  beforeAll(() => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await pool.query("DELETE FROM tenant_observability_checks");
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("guidance drift", () => {
    async function raiseDrift(userId: string, projectItemId: string, fingerprint: string, occurrenceKey: string) {
      await withTenantTransaction(pool, getTenantZeroId(), (client) =>
        createGuidanceProblemWriter().raise(client, {
          userId,
          projectItemId,
          fingerprint,
          findingId: randomUUID(),
          occurrenceKey,
        }),
      );
    }

    it("gives one problem for two activations of one finding and one more for a different finding", async () => {
      const userId = await createTestUser();
      const projectItemId = await createTestProjectItem(pool);
      await raiseDrift(userId, projectItemId, "fp-a", "fp-a:2026-02-01T00:00:00.000Z");
      await raiseDrift(userId, projectItemId, "fp-a", "fp-a:2026-02-02T00:00:00.000Z");
      await raiseDrift(userId, projectItemId, "fp-b", "fp-b:2026-02-02T00:00:00.000Z");

      const problems = await listProblems();
      expect(problems).toMatchObject([
        {
          dedupe_key: guidanceProblemKey(projectItemId, "fp-a"),
          category: "guidance",
          kind: "guidanceDrift",
          severity: "warning",
          source_table: "agent_guidance_drift_findings",
          project_item_id: projectItemId,
          occurrence_count: 2,
        },
        { dedupe_key: guidanceProblemKey(projectItemId, "fp-b"), occurrence_count: 1 },
      ]);
    });

    it("leaves no problem when the surrounding transaction rolls back", async () => {
      const userId = await createTestUser();
      const projectItemId = await createTestProjectItem(pool);
      await expect(
        withTenantTransaction(pool, getTenantZeroId(), async (client) => {
          await createGuidanceProblemWriter().raise(client, {
            userId,
            projectItemId,
            fingerprint: "fp-a",
            findingId: randomUUID(),
            occurrenceKey: "k",
          });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await listProblems()).toEqual([]);
    });
  });

  describe("library automation", () => {
    const failingFetcher: LibraryMetadataFetcher = async () => {
      throw new Error("source unavailable");
    };

    async function failJob(databaseId: string, itemId: string, jobId: string) {
      const payload = { itemId, databaseId, config: { source: "tmdb", coverKey: "cover" } };
      await inTenantZero(() =>
        withTenantTransaction(pool, getTenantZeroId(), async (client) => {
          if (!(await getItemAutomation(client, itemId))) await enqueueLibraryMetadataProcessing(client, payload);
        }),
      );
      await expect(
        handleProcessLibraryMetadataTask(pool, payload, failingFetcher, { job: { id: jobId } }),
      ).rejects.toThrow("Library metadata processing failed");
    }

    async function moviesDatabaseId(): Promise<string> {
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'movies'");
      return rows[0]!.id;
    }

    it("gives one problem for three failing jobs of one database", async () => {
      await seedSystem(pool);
      await createTestUser();
      const databaseId = await moviesDatabaseId();
      for (const [index, name] of ["A", "B", "C"].entries()) {
        const item = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name } }));
        await failJob(databaseId, item.id, `job-${index}`);
      }

      expect(await listProblems()).toMatchObject([
        {
          dedupe_key: automationProblemKey(databaseId),
          category: "automation",
          kind: "libraryAutomation",
          severity: "warning",
          source_table: "item_automation",
          occurrence_count: 3,
        },
      ]);
    });

    it("does not count a redelivery of the same job twice", async () => {
      await seedSystem(pool);
      await createTestUser();
      const databaseId = await moviesDatabaseId();
      const item = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "A" } }));
      await failJob(databaseId, item.id, "job-1");
      await failJob(databaseId, item.id, "job-1");
      expect((await listProblems())[0]?.occurrence_count).toBe(1);
    });
  });

  describe("operator alerts", () => {
    it("gives each administrator a critical backup problem for a failed restore test and a member none", async () => {
      const adminZero = await createTestUser();
      const otherTenant = await createTestTenant(pool);
      const adminOther = await createTestUser(otherTenant, "admin");
      // One user per tenant, so the member lives in a tenant of its own.
      const member = await createTestUser(await createTestTenant(pool), "member");

      await runAsSystem("test", () =>
        recordRestoreTestResult(pool, { runId: "run-20260101T000000Z", status: "failed", failedCheck: "itemsCount" }),
      );

      const problems = await listProblems();
      expect(problems.map((p) => p.user_id).sort()).toEqual([adminZero, adminOther].sort());
      for (const problem of problems) {
        expect(problem).toMatchObject({
          dedupe_key: BACKUP_RESTORE_PROBLEM_KEY,
          category: "backup",
          kind: "backupRestore",
          severity: "critical",
          source_table: "observability_checks",
          occurrence_count: 1,
        });
      }
      expect(problems.some((p) => p.user_id === member)).toBe(false);
    });

    it("raises nothing for a passed restore test", async () => {
      await createTestUser();
      await runAsSystem("test", () =>
        recordRestoreTestResult(pool, { runId: "run-20260101T000000Z", status: "passed" }),
      );
      expect(await listProblems()).toEqual([]);
    });

    it("gives administrators a critical agents problem when the agents process goes stale", async () => {
      const admin = await createTestUser();
      await createTestUser(await createTestTenant(pool), "member");
      await markAllProcessesFresh();
      await makeStale("agents");

      await runCheck();
      expect(await listProblems()).toMatchObject([
        {
          user_id: admin,
          dedupe_key: AGENTS_PROCESS_PROBLEM_KEY,
          category: "agents",
          kind: "processStale",
          severity: "critical",
          occurrence_count: 1,
        },
      ]);
    });

    it("raises nothing for another stale process", async () => {
      await createTestUser();
      await markAllProcessesFresh();
      await makeStale("transcribe");

      await runCheck();
      const { rows } = await pool.query(`SELECT 1 FROM notifications WHERE kind = 'process_stale'`);
      expect(rows).toHaveLength(1);
      expect(await listProblems()).toEqual([]);
    });

    it("raises nothing for queue_backlog", async () => {
      await createTestUser();
      await markAllProcessesFresh();
      for (let i = 0; i < 101; i += 1) {
        await enqueueJob(pool, "someUnregisteredTask", { i });
      }

      await runCheck();
      const { rows } = await pool.query(`SELECT 1 FROM notifications WHERE kind = 'queue_backlog'`);
      expect(rows).toHaveLength(1);
      expect(await listProblems()).toEqual([]);
    });
  });
});
