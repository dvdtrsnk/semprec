import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  CORE_AGENT_RUN_ACTION_ID,
  KNOWN_HEARTBEAT_ACTION_IDS,
  KNOWN_OWNER_PROCESS_IDS,
  SEMPREC_TICK_ACTION_ID,
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

  it("registers every known heartbeat action except core.agentRun and semprec.tick", async () => {
    const registry = createApiActionRegistry(pool, await loadFullModuleRegistry());

    const expected = [...KNOWN_HEARTBEAT_ACTION_IDS]
      .filter((actionId) => actionId !== CORE_AGENT_RUN_ACTION_ID && actionId !== SEMPREC_TICK_ACTION_ID)
      .sort();
    expect([...registry.keys()].sort()).toEqual(expected);
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
