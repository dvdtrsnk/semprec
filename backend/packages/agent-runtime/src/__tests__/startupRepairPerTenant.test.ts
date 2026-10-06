import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import { createAgentRun, createUser, insertAgentRunEvent, withTransaction } from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import { repairInterruptedRuns } from "../startupRepair.js";

let adminPool: Pool;
let runtimePool: Pool;
let tenantZero: string;
let tenantB: string;

interface SeededRuns {
  orphanId: string;
  mcpId: string;
}

/** Creates, inside `tenantId`, one running session run ending in an unpaired tool_use plus one running mcp run. */
async function seedTenant(tenantId: string): Promise<SeededRuns> {
  const user = await createUser(adminPool, {
    email: `${tenantId}@example.test`,
    passwordHash: "not-a-real-hash",
    locale: "en",
    tenantId,
  });
  return runInTenant(tenantId, () =>
    withTransaction(runtimePool, async (client) => {
      const orphan = await createAgentRun(client, { triggeredBy: "user", task: "orphan", userId: user.id });
      await insertAgentRunEvent(client, orphan.id, "tool_use", { kind: "tool_use", tool: "search", toolCallId: "c1" });
      const mcp = await createAgentRun(client, { triggeredBy: "mcp", task: "mcp", userId: user.id });
      return { orphanId: orphan.id, mcpId: mcp.id };
    }),
  );
}

async function runState(id: string): Promise<{ status: string; result: string | null; tenant_id: string }> {
  const { rows } = await adminPool.query<{ status: string; result: string | null; tenant_id: string }>(
    "SELECT status, result, tenant_id FROM agent_runs WHERE id = $1",
    [id],
  );
  return rows[0]!;
}

async function toolResults(id: string): Promise<{ tenant_id: string }[]> {
  const { rows } = await adminPool.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'tool_result'",
    [id],
  );
  return rows;
}

describe("repairInterruptedRuns across tenants", () => {
  beforeEach(async () => {
    adminPool ??= getTestPool();
    await resetDatabase(adminPool);
    runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
    tenantZero = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
  });

  afterEach(async () => {
    await adminPool.query("DROP TRIGGER IF EXISTS fail_events_insert ON agent_run_events");
    await adminPool.query("DROP FUNCTION IF EXISTS fail_events_insert()");
    await runtimePool?.end();
  });

  afterAll(async () => {
    await adminPool?.end();
  });

  it("repairs every active tenant's orphaned run with no ambient scope and leaves mcp runs running", async () => {
    const zero = await seedTenant(tenantZero);
    const b = await seedTenant(tenantB);

    const { repairedRunIds } = await repairInterruptedRuns(runtimePool);

    expect(new Set(repairedRunIds)).toEqual(new Set([zero.orphanId, b.orphanId]));
    expect(repairedRunIds).toHaveLength(2);
    for (const [seed, tenant] of [
      [zero, tenantZero],
      [b, tenantB],
    ] as const) {
      expect(await runState(seed.orphanId)).toMatchObject({ status: "error", result: "interrupted_by_restart" });
      expect(await toolResults(seed.orphanId)).toEqual([{ tenant_id: tenant }]);
      expect((await runState(seed.mcpId)).status).toBe("running");
    }
  });

  it("repairs the other tenants when one tenant's repair fails, then rejects", async () => {
    const zero = await seedTenant(tenantZero);
    const b = await seedTenant(tenantB);
    await adminPool.query(`
      CREATE FUNCTION fail_events_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.agent_run_id = '${b.orphanId}' THEN RAISE EXCEPTION 'boom'; END IF;
        RETURN NEW;
      END $$`);
    await adminPool.query(
      "CREATE TRIGGER fail_events_insert BEFORE INSERT ON agent_run_events FOR EACH ROW EXECUTE FUNCTION fail_events_insert()",
    );

    const failure = await repairInterruptedRuns(runtimePool).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(1);
    expect(await runState(zero.orphanId)).toMatchObject({ status: "error", result: "interrupted_by_restart" });
    expect(await toolResults(zero.orphanId)).toHaveLength(1);
    expect((await runState(b.orphanId)).status).toBe("running");
    expect(await toolResults(b.orphanId)).toEqual([]);
  });

  it("leaves a suspended tenant's running run alone", async () => {
    const suspended = await createTestTenant(adminPool, { status: "suspended" });
    const seed = await seedTenant(suspended);

    const { repairedRunIds } = await repairInterruptedRuns(runtimePool);

    expect(repairedRunIds).toEqual([]);
    expect((await runState(seed.orphanId)).status).toBe("running");
    expect(await toolResults(seed.orphanId)).toEqual([]);
  });

  it("resolves with no ids when two tenants have no running runs", async () => {
    await expect(repairInterruptedRuns(runtimePool)).resolves.toEqual({ repairedRunIds: [] });
  });
});
