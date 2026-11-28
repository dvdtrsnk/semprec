import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { ModuleRegistry, type ModuleManifest } from "@alldots/module-registry";
import { runAsSystem, runInTenant } from "@alldots/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import * as registryLoader from "../manifest/fullModuleRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { linkRuleEdgeLockHook } from "../valueLinks/linkRuleEdgeHook.js";

// `linkRuleEdgeLockHook` locks a rule's target item from the written edge. Every system rule has its via
// relation on the target's own database; this file adds one whose via relation is on the source's
// database (`Events.people`), where the target is the other end. `valueLinkEdgeBreakLockOrder.test.ts`
// covers the rest of the hook.

export const manifest: ModuleManifest = {
  id: "fixtureLockHook",
  version: "1.0.0",
  name: "Fixture Lock Hook",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureLock.eventName",
      source: { databaseKey: "events", propertyKey: "name" },
      target: { databaseKey: "people", propertyKey: "name" },
      via: { databaseKey: "events", relationKey: "people" },
    },
  ],
};

let admin: Pool;
let data: Pool;
let cp: ChokePoint;
let tenant: string;

interface Fixture {
  eventsDatabaseId: string;
  peopleDatabaseId: string;
  eventId: string;
  personId: string;
  edge: { relationDefinitionId: string; propertyId: string; itemA: string; itemB: string };
}

async function buildFixture(): Promise<Fixture> {
  return runInTenant(tenant, async () => {
    const databases = await cp.listDatabases();
    const databaseOf = (moduleId: string): string => {
      const found = databases.find((database) => database.ownerModuleId === moduleId);
      if (!found) throw new Error(`Missing database ${moduleId}`);
      return found.id;
    };
    const eventsDatabaseId = databaseOf("events");
    const peopleDatabaseId = databaseOf("people");
    const property = (await cp.listProperties(eventsDatabaseId)).find((entry) => entry.key === "people");
    if (!property) throw new Error("Missing Events.people");
    const event = await cp.createItem({
      databaseId: eventsDatabaseId,
      properties: { name: "client meeting", type: "meeting", date: "2024-03-01T12:00:00.000Z" },
    });
    const person = await cp.createItem({ databaseId: peopleDatabaseId, properties: { name: "Alice Novak" } });
    const edge = await cp.createRelation(
      { relationPropertyId: property.id, callerItemId: event.id, targetItemId: person.id },
      { writerKind: "user" },
    );
    return {
      eventsDatabaseId,
      peopleDatabaseId,
      eventId: event.id,
      personId: person.id,
      edge: {
        relationDefinitionId: edge.relationDefinitionId,
        propertyId: property.id,
        itemA: edge.itemA,
        itemB: edge.itemB,
      },
    };
  });
}

/**
 * Locks one item row in a transaction kept open while `inspect` runs the hook on another connection with
 * a lock timeout, so a hook that waits for the held row ends with `55P03` at once.
 */
async function holdingRow<T>(databaseId: string, itemId: string, inspect: () => Promise<T>): Promise<T> {
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holding = runInTenant(tenant, () =>
    withTransaction(data, async (client: PoolClient) => {
      if (!(await lockItemById(client, databaseId, itemId))) throw new Error("The row to hold does not exist");
      locked();
      await gate;
    }),
  );
  try {
    await Promise.race([ready, holding]);
    return await inspect();
  } finally {
    release();
    await holding;
  }
}

async function hookWaits(fixture: Fixture): Promise<boolean> {
  try {
    await runInTenant(tenant, () =>
      withTransaction(data, async (client) => {
        await client.query("SET LOCAL lock_timeout = '300ms'");
        await linkRuleEdgeLockHook({
          client,
          op: "create",
          metadata: {},
          writer: { writerKind: "user" },
          ...fixture.edge,
        });
      }),
    );
    return false;
  } catch (error) {
    // 55P03 is `lock_not_available`, raised when `lock_timeout` ends a wait.
    if (error instanceof DatabaseError && error.code === "55P03") return true;
    throw error;
  }
}

describe("linkRuleEdgeLockHook for a rule whose via relation is on the source's database", () => {
  beforeAll(async () => {
    const registry = new ModuleRegistry(() => new Set(["fixtureLockHook", "systemDatabases"]));
    await registry.loadModule(new URL("../seed/systemDatabasesModuleManifest.js", import.meta.url).href);
    await registry.loadModule(import.meta.url);
    registry.validateLinkRules();
    vi.spyOn(registryLoader, "loadFullModuleRegistry").mockResolvedValue(registry);
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "alldots_data");
    const role = await runAsSystem("check lock hook role", () =>
      data.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    cp = createChokePoint(data);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(data));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await data?.end();
    await admin?.end();
  });

  it("waits for the person, the target of the rule, which is the item at the other end of the edge", async () => {
    const fixture = await buildFixture();

    expect(await holdingRow(fixture.peopleDatabaseId, fixture.personId, () => hookWaits(fixture))).toBe(true);
  });

  it("does not wait for the Event, the source of the rule", async () => {
    const fixture = await buildFixture();

    expect(await holdingRow(fixture.eventsDatabaseId, fixture.eventId, () => hookWaits(fixture))).toBe(false);
  });
});
