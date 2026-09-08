import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import {
  createModuleRegistryDriftCheckAction,
  findOrphanedOwnerProcessIds,
  findUnknownHeartbeatActionIds,
  ORPHANED_OWNER_PROCESS_FINDING_KIND,
  UNKNOWN_HEARTBEAT_ACTION_FINDING_KIND,
} from "../manifest/moduleRegistryDriftCheck.js";

let pool: Pool;
let chokePoint: ChokePoint;

async function createProjectItem(): Promise<string> {
  const project = await chokePoint.createDatabase({ name: "Projects" });
  const projectItem = await chokePoint.createItem({ databaseId: project.id, properties: {} });
  return projectItem.id;
}

describe("moduleRegistry.checkDrift", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("finds heartbeat action ids with no matching active action", async () => {
    const projectItemId = await createProjectItem();
    await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Known",
        rule: { kind: "dailyTime", at: "01:00" },
        actionId: "core.known",
        enabled: false,
      }),
    );
    await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Unknown",
        rule: { kind: "dailyTime", at: "02:00" },
        actionId: "core.unknown",
        enabled: false,
      }),
    );

    const unknown = await withTransaction(pool, (client) =>
      findUnknownHeartbeatActionIds(client, new Set(["core.known"])),
    );
    expect(unknown).toEqual(["core.unknown"]);
  });

  it("finds owner_process values with no matching active process id", async () => {
    const db = await chokePoint.createDatabase({ name: "D" });
    await chokePoint.createProperty({ databaseId: db.id, key: "userField", name: "User field", type: "text" });
    await chokePoint.createProperty({
      databaseId: db.id,
      key: "known",
      name: "Known",
      type: "text",
      owner: "system",
      ownerProcess: "core.known",
    });
    await chokePoint.createProperty({
      databaseId: db.id,
      key: "orphan",
      name: "Orphan",
      type: "text",
      owner: "system",
      ownerProcess: "core.unknown",
    });

    const orphaned = await withTransaction(pool, (client) =>
      findOrphanedOwnerProcessIds(client, new Set(["core.known"])),
    );
    expect(orphaned).toEqual(["core.unknown"]);
  });

  it("publishes a finding for each drift kind and resolves it once repaired", async () => {
    const projectItemId = await createProjectItem();
    await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Unknown",
        rule: { kind: "dailyTime", at: "02:00" },
        actionId: "core.unknown",
        enabled: false,
      }),
    );
    const db = await chokePoint.createDatabase({ name: "D" });
    await chokePoint.createProperty({
      databaseId: db.id,
      key: "orphan",
      name: "Orphan",
      type: "text",
      owner: "system",
      ownerProcess: "core.orphan",
    });

    const action = createModuleRegistryDriftCheckAction(pool, {
      activeHeartbeatActionIds: new Set(["core.expected"]),
      activeProcessIds: new Set(["core.expected"]),
    });
    await action({}, { heartbeatId: "hb", projectItemId });

    const { rows: findings } = await pool.query(
      `SELECT kind, dedupe_key, resolved_at FROM notifications WHERE kind IN ($1, $2)`,
      [UNKNOWN_HEARTBEAT_ACTION_FINDING_KIND, ORPHANED_OWNER_PROCESS_FINDING_KIND],
    );
    expect(findings).toHaveLength(2);
    expect(findings.every((row) => row.resolved_at === null)).toBe(true);

    // Repair both onto the already-active id, then re-run: prior findings must resolve, not accumulate.
    await pool.query(`UPDATE project_heartbeats SET action_id = 'core.expected' WHERE action_id = 'core.unknown'`);
    await pool.query(`UPDATE properties SET owner_process = 'core.expected' WHERE owner_process = 'core.orphan'`);

    await action({}, { heartbeatId: "hb", projectItemId });

    const { rows: afterRepair } = await pool.query(
      `SELECT kind, resolved_at FROM notifications WHERE kind IN ($1, $2)`,
      [UNKNOWN_HEARTBEAT_ACTION_FINDING_KIND, ORPHANED_OWNER_PROCESS_FINDING_KIND],
    );
    expect(afterRepair).toHaveLength(2);
    expect(afterRepair.every((row) => row.resolved_at !== null)).toBe(true);
  });

  it("concurrent runs do not create duplicate active findings", async () => {
    const projectItemId = await createProjectItem();
    await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Unknown",
        rule: { kind: "dailyTime", at: "02:00" },
        actionId: "core.unknown",
        enabled: false,
      }),
    );

    const action = createModuleRegistryDriftCheckAction(pool, {
      activeHeartbeatActionIds: new Set(),
      activeProcessIds: new Set(),
    });

    await Promise.all([
      action({}, { heartbeatId: "hb", projectItemId }),
      action({}, { heartbeatId: "hb", projectItemId }),
    ]);

    const { rows } = await pool.query(`SELECT id FROM notifications WHERE kind = $1 AND resolved_at IS NULL`, [
      UNKNOWN_HEARTBEAT_ACTION_FINDING_KIND,
    ]);
    expect(rows).toHaveLength(1);
  });
});
