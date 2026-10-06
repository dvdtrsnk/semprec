import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { ensureQueueSchema, enqueueJob, registerTask, runOnce, runWorker, type TaskList } from "@semprec/queue";
import { createPool, withTransaction } from "../db/pool.js";
import { getTenantZeroId, resetDatabase } from "../testSupport/testDb.js";

const TASK = "tenantEnvelopeProbe";

let pool: Pool;
const originalMode = process.env.SEMPREC_TENANT_SCOPE;

function probeTaskList(observed: Array<string | null>): TaskList {
  return {
    [TASK]: registerTask(TASK, async () => {
      const tenant = await withTransaction(pool, async (client) => {
        const { rows } = await client.query<{ tenant: string | null }>("SELECT app_current_tenant()::text AS tenant");
        return rows[0]?.tenant ?? null;
      });
      observed.push(tenant);
    }),
  };
}

async function probeJobCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE task_identifier = $1",
    [TASK],
  );
  return Number(rows[0]?.count);
}

describe("queue tenant envelope", () => {
  beforeAll(() => {
    pool = createPool(process.env.TEST_DATABASE_URL!);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
    else process.env.SEMPREC_TENANT_SCOPE = originalMode;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("stores the producer's tenant in the envelope and restores it for the handler", async () => {
    const tenantZero = getTenantZeroId();
    await runInTenant(tenantZero, () => enqueueJob(pool, TASK, { a: 1 }));

    const { rows } = await pool.query<{ payload: { tenantId?: string } }>(
      `SELECT j.payload FROM graphile_worker._private_jobs j
       JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = $1`,
      [TASK],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.tenantId).toBe(tenantZero);

    const observed: Array<string | null> = [];
    await runOnce({ pgPool: pool }, probeTaskList(observed));
    expect(observed).toEqual([tenantZero]);
    expect(await probeJobCount()).toBe(0);
  });

  it("completes a suspended tenant's job without calling the handler", async () => {
    const tenantZero = getTenantZeroId();
    await runInTenant(tenantZero, () => enqueueJob(pool, TASK, {}));
    await pool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenantZero]);

    const observed: Array<string | null> = [];
    try {
      await runOnce({ pgPool: pool }, probeTaskList(observed));
    } finally {
      await pool.query("UPDATE tenants SET status = 'active' WHERE id = $1", [tenantZero]);
    }
    expect(observed).toEqual([]);
    expect(await probeJobCount()).toBe(0);
  });

  it("completes an unknown tenant's job without calling the handler", async () => {
    await runInTenant(randomUUID(), () => enqueueJob(pool, TASK, {}));

    const observed: Array<string | null> = [];
    await runOnce({ pgPool: pool }, probeTaskList(observed));
    expect(observed).toEqual([]);
    expect(await probeJobCount()).toBe(0);
  });

  it("runs ensureQueueSchema, runWorker and the runner's stop() with no scope in strict mode", async () => {
    process.env.SEMPREC_TENANT_SCOPE = "strict";
    await ensureQueueSchema(pool);

    const observed: Array<string | null> = [];
    const runner = await runWorker({ pgPool: pool, taskList: probeTaskList(observed), noHandleSignals: true });
    await runner.stop();
    expect(observed).toEqual([]);
  });
});
