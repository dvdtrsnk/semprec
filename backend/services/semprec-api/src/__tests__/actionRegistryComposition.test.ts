import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  CORE_AGENT_RUN_ACTION_ID,
  DRIFT_CHECK_ACTION_ID,
  JOURNAL_WEEKLY_CLEANUP_ACTION_ID,
  KNOWN_HEARTBEAT_ACTION_IDS,
  KNOWN_OWNER_PROCESS_IDS,
  SEMPREC_TICK_ACTION_ID,
  createHeartbeatFireCoreTask,
  createChokePoint,
  findOrphanedOwnerProcessIds,
  findUnknownHeartbeatActionIds,
  loadFullModuleRegistry,
  seedSystem,
} from "@semprec/data";
import { createApiActionRegistry } from "../actionRegistryComposition.js";

let pool: Pool;
const originalToken = process.env.AI_GATEWAY_INTERNAL_TOKEN;

describe("createApiActionRegistry (issue #641)", () => {
  beforeAll(() => {
    pool = getTestPool();
    process.env.AI_GATEWAY_INTERNAL_TOKEN = "test-internal-token";
  });

  beforeEach(async () => {
    process.env.AI_GATEWAY_INTERNAL_TOKEN = "test-internal-token";
    await resetDatabase(pool);
  });

  afterAll(async () => {
    if (originalToken === undefined) delete process.env.AI_GATEWAY_INTERNAL_TOKEN;
    else process.env.AI_GATEWAY_INTERNAL_TOKEN = originalToken;
    await pool.end();
  });

  it("registers every known heartbeat action except the agent-run ones, including semprec.tick", async () => {
    const registry = createApiActionRegistry(pool, await loadFullModuleRegistry());

    const agentRunActionIds = [CORE_AGENT_RUN_ACTION_ID, JOURNAL_WEEKLY_CLEANUP_ACTION_ID];
    const expected = [...KNOWN_HEARTBEAT_ACTION_IDS].filter((actionId) => !agentRunActionIds.includes(actionId)).sort();
    expect([...registry.keys()].sort()).toEqual(expected);
    expect(registry.has(SEMPREC_TICK_ACTION_ID)).toBe(true);
  });

  it("the composed core drift action accepts calendar and reports an unknown owner", async () => {
    await seedSystem(pool);
    const chokePoint = createChokePoint(pool);
    const db = await chokePoint.createDatabase({ name: "Drift fixture" });
    for (const [key, ownerProcess] of [
      ["calendarOwned", "calendar"],
      ["unknownOwned", "unknownProcess"],
    ] as const) {
      await chokePoint.createProperty({
        databaseId: db.id,
        key,
        name: key,
        type: "text",
        owner: "system",
        ownerProcess,
      });
    }
    const projectItem = await chokePoint.createItem({ databaseId: db.id, properties: {} });
    const action = createApiActionRegistry(pool, await loadFullModuleRegistry()).get(DRIFT_CHECK_ACTION_ID);
    if (!action) throw new Error("core drift action is missing");
    await action({}, { heartbeatId: "fixture", projectItemId: projectItem.id });
    const { rows } = await pool.query<{ payload: { orphanedOwnerProcess: Array<{ key: string }> } }>(
      "SELECT payload FROM manifest_drift_findings WHERE kind = 'agent_manifest_drift'",
    );
    const keys = rows.flatMap((row) => row.payload.orphanedOwnerProcess.map((property) => property.key));
    expect(keys).toContain("unknownOwned");
    expect(keys).not.toContain("calendarOwned");
  });

  it("fires a seeded Inbox heartbeat without reporting 'No handler registered'", async () => {
    await seedSystem(pool);
    const registry = createApiActionRegistry(pool, await loadFullModuleRegistry());
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM project_heartbeats WHERE action_id = $1 LIMIT 1",
      [SEMPREC_TICK_ACTION_ID],
    );
    const heartbeatId = rows[0]!.id;

    // The item does not exist, so the tick resolves without computing anything; what matters is that
    // the fire path found a handler.
    const task = createHeartbeatFireCoreTask(pool, registry);
    const helpers = { job: { id: "job-1", attempts: 3, max_attempts: 3 } } as Parameters<typeof task>[1];
    await task({ heartbeatId, itemId: "00000000-0000-0000-0000-000000000001" }, helpers);

    const { rows: after } = await pool.query<{ last_error: string | null }>(
      "SELECT last_error FROM project_heartbeats WHERE id = $1",
      [heartbeatId],
    );
    expect(after[0]!.last_error).toBeNull();
  });

  it("refuses to compose without AI_GATEWAY_INTERNAL_TOKEN, naming the variable", async () => {
    const moduleRegistry = await loadFullModuleRegistry();
    delete process.env.AI_GATEWAY_INTERNAL_TOKEN;

    expect(() => createApiActionRegistry(pool, moduleRegistry)).toThrow(/AI_GATEWAY_INTERNAL_TOKEN/);
  });

  it("leaves a freshly seeded database with no unknown heartbeat action and no orphaned owner process", async () => {
    await seedSystem(pool);

    const client = await pool.connect();
    try {
      expect(await findOrphanedOwnerProcessIds(client, KNOWN_OWNER_PROCESS_IDS)).toEqual([]);
      expect(await findUnknownHeartbeatActionIds(client, KNOWN_HEARTBEAT_ACTION_IDS)).toEqual([]);
    } finally {
      client.release();
    }
  });
});
