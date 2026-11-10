import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createRuntimeRolePool, createTestTenant, withTenantTransaction } from "../testSupport/tenantFixtures.js";

/** Issue #1659: `item_origins` rows are tenant-owned and invisible to another tenant's runtime role. */
let adminPool: Pool;
let runtimePool: Pool;

beforeAll(async () => {
  adminPool = getTestPool();
  await resetDatabase(adminPool);
  runtimePool = await createRuntimeRolePool(adminPool, "semprec_side");
});

afterAll(async () => {
  await runtimePool?.end();
  await adminPool?.end();
});

describe("item_origins tenant isolation", () => {
  it("shows tenant A's row to tenant A only, and refuses a write stamped for another tenant", async () => {
    const tenantA = await createTestTenant(adminPool);
    const tenantB = await createTestTenant(adminPool);
    const itemId = randomUUID();
    // Raw insert: this test targets the table's row-level security, not the confirm path that writes it.
    await withTenantTransaction(runtimePool, tenantA, (client) =>
      client.query(
        `INSERT INTO item_origins (item_id, proposal_id, captured_at, capture_channel) VALUES ($1, $2, now(), 'inbox')`,
        [itemId, randomUUID()],
      ),
    );

    const own = await withTenantTransaction(runtimePool, tenantA, (client) =>
      client.query<{ tenant_id: string }>("SELECT tenant_id FROM item_origins WHERE item_id = $1", [itemId]),
    );
    expect(own.rows).toEqual([{ tenant_id: tenantA }]);

    const foreign = await withTenantTransaction(runtimePool, tenantB, (client) =>
      client.query<{ item_id: string }>("SELECT item_id FROM item_origins WHERE item_id = $1", [itemId]),
    );
    expect(foreign.rows).toEqual([]);

    await expect(
      withTenantTransaction(runtimePool, tenantB, (client) =>
        client.query(
          `INSERT INTO item_origins (tenant_id, item_id, proposal_id, captured_at, capture_channel)
           VALUES ($1, $2, $3, now(), 'inbox')`,
          [tenantA, randomUUID(), randomUUID()],
        ),
      ),
    ).rejects.toThrow();
  });
});
