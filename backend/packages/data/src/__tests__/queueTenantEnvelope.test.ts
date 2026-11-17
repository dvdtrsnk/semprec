import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant, withTraceContext } from "@semprec/shared";
import {
  addPreparedJob,
  assertSearchTaskIdentifiersRegistered,
  ensureQueueSchema,
  enqueueJob,
  prepareJob,
  registerTask,
  runOnce,
  runWorker,
  SEARCH_TASK_IDENTIFIERS,
  type TaskList,
} from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
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

    const payloads = await readJobPayloadsByIdentifier(pool, TASK);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ tenantId: tenantZero });

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

  it("keeps a prepared job's own tenant and trace when another scope adds it (R1 D1)", async () => {
    const tenantZero = getTenantZeroId();
    const traceId = randomUUID();
    const job = runInTenant(tenantZero, () =>
      withTraceContext({ traceId }, () => prepareJob(TASK, { a: 1 }, { jobKey: "prepared-probe" })),
    );
    await runInTenant(randomUUID(), () => withTraceContext({ traceId: randomUUID() }, () => addPreparedJob(pool, job)));

    expect(await readJobPayloadsByIdentifier(pool, TASK)).toEqual([
      { traceId, tenantId: tenantZero, payload: { a: 1 } },
    ]);
    const observed: Array<string | null> = [];
    await runOnce({ pgPool: pool }, probeTaskList(observed));
    expect(observed).toEqual([tenantZero]);
  });

  it("registers the search task identifiers idempotently, without a job, also beside a worker's own registration (R1 D1)", async () => {
    const jobsBefore = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM graphile_worker.jobs");
    await ensureQueueSchema(pool);
    await ensureQueueSchema(pool);
    await expect(assertSearchTaskIdentifiersRegistered(pool)).resolves.toBeUndefined();

    // A worker registers the identifiers of its own task list on its first fetch; with nothing
    // queued its handlers never run.
    const ran: string[] = [];
    const searchTaskList: TaskList = Object.fromEntries(
      SEARCH_TASK_IDENTIFIERS.map((identifier) => [
        identifier,
        registerTask(identifier, async () => {
          ran.push(identifier);
        }),
      ]),
    );
    await Promise.all([ensureQueueSchema(pool), runOnce({ pgPool: pool }, searchTaskList)]);
    await expect(assertSearchTaskIdentifiersRegistered(pool)).resolves.toBeUndefined();
    expect(ran).toEqual([]);
    const jobsAfter = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM graphile_worker.jobs");
    expect(jobsAfter.rows).toEqual(jobsBefore.rows);
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
