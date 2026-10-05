import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getOrCreateTenantDataKey, getTenantDataKey } from "../credentials/tenantKeysStore.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

let pool: Pool;
let sidePool: Pool;

async function countKeys(tenantId?: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM tenant_keys WHERE $1::uuid IS NULL OR tenant_id = $1",
    [tenantId ?? null],
  );
  return Number(rows[0]?.n);
}

describe("tenant data key store", () => {
  beforeAll(async () => {
    pool = getTestPool();
    sidePool = await createRuntimeRolePool(pool, "semprec_side");
  });

  afterAll(async () => {
    await sidePool?.end();
    await pool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  it("creates one key with master key version 1 and returns the same key afterwards", async () => {
    const tenantId = getTenantZeroId();
    const first = await getOrCreateTenantDataKey(pool);
    expect(first.tenantId).toBe(tenantId);
    expect(first.dataKey).toHaveLength(32);
    const { rows } = await pool.query<{ master_key_version: number }>("SELECT master_key_version FROM tenant_keys");
    expect(rows).toEqual([{ master_key_version: 1 }]);

    const second = await getOrCreateTenantDataKey(pool);
    expect(second.dataKey.equals(first.dataKey)).toBe(true);
    expect(await countKeys()).toBe(1);
  });

  it("returns null from getTenantDataKey before a key exists", async () => {
    expect(await getTenantDataKey(pool)).toBeNull();
  });

  it("converges concurrent creators on one key", async () => {
    const tenantId = await createTestTenant(pool);
    const [a, b, c] = await Promise.all(
      [0, 1, 2].map(() => withTenantTransaction(pool, tenantId, (client) => getOrCreateTenantDataKey(client))),
    );
    expect(a?.dataKey.equals(b?.dataKey ?? Buffer.alloc(0))).toBe(true);
    expect(a?.dataKey.equals(c?.dataKey ?? Buffer.alloc(0))).toBe(true);
    expect(await countKeys()).toBe(1);
  });

  it("gives each tenant its own key and never shows one tenant another's", async () => {
    const tenantA = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    const keyA = await withTenantTransaction(pool, tenantA, (c) => getOrCreateTenantDataKey(c));
    const keyB = await withTenantTransaction(pool, tenantB, (c) => getOrCreateTenantDataKey(c));
    expect(keyA.dataKey.equals(keyB.dataKey)).toBe(false);
    expect(keyB.tenantId).toBe(tenantB);

    const seenInB = await withTenantTransaction(pool, tenantB, (c) => getTenantDataKey(c));
    expect(seenInB?.tenantId).toBe(tenantB);
    expect(seenInB?.dataKey.equals(keyA.dataKey)).toBe(false);

    const sideRows = await withTenantTransaction(sidePool, tenantB, (c) =>
      c.query<{ tenant_id: string }>("SELECT tenant_id FROM tenant_keys"),
    );
    expect(sideRows.rows).toEqual([{ tenant_id: tenantB }]);
  });

  it("throws when another tenant's wrapped key sits in the row", async () => {
    const tenantA = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    await withTenantTransaction(pool, tenantA, (c) => getOrCreateTenantDataKey(c));
    await withTenantTransaction(pool, tenantB, (c) => getOrCreateTenantDataKey(c));
    await pool.query(
      `UPDATE tenant_keys SET (wrapped_key, wrap_nonce) =
         (SELECT wrapped_key, wrap_nonce FROM tenant_keys WHERE tenant_id = $1)
       WHERE tenant_id = $2`,
      [tenantA, tenantB],
    );
    await expect(withTenantTransaction(pool, tenantB, (c) => getTenantDataKey(c))).rejects.toThrow(
      "Failed to open sealed secret",
    );
  });

  it("refuses to create a key with two tenants and no scope", async () => {
    await createTestTenant(pool);
    await expect(getOrCreateTenantDataKey(pool)).rejects.toThrow(
      "No tenant scope: refusing to create a tenant data key",
    );
    expect(await countKeys()).toBe(0);
  });

  it("lets semprec_side select, insert and delete its own rows but not update", async () => {
    const tenantId = await createTestTenant(pool);
    await withTenantTransaction(sidePool, tenantId, async (c) => {
      await c.query(
        "INSERT INTO tenant_keys (wrapped_key, wrap_nonce, master_key_version) VALUES ('\\x00', '\\x00', 1)",
      );
      const { rows } = await c.query("SELECT tenant_id FROM tenant_keys");
      expect(rows).toHaveLength(1);
    });
    await expect(
      withTenantTransaction(sidePool, tenantId, (c) => c.query("UPDATE tenant_keys SET master_key_version = 2")),
    ).rejects.toMatchObject({ code: "42501" });
    await withTenantTransaction(sidePool, tenantId, async (c) => {
      const result = await c.query("DELETE FROM tenant_keys");
      expect(result.rowCount).toBe(1);
    });
    expect(await countKeys(tenantId)).toBe(0);
  });
});
