import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { CORE_CRONTAB, createCoreTaskList } from "../../worker.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { SEMP_PROBLEMS_RETENTION_DAYS, handleSempProblemsPruneTask } from "../sempProblemsPrune.js";
import { withTransaction } from "../../db/pool.js";
import { raiseProblem, resolveProblem } from "../sempProblemsStore.js";

let adminPool: Pool;
let pool: Pool;
let tenantZero: string;
let tenantB: string;

async function insertProblem(
  tenantId: string,
  userId: string,
  resolvedDaysAgo: number | null,
  dedupeKey: string = randomUUID(),
): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    `INSERT INTO semp_problems (tenant_id, user_id, category, kind, severity, source_table, source_id, dedupe_key,
                                resolved_at, resolution_kind)
     VALUES ($1, $2, 'mail', 'mailSyncFailed', 'warning', 'mail_account_sync_state', $3, $4,
             CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(days => $5::int) END,
             CASE WHEN $5::int IS NULL THEN NULL ELSE 'recovered' END)
     RETURNING id`,
    [tenantId, userId, randomUUID(), dedupeKey, resolvedDaysAgo],
  );
  return rows[0]!.id;
}

async function userIn(tenantId: string): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    "INSERT INTO users (email, password_hash, tenant_id) VALUES ($1, 'unused', $2) RETURNING id",
    [`${randomUUID()}@example.com`, tenantId],
  );
  return rows[0]!.id;
}

/** Ids left in `tenantId`, read inside that tenant so row-level security applies. */
async function remainingIds(tenantId: string): Promise<string[]> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM semp_problems");
    return rows.map((r) => r.id).sort();
  });
}

describe("handleSempProblemsPruneTask (issue #1558)", () => {
  let userZero: string;
  let userB: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantZero = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
    userZero = await userIn(tenantZero);
    userB = await userIn(tenantB);
  });

  it("deletes a problem resolved 31 days ago and keeps one resolved 29 days ago and an old active one", async () => {
    expect(SEMP_PROBLEMS_RETENTION_DAYS).toBe(30);
    await insertProblem(tenantZero, userZero, 31);
    const recent = await insertProblem(tenantZero, userZero, 29);
    const active = await insertProblem(tenantZero, userZero, null);
    await adminPool.query("UPDATE semp_problems SET first_seen_at = now() - interval '400 days' WHERE id = $1", [
      active,
    ]);

    const result = await runAsSystem("test", () => handleSempProblemsPruneTask(pool));

    expect(result).toEqual({ deleted: 1 });
    expect(await remainingIds(tenantZero)).toEqual([recent, active].sort());
  });

  it("prunes each tenant within its own scope", async () => {
    await insertProblem(tenantZero, userZero, 40, "shared-key");
    await insertProblem(tenantB, userB, 40, "shared-key");
    const keepB = await insertProblem(tenantB, userB, 1);
    const keepZero = await insertProblem(tenantZero, userZero, null);

    const result = await runAsSystem("test", () => handleSempProblemsPruneTask(pool));

    expect(result).toEqual({ deleted: 2 });
    expect(await remainingIds(tenantZero)).toEqual([keepZero]);
    expect(await remainingIds(tenantB)).toEqual([keepB]);
  });

  it("cascades only the pruned episode's occurrence receipts", async () => {
    const create = (tenantId: string, userId: string) =>
      runInTenant(tenantId, () =>
        withTransaction(pool, async (client) => {
          const problem = await raiseProblem(client, {
            userId,
            category: "mail",
            kind: "sync",
            severity: "warning",
            sourceTable: "mail_account_sync_state",
            sourceId: randomUUID(),
            dedupeKey: "receipt-prune",
            occurrenceKey: "job-a",
          });
          await resolveProblem(client, { dedupeKey: "receipt-prune", resolutionKind: "recovered" });
          return problem.problemId;
        }),
      );
    const old = await create(tenantZero, userZero);
    const retained = await create(tenantB, userB);
    await adminPool.query("UPDATE semp_problems SET resolved_at = now() - interval '31 days' WHERE id = $1", [old]);
    expect(await runAsSystem("test", () => handleSempProblemsPruneTask(pool))).toEqual({ deleted: 1 });
    const receipts = await runInTenant(tenantB, () =>
      withTransaction(pool, (client) =>
        client.query<{ problem_id: string }>("SELECT problem_id FROM semp_problem_occurrences"),
      ),
    );
    expect(receipts.rows).toEqual([{ problem_id: retained }]);
    const gone = await runInTenant(tenantZero, () =>
      withTransaction(pool, (client) =>
        client.query("SELECT 1 FROM semp_problem_occurrences WHERE problem_id = $1", [old]),
      ),
    );
    expect(gone.rows).toEqual([]);
  });

  it("leaves a suspended tenant's problems alone", async () => {
    const suspended = await createTestTenant(adminPool, { status: "suspended" });
    const old = await insertProblem(suspended, await userIn(suspended), 40);

    const result = await runAsSystem("test", () => handleSempProblemsPruneTask(pool));

    expect(result).toEqual({ deleted: 0 });
    expect(await remainingIds(suspended)).toEqual([old]);
  });

  it("is scheduled once per day and present in the core task list", () => {
    const lines = CORE_CRONTAB.split("\n").filter((line) => line.endsWith(CORE_TASK_NAMES.SEMP_PROBLEMS_PRUNE));
    expect(lines).toEqual([`30 4 * * * ${CORE_TASK_NAMES.SEMP_PROBLEMS_PRUNE}`]);
    const tasks = createCoreTaskList(pool, createActionRegistry());
    expect(Object.keys(tasks)).toContain(CORE_TASK_NAMES.SEMP_PROBLEMS_PRUNE);
  });
});
