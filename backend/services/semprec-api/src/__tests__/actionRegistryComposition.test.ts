import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, inTenantZero, resetDatabase } from "@semprec/data/testSupport";
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
import { z } from "zod";
import { createApiActionRegistry } from "../actionRegistryComposition.js";
import { ARES_BASE_URL } from "../aresClient.js";

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

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("fires semprec.tick with the ARES client: a Companies proposal carries the registered name (issue gh-1989)", async () => {
    await seedSystem(pool);
    const heartbeat = await pool.query<{ id: string; project_item_id: string; action_config: unknown }>(
      "SELECT id, project_item_id, action_config FROM project_heartbeats WHERE action_id = $1 LIMIT 1",
      [SEMPREC_TICK_ACTION_ID],
    );
    const row = heartbeat.rows[0];
    if (!row) throw new Error("The seeded Inbox heartbeat is missing");
    const config = z
      .object({ inboxDatabaseId: z.string(), inboxItemTypesDatabaseId: z.string() })
      .passthrough()
      .parse(row.action_config);
    const chokePoint = createChokePoint(pool);
    const type = await inTenantZero(() =>
      chokePoint.createItem({
        databaseId: config.inboxItemTypesDatabaseId,
        properties: { name: "Company", emoji: "C", processingMethod: "database", targetDatabase: "companies" },
      }),
    );
    const item = await inTenantZero(() =>
      chokePoint.createItem({
        databaseId: config.inboxDatabaseId,
        properties: { text: "Brainz, IČO 27419363", date: "2026-10-16", time: "08:12" },
      }),
    );
    const typeProperty = await pool.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'type'",
      [config.inboxDatabaseId],
    );
    await inTenantZero(() =>
      chokePoint.createRelation({
        relationPropertyId: typeProperty.rows[0]!.id,
        callerItemId: item.id,
        targetItemId: type.id,
      }),
    );
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      if (url.endsWith("/internal/complete"))
        return Response.json({
          content: { properties: { name: "Brainz", ico: "27419363" } },
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      if (url.startsWith(ARES_BASE_URL)) return Response.json({ ico: "27419363", obchodniJmeno: "BRAINZ s.r.o." });
      throw new Error("An unexpected request");
    });

    const registry = createApiActionRegistry(pool, await loadFullModuleRegistry());
    const tick = registry.get(SEMPREC_TICK_ACTION_ID);
    if (!tick) throw new Error("semprec.tick is missing");
    await inTenantZero(() =>
      tick(row.action_config as Record<string, unknown>, {
        heartbeatId: row.id,
        projectItemId: row.project_item_id,
        itemId: item.id,
      }),
    );

    expect(requested.filter((url) => url.startsWith(ARES_BASE_URL))).toEqual([
      `${ARES_BASE_URL}/ekonomicke-subjekty/27419363`,
    ]);
    const cards = await pool.query<{ properties: { status: string; proposal: { properties: unknown } } }>(
      "SELECT properties FROM items WHERE properties ? 'proposal'",
    );
    expect(cards.rows).toHaveLength(1);
    expect(cards.rows[0]?.properties.status).toBe("proposed");
    expect(cards.rows[0]?.properties.proposal.properties).toEqual({ name: "BRAINZ s.r.o.", ico: "27419363" });
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
