import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createHeartbeat, getHeartbeat } from "../schedulerStore.js";
import { CORE_AGENT_RUN_ACTION_ID } from "../actions.js";

let pool: Pool;

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

describe("project_heartbeats.origin (issue #1438)", () => {
  beforeAll(() => {
    pool = getTestPool();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("reads every seeded heartbeat as system", async () => {
    const { rows } = await pool.query<{ origin: string }>("SELECT origin FROM project_heartbeats");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.origin === "system")).toBe(true);
  });

  it("defaults a created heartbeat to system", async () => {
    const projectItemId = await getProjectItemId();
    const hb = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Default",
        rule: { kind: "interval", minutes: 60 },
        actionId: CORE_AGENT_RUN_ACTION_ID,
      }),
    );
    expect(hb.origin).toBe("system");
  });

  it("round-trips origin user", async () => {
    const projectItemId = await getProjectItemId();
    const hb = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Mine",
        rule: { kind: "interval", minutes: 60 },
        actionId: CORE_AGENT_RUN_ACTION_ID,
        origin: "user",
      }),
    );
    expect(hb.origin).toBe("user");
    expect((await withTransaction(pool, (client) => getHeartbeat(client, hb.id)))?.origin).toBe("user");
  });

  it("rejects an unknown origin in the database", async () => {
    const projectItemId = await getProjectItemId();
    await expect(
      pool.query(
        `INSERT INTO project_heartbeats (project_item_id, name, rule, action_id, origin)
         VALUES ($1, 'Bad', '{"kind":"interval","minutes":60}'::jsonb, $2, 'robot')`,
        [projectItemId, CORE_AGENT_RUN_ACTION_ID],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
