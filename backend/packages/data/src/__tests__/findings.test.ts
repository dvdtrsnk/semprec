import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { publishFinding, resolveFindingsNotIn } from "../notifications/findings.js";

const KIND = "unknownHeartbeatAction";

class RollbackSentinel extends Error {}

let pool: Pool;
let tenantZero: string;

/** Runs `fn` in a transaction that is always rolled back, with a second active tenant present. */
async function inTwoTenants(fn: (client: PoolClient, tenantB: string) => Promise<void>): Promise<void> {
  try {
    await withTransaction(pool, async (client) => {
      await client.query("DROP INDEX IF EXISTS tenants_single_tenant_guard");
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO tenants (status) VALUES ('active') RETURNING id",
      );
      await fn(client, rows[0]?.id ?? "");
      throw new RollbackSentinel();
    });
  } catch (error) {
    if (!(error instanceof RollbackSentinel)) throw error;
  }
}

async function scopeTo(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

async function activeFindings(client: PoolClient, dedupeKey: string) {
  const { rows } = await client.query<{ tenant_id: string; payload: Record<string, unknown> }>(
    "SELECT tenant_id, payload FROM manifest_drift_findings WHERE kind = $1 AND dedupe_key = $2 AND resolved_at IS NULL ORDER BY tenant_id",
    [KIND, dedupeKey],
  );
  return rows;
}

describe("manifest drift findings per tenant", () => {
  beforeAll(async () => {
    pool = getTestPool();
    await resetDatabase(pool);
    tenantZero = getTenantZeroId();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("keeps exactly one active row when the same finding is published twice", async () => {
    await withTransaction(pool, async (client) => {
      await publishFinding(client, { kind: KIND, dedupeKey: "replay", payload: { n: 1 } });
      await publishFinding(client, { kind: KIND, dedupeKey: "replay", payload: { n: 2 } });
      const rows = await activeFindings(client, "replay");
      expect(rows).toEqual([{ tenant_id: tenantZero, payload: { n: 1 } }]);
      await client.query("DELETE FROM manifest_drift_findings WHERE dedupe_key = 'replay'");
    });
  });

  it("gives tenant B its own active row for a key tenant zero has active once the legacy index is gone", async () => {
    await inTwoTenants(async (client, tenantB) => {
      await scopeTo(client, tenantZero);
      await publishFinding(client, { kind: KIND, dedupeKey: "shared", payload: { by: "zero" } });
      await client.query("DROP INDEX manifest_drift_findings_active_idx");
      await scopeTo(client, tenantB);
      await publishFinding(client, { kind: KIND, dedupeKey: "shared", payload: { by: "b" } });

      const rows = await activeFindings(client, "shared");
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.tenant_id === tenantZero)?.payload).toEqual({ by: "zero" });
      expect(rows.find((r) => r.tenant_id === tenantB)?.payload).toEqual({ by: "b" });
    });
  });

  it("rejects tenant B's publish with 23505 while the legacy index still exists", async () => {
    await inTwoTenants(async (client, tenantB) => {
      await scopeTo(client, tenantZero);
      await publishFinding(client, { kind: KIND, dedupeKey: "shared", payload: { by: "zero" } });
      await scopeTo(client, tenantB);
      await client.query("SAVEPOINT collision");
      await expect(
        publishFinding(client, { kind: KIND, dedupeKey: "shared", payload: { by: "b" } }),
      ).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT collision");
      expect(await activeFindings(client, "shared")).toEqual([{ tenant_id: tenantZero, payload: { by: "zero" } }]);
    });
  });

  it("resolves only the current tenant's findings", async () => {
    await inTwoTenants(async (client, tenantB) => {
      await scopeTo(client, tenantZero);
      await publishFinding(client, { kind: KIND, dedupeKey: "x", payload: {} });
      await scopeTo(client, tenantB);
      await publishFinding(client, { kind: KIND, dedupeKey: "y", payload: {} });

      await client.query("SET LOCAL ROLE semprec_side");
      await resolveFindingsNotIn(client, KIND, new Set());
      await client.query("RESET ROLE");

      expect(await activeFindings(client, "y")).toEqual([]);
      expect(await activeFindings(client, "x")).toHaveLength(1);
    });
  });
});
