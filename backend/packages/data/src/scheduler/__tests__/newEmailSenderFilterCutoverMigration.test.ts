import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createPool } from "../../db/pool.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createTestTenant, getTenantZeroId, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
let admin: Pool;
let data: Pool;
let fresh: string;
let old: string;
async function heartbeat(tenant: string) {
  return runInTenant(tenant, async () => {
    const result = await data.query<{ id: string; action_config: unknown }>(
      "SELECT id, action_config FROM project_heartbeats WHERE name = 'newEmail'",
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!;
  });
}
describe("newEmail sender filter tenant cutover", () => {
  beforeAll(() => {
    admin = getTestPool();
    data = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    fresh = getTenantZeroId();
    old = await createTestTenant(admin);
  });
  afterAll(async () => {
    await data.end();
    await admin.end();
  });
  it("upgrades a populated tenant once and matches a fresh seed", async () => {
    for (const tenant of [fresh, old]) await runInTenant(tenant, () => seedSystem(data));
    const freshBefore = await heartbeat(fresh);
    const oldBefore = await heartbeat(old);
    // The pre-cutover action config cannot be produced by the current seed.
    const changed = await admin.query(
      "UPDATE project_heartbeats SET action_config = action_config - 'senderKnownFilter' WHERE tenant_id = $1 AND id = $2",
      [old, oldBefore.id],
    );
    expect(changed.rowCount).toBe(1);
    const run = () => runAsSystem("newEmail filter cutover test", () => runTenantCutoverMigrations(data));
    await run();
    const first = await heartbeat(old);
    expect(first.action_config).toEqual(oldBefore.action_config);
    expect(await heartbeat(fresh)).toEqual(freshBefore);
    await run();
    expect(await heartbeat(old)).toEqual(first);
    expect(await heartbeat(fresh)).toEqual(freshBefore);
  });
});
