import "../../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { KNOWN_HEARTBEAT_ACTION_IDS } from "../../manifest/knownActionIds.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { TASKS_DAY_ROLLOVER_ACTION_ID } from "../tasksDayRolloverAction.js";
import { runTasksDayRolloverHeartbeatCutoverMigration } from "../tasksDayRolloverHeartbeatCutoverMigration.js";

let admin: Pool;
let pool: Pool;

interface HeartbeatShape {
  name: string;
  rule: unknown;
  action_config: unknown;
  project_item_id: string;
}

async function rolloverHeartbeats(tenant: string): Promise<HeartbeatShape[]> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<HeartbeatShape>(
      "SELECT name, rule, action_config, project_item_id FROM project_heartbeats WHERE action_id = $1",
      [TASKS_DAY_ROLLOVER_ACTION_ID],
    );
    return rows;
  });
}

/** The Semprec project (the System settings database's owner) and the Tasks database of the tenant. */
async function anchors(tenant: string): Promise<{ semprec: string; tasks: string }> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<{ owner_module_id: string; id: string; owner_project_item_id: string | null }>(
      "SELECT owner_module_id, id, owner_project_item_id FROM databases WHERE owner_module_id IN ('systemSettings', 'tasks')",
    );
    const semprec = rows.find((row) => row.owner_module_id === "systemSettings")?.owner_project_item_id;
    const tasks = rows.find((row) => row.owner_module_id === "tasks")?.id;
    if (!semprec || !tasks) throw new Error("Semprec project or Tasks missing");
    return { semprec, tasks };
  });
}

describe("the Tasks day rollover heartbeat (issue #1674)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => resetDatabase(admin));
  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("is a known heartbeat action of the systemDatabases manifest", async () => {
    expect(KNOWN_HEARTBEAT_ACTION_IDS.has(TASKS_DAY_ROLLOVER_ACTION_ID)).toBe(true);
    const registry = await loadFullModuleRegistry();
    expect(await registry.getHeartbeatActions()).toContain(TASKS_DAY_ROLLOVER_ACTION_ID);
  });

  it("seeds one dailyTime 00:00 heartbeat on the Semprec project for a fresh tenant", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    const { semprec, tasks } = await anchors(tenant);
    expect(await rolloverHeartbeats(tenant)).toEqual([
      {
        name: "Tasks day rollover",
        rule: { kind: "dailyTime", at: "00:00" },
        action_config: { tasksDatabaseId: tasks },
        project_item_id: semprec,
      },
    ]);
  });

  it("gives an existing tenant the same heartbeat through the cutover, once", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    const fresh = await rolloverHeartbeats(tenant);
    // Synthetic previous shape: a tenant seeded before issue #1674 has no rollover heartbeat.
    await runInTenant(tenant, async () => {
      const removed = await pool.query("DELETE FROM project_heartbeats WHERE action_id = $1", [
        TASKS_DAY_ROLLOVER_ACTION_ID,
      ]);
      expect(removed.rowCount).toBe(1);
    });
    expect(await rolloverHeartbeats(tenant)).toEqual([]);
    await runAsSystem("test:rollover-cutover", () => runTenantCutoverMigrations(pool));
    expect(await rolloverHeartbeats(tenant)).toEqual(fresh);
    await runAsSystem("test:rollover-cutover", () => runTenantCutoverMigrations(pool));
    expect(await rolloverHeartbeats(tenant)).toEqual(fresh);
  });

  it("does nothing for a tenant without a Tasks database or Semprec project", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => runTasksDayRolloverHeartbeatCutoverMigration(pool));
    expect(await rolloverHeartbeats(tenant)).toEqual([]);
  });
});
