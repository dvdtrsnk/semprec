import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { ValidationError } from "../../errors.js";
import { createHeartbeat, getHeartbeat, updateHeartbeatName, updateHeartbeatTask } from "../schedulerStore.js";
import { CORE_AGENT_RUN_ACTION_ID } from "../actions.js";

let pool: Pool;
let runtimePool: Pool;

async function getProjectItemId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'projects'");
  const database = rows[0];
  if (!database) throw new Error("Missing projects database");
  const { rows: items } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 LIMIT 1", [
    database.id,
  ]);
  const item = items[0];
  if (!item) throw new Error("Missing project item");
  return item.id;
}

async function makeHeartbeat(actionId: string, actionConfig: Record<string, unknown>) {
  const projectItemId = await getProjectItemId();
  return withTransaction(pool, (client) =>
    createHeartbeat(client, {
      projectItemId,
      name: "Original",
      rule: { kind: "interval", minutes: 60 },
      actionId,
      actionConfig,
    }),
  );
}

async function reload(id: string) {
  return withTransaction(pool, (client) => getHeartbeat(client, id));
}

describe("updateHeartbeatName / updateHeartbeatTask (issue #1435)", () => {
  beforeAll(async () => {
    pool = getTestPool();
    runtimePool = await createRuntimeRolePool(pool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
  });

  it("renames a heartbeat and changes nothing else", async () => {
    const hb = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID, { task: "t", extra: 1 });
    const updated = await updateHeartbeatName(pool, hb.id, "  New name  ");
    expect(updated).toEqual({ ...hb, name: "New name" });
    expect(await reload(hb.id)).toEqual({ ...hb, name: "New name" });
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["over-long", "x".repeat(201)],
  ])("rejects a %s name", async (_label, name) => {
    const hb = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID, { task: "t" });
    await expect(updateHeartbeatName(pool, hb.id, name)).rejects.toBeInstanceOf(ValidationError);
    expect((await reload(hb.id))?.name).toBe("Original");
  });

  it("accepts a 200-character name", async () => {
    const hb = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID, { task: "t" });
    expect((await updateHeartbeatName(pool, hb.id, "x".repeat(200)))?.name).toHaveLength(200);
  });

  it("changes the task and keeps the other action_config keys, rule, enabled and next_fire_at", async () => {
    const hb = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID, { task: "old", keep: { a: 1 } });
    const updated = await updateHeartbeatTask(pool, hb.id, "new task");
    expect(updated).toEqual({ ...hb, actionConfig: { task: "new task", keep: { a: 1 } } });
  });

  it.each([
    ["empty", ""],
    ["blank", "  "],
    ["over-long", "x".repeat(4001)],
  ])("rejects a %s task", async (_label, task) => {
    const hb = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID, { task: "old" });
    await expect(updateHeartbeatTask(pool, hb.id, task)).rejects.toBeInstanceOf(ValidationError);
    expect((await reload(hb.id))?.actionConfig).toEqual({ task: "old" });
  });

  it("rejects a task change for a heartbeat whose action is not core.agentRun", async () => {
    const hb = await makeHeartbeat("core.other", { task: "old" });
    await expect(updateHeartbeatTask(pool, hb.id, "new")).rejects.toBeInstanceOf(ValidationError);
    expect((await reload(hb.id))?.actionConfig).toEqual({ task: "old" });
  });

  it("returns null for an unknown id", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect(await updateHeartbeatName(pool, id, "x")).toBeNull();
    expect(await updateHeartbeatTask(pool, id, "x")).toBeNull();
  });

  it("does not find another tenant's heartbeat", async () => {
    const hb = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID, { task: "old" });
    const otherTenant = await createTestTenant(pool);
    const projectItemId = await runInTenant(otherTenant, () => createTestProjectItem(runtimePool));
    const own = await runInTenant(otherTenant, () =>
      withTransaction(runtimePool, (client) =>
        createHeartbeat(client, {
          projectItemId,
          name: "Own",
          rule: { kind: "interval", minutes: 60 },
          actionId: CORE_AGENT_RUN_ACTION_ID,
          actionConfig: { task: "before" },
        }),
      ),
    );
    await withTenantTransaction(runtimePool, otherTenant, async (client) => {
      expect(await updateHeartbeatName(client, hb.id, "hijack")).toBeNull();
      expect(await updateHeartbeatTask(client, hb.id, "hijack")).toBeNull();
      expect((await updateHeartbeatName(client, own.id, "Allowed"))?.name).toBe("Allowed");
      expect((await updateHeartbeatTask(client, own.id, "after"))?.actionConfig).toEqual({ task: "after" });
    });
    const after = await reload(hb.id);
    expect(after?.name).toBe("Original");
    expect(after?.actionConfig).toEqual({ task: "old" });
  });
});
