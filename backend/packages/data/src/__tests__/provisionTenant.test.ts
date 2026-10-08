import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createPool, withTransaction } from "../db/pool.js";
import { createDatabase, getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { runSeed } from "../db/runSeed.js";
import { provisionTenant } from "../index.js";
import { seedSystem } from "../seed/seedSystem.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import { createTestTenant, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let adminPool: Pool;
let dataPool: Pool;

const B_MODULES = [SYSTEM_SETTINGS_MODULE_ID, "projects", "tasks", "emails", "mcpServers", "inbox"];

async function counts(tenantId: string): Promise<{ databases: number; items: number; migrations: number }> {
  const { rows } = await adminPool.query<{ databases: number; items: number; migrations: number }>(
    `SELECT (SELECT count(*)::int FROM databases WHERE tenant_id = $1) AS databases,
            (SELECT count(*)::int FROM items WHERE tenant_id = $1) AS items,
            (SELECT count(*)::int FROM module_migrations WHERE tenant_id = $1) AS migrations`,
    [tenantId],
  );
  return rows[0] ?? { databases: -1, items: -1, migrations: -1 };
}

async function statusOf(tenantId: string): Promise<{ status: string; changedAt: Date }> {
  const { rows } = await adminPool.query<{ status: string; changed_at: Date }>(
    "SELECT status, status_changed_at AS changed_at FROM tenants WHERE id = $1",
    [tenantId],
  );
  const row = rows[0];
  if (!row) throw new Error("tenant row missing");
  return { status: row.status, changedAt: row.changed_at };
}

async function moduleIdsIn(tenantId: string): Promise<Array<string | null>> {
  return runInTenant(tenantId, () =>
    withTransaction(dataPool, async (client) => {
      const found: Array<string | null> = [];
      for (const moduleId of B_MODULES) {
        found.push((await getDatabaseByModuleId(client, moduleId))?.id ?? null);
      }
      return found;
    }),
  );
}

describe("provisionTenant (issue #1005)", () => {
  beforeAll(() => {
    adminPool = getTestPool();
    dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  it("runs every connection of a role pool as semprec_data under row-level security", async () => {
    const { rows } = await dataPool.query<{ user: string; active: boolean }>(
      "SELECT current_user AS user, row_security_active('public.databases') AS active",
    );
    expect(rows[0]).toEqual({ user: "semprec_data", active: true });
  });

  it("provisions a provisioning tenant in its own scope and activates it", async () => {
    const zero = getTenantZeroId();
    await runInTenant(zero, () => seedSystem(dataPool));
    const zeroBefore = await counts(zero);
    const b = await createTestTenant(adminPool, { status: "provisioning" });
    const before = await statusOf(b);

    await expect(provisionTenant(dataPool, b)).resolves.toBe("created");

    const bIds = await moduleIdsIn(b);
    expect(bIds.every((id) => id !== null)).toBe(true);
    const after = await statusOf(b);
    expect(after.status).toBe("active");
    expect(after.changedAt.getTime()).toBeGreaterThan(before.changedAt.getTime());

    const zeroIds = await moduleIdsIn(zero);
    expect(zeroIds.every((id) => id !== null)).toBe(true);
    expect(zeroIds.filter((id) => bIds.includes(id))).toEqual([]);
    expect(await counts(zero)).toEqual(zeroBefore);
  });

  it("reports already-provisioned on a second call and changes no rows", async () => {
    const b = await createTestTenant(adminPool, { status: "provisioning" });
    await provisionTenant(dataPool, b);
    const before = await counts(b);

    await expect(provisionTenant(dataPool, b)).resolves.toBe("already-provisioned");

    expect(await counts(b)).toEqual(before);
  });

  it("lets exactly one of two concurrent calls create the databases", async () => {
    const b = await createTestTenant(adminPool, { status: "provisioning" });

    const outcomes = await Promise.all([provisionTenant(dataPool, b), provisionTenant(dataPool, b)]);

    expect([...outcomes].sort()).toEqual(["already-provisioned", "created"]);
    const { rows } = await adminPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM databases WHERE tenant_id = $1 AND owner_module_id = $2 AND system",
      [b, SYSTEM_SETTINGS_MODULE_ID],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("records the tenant's module_migrations rows visible only in its own scope", async () => {
    const zero = getTenantZeroId();
    const b = await createTestTenant(adminPool, { status: "provisioning" });
    await provisionTenant(dataPool, b);

    expect((await counts(b)).migrations).toBeGreaterThan(0);
    expect((await counts(zero)).migrations).toBe(0);
    const visibleToZero = await runInTenant(zero, () =>
      dataPool.query<{ n: number }>("SELECT count(*)::int AS n FROM module_migrations"),
    );
    expect(visibleToZero.rows[0]?.n).toBe(0);
    const visibleToB = await runInTenant(b, () =>
      dataPool.query<{ n: number }>("SELECT count(*)::int AS n FROM module_migrations"),
    );
    expect(visibleToB.rows[0]?.n).toBe((await counts(b)).migrations);
  });

  it("seeds a suspended tenant and leaves it suspended", async () => {
    const c = await createTestTenant(adminPool, { status: "suspended" });

    await expect(provisionTenant(dataPool, c)).resolves.toBe("created");

    expect((await statusOf(c)).status).toBe("suspended");
    expect((await counts(c)).databases).toBeGreaterThan(0);
  });

  it("rejects a deleting tenant and an unknown id without writing", async () => {
    const d = await createTestTenant(adminPool, { status: "deleting" });
    const unknown = "00000000-0000-4000-8000-000000000999";

    await expect(provisionTenant(dataPool, d)).rejects.toThrow();
    await expect(provisionTenant(dataPool, unknown)).rejects.toThrow();

    expect((await counts(d)).databases).toBe(0);
    expect((await counts(unknown)).databases).toBe(0);
    expect((await statusOf(d)).status).toBe("deleting");
  });

  it("rejects on a pool RLS does not apply to before writing anything", async () => {
    const b = await createTestTenant(adminPool, { status: "provisioning" });

    await expect(provisionTenant(adminPool, b)).rejects.toThrow(/row-level security/);

    expect((await counts(b)).databases).toBe(0);
    expect((await statusOf(b)).status).toBe("provisioning");
  });

  it("makes seedSystem with no scope reject when two tenants exist, writing nothing", async () => {
    await createTestTenant(adminPool);

    await expect(seedSystem(dataPool)).rejects.toThrow();

    const { rows } = await adminPool.query<{ n: number }>("SELECT count(*)::int AS n FROM databases");
    expect(rows[0]?.n).toBe(0);
  });

  describe("runSeed", () => {
    it("provisions tenant zero, provisioning and suspended tenants and leaves deleting ones", async () => {
      const zero = getTenantZeroId();
      const b = await createTestTenant(adminPool, { status: "provisioning" });
      const c = await createTestTenant(adminPool, { status: "suspended" });
      const d = await createTestTenant(adminPool, { status: "deleting" });

      const results = await runSeed(dataPool);

      expect(results.map((r) => r.tenantId).sort()).toEqual([zero, b, c].sort());
      expect(results.every((r) => r.outcome === "created")).toBe(true);
      expect((await counts(d)).databases).toBe(0);
      expect((await statusOf(b)).status).toBe("active");
      expect((await statusOf(c)).status).toBe("suspended");
      expect((await statusOf(d)).status).toBe("deleting");
    });

    it("provisions the other tenants and rejects with an AggregateError naming the failed one", async () => {
      const zero = getTenantZeroId();
      const b = await createTestTenant(adminPool, { status: "provisioning" });
      const c = await createTestTenant(adminPool, { status: "active" });
      await runInTenant(b, () =>
        withTransaction(dataPool, (client) =>
          createDatabase(client, { name: null, key: "projects", system: true, ownerModuleId: "projects" }),
        ),
      );

      const failure = await runSeed(dataPool).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).message).toContain(b);
      expect((failure as AggregateError).message).not.toContain(c);
      expect((await counts(c)).databases).toBeGreaterThan(0);
      expect((await counts(zero)).databases).toBeGreaterThan(0);
      expect((await statusOf(b)).status).toBe("provisioning");
    });
  });
});
