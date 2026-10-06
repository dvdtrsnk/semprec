import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { handleMcpRunCredentialExpirySweepTask } from "../mcp/mcpRunCredentialExpiry.js";
import { mintMcpRunCredential } from "../mcp/mcpRunCredentialAction.js";
import { logger } from "../tenancy/logger.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let adminPool: Pool;
let pool: Pool;
let userId: string;

describe("handleMcpRunCredentialExpirySweepTask runs per tenant (issue #987)", () => {
  let tenantZero: string;
  let tenantB: string;

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
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const { rows } = await adminPool.query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, 'unused') RETURNING id",
      [`${randomUUID()}@example.com`],
    );
    userId = rows[0]!.id;
  });

  /** Mints a run + credential in `tenantId`; expired credentials are backdated. Returns the run id. */
  async function mint(tenantId: string, expired: boolean): Promise<string> {
    return runInTenant(tenantId, async () => {
      const minted = await mintMcpRunCredential(pool, {
        projectItemId: randomUUID(),
        capabilities: ["core.item.read"],
        userId,
      });
      if (expired) {
        await pool.query(
          "UPDATE agent_run_mcp_credentials SET expires_at = now() - interval '1 minute' WHERE agent_run_id = $1",
          [minted.run.id],
        );
      }
      return minted.run.id;
    });
  }

  async function runStatus(runId: string): Promise<string> {
    const { rows } = await adminPool.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [runId]);
    return rows[0]!.status;
  }

  async function runStatusEventTenants(runId: string): Promise<string[]> {
    const { rows } = await adminPool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'run_status'",
      [runId],
    );
    return rows.map((r) => r.tenant_id);
  }

  it("finishes each tenant's expired run, leaves the valid one and stamps events with the run's tenant", async () => {
    const expiredZero = await mint(tenantZero, true);
    const expiredB = await mint(tenantB, true);
    const validB = await mint(tenantB, false);

    const result = await runAsSystem("test", () => handleMcpRunCredentialExpirySweepTask(pool));

    expect([...result.finishedRunIds].sort()).toEqual([expiredZero, expiredB].sort());
    expect(await runStatus(expiredZero)).toBe("done");
    expect(await runStatus(expiredB)).toBe("done");
    expect(await runStatus(validB)).toBe("running");
    expect(await runStatusEventTenants(expiredZero)).toEqual([tenantZero]);
    expect(await runStatusEventTenants(expiredB)).toEqual([tenantB]);
  });

  it("commits tenant zero's run and rejects when tenant B's event insert fails", async () => {
    const expiredZero = await mint(tenantZero, true);
    const expiredB = await mint(tenantB, true);
    // The run id lives in a table, not in the DDL body: DDL cannot take bind parameters.
    await adminPool.query("CREATE TABLE test_reject_run_ids (id uuid PRIMARY KEY)");
    await adminPool.query("INSERT INTO test_reject_run_ids (id) VALUES ($1)", [expiredB]);
    await adminPool.query(`
      CREATE FUNCTION test_reject_run_events() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM test_reject_run_ids WHERE id = NEW.agent_run_id) THEN
          RAISE EXCEPTION 'test-only failure';
        END IF;
        RETURN NEW;
      END $$`);
    await adminPool.query(
      "CREATE TRIGGER test_reject_run_events BEFORE INSERT ON agent_run_events FOR EACH ROW EXECUTE FUNCTION test_reject_run_events()",
    );

    try {
      const err: unknown = await runAsSystem("test", () => handleMcpRunCredentialExpirySweepTask(pool)).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors).toHaveLength(1);
      expect(await runStatus(expiredZero)).toBe("done");
      expect(await runStatus(expiredB)).toBe("running");
    } finally {
      await adminPool.query("DROP TRIGGER test_reject_run_events ON agent_run_events");
      await adminPool.query("DROP FUNCTION test_reject_run_events()");
      await adminPool.query("DROP TABLE test_reject_run_ids");
    }
  });

  it("leaves a suspended tenant's expired run running", async () => {
    const suspended = await createTestTenant(adminPool, { status: "suspended" });
    const expired = await mint(suspended, true);

    const result = await runAsSystem("test", () => handleMcpRunCredentialExpirySweepTask(pool));

    expect(result).toEqual({ finishedRunIds: [] });
    expect(await runStatus(expired)).toBe("running");
  });
});
