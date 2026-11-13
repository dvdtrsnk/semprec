import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { seedSystem } from "../seed/seedSystem.js";
import { SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { AREAS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { runSleepSettingsAreaCutoverMigration } from "../sleep/sleepSettingsAreaCutoverMigration.js";
import { sleepNightsGet } from "../sleep/sleepRouteHandlers.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

// Each test builds one or two tenants with their couple of dozen system databases.
const SEEDING_TEST_TIMEOUT_MS = 90_000;

const USER = { writerKind: "user" } as const;
const NIGHTS_URL = "/api/sleep/nights?from=2026-10-15&to=2026-10-16";

let adminPool: Pool;
let dataPool: Pool;

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

async function seededTenant(): Promise<string> {
  const tenantId = await createTestTenant(adminPool);
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  return tenantId;
}

interface TenantFixture {
  tenantId: string;
  settingsDatabaseId: string;
  areasDatabaseId: string;
  settingsItemId: string;
}

async function fixtureOf(tenantId: string): Promise<TenantFixture> {
  return inTenant(tenantId, async (client) => {
    const settings = await databasesStore.getDatabaseByModuleId(client, SLEEP_SETTINGS_MODULE_ID);
    const areas = await databasesStore.getDatabaseByModuleId(client, AREAS_MODULE_ID);
    if (!settings || !areas) throw new Error("The tenant has no sleepSettings or Areas database");
    const { rows } = await client.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [settings.id]);
    const settingsItemId = rows[0]?.id;
    if (!settingsItemId) throw new Error("The tenant has no sleep settings item");
    return { tenantId, settingsDatabaseId: settings.id, areasDatabaseId: areas.id, settingsItemId };
  });
}

async function seededFixture(): Promise<TenantFixture> {
  return fixtureOf(await seededTenant());
}

interface AreaRelationRow {
  property_id: string;
  property_version: string;
  name: string | null;
  type: string;
  owner: string;
  owner_process: string | null;
  locked: boolean;
  config: Record<string, unknown>;
  definition_id: string;
  definition_version: string;
  property_id_a: string;
  property_id_b: string | null;
  cardinality: string;
  edge_count: number;
}

/** The `area` property of `sleepSettings` with its relation definition and edge count, as the runtime role sees them. */
function areaRelation(t: TenantFixture): Promise<AreaRelationRow[]> {
  return inTenant(t.tenantId, async (client) => {
    const { rows } = await client.query<AreaRelationRow>(
      `SELECT p.id AS property_id, p.xmin::text AS property_version, p.name, p.type, p.owner, p.owner_process,
              p.locked, p.config, d.id AS definition_id, d.xmin::text AS definition_version, d.property_id_a,
              d.property_id_b, d.cardinality,
              (SELECT count(*)::int FROM item_relations e WHERE e.relation_definition_id = d.id) AS edge_count
         FROM properties p
         JOIN relation_definitions d ON d.property_id_a = p.id
        WHERE p.database_id = $1 AND p.key = 'area'`,
      [t.settingsDatabaseId],
    );
    return rows;
  });
}

/** How many properties `sleepSettings` has under any key `area`, with or without a relation definition. */
async function areaPropertyCount(t: TenantFixture): Promise<number> {
  return inTenant(t.tenantId, async (client) => {
    const { rows } = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM properties WHERE database_id = $1 AND key = 'area'",
      [t.settingsDatabaseId],
    );
    return rows[0]?.count ?? 0;
  });
}

/** The relation as a tenant-independent value: what the seed and the cutover must both produce. */
function expectedRelation(t: TenantFixture) {
  return {
    name: null,
    type: "relation",
    owner: "user",
    owner_process: null,
    locked: false,
    cardinality: "one_to_one",
    property_id_b: null,
    edge_count: 0,
    config: { targetDatabaseId: t.areasDatabaseId },
  };
}

function relationValue(row: AreaRelationRow) {
  const { relationDefinitionId, ...config } = row.config;
  expect(relationDefinitionId).toBe(row.definition_id);
  return {
    name: row.name,
    type: row.type,
    owner: row.owner,
    owner_process: row.owner_process,
    locked: row.locked,
    cardinality: row.cardinality,
    property_id_b: row.property_id_b,
    edge_count: row.edge_count,
    config,
  };
}

/** Removes the `area` property and its definition, leaving the state of a tenant seeded before issue gh-1833. */
async function removeAreaRelation(t: TenantFixture): Promise<void> {
  await inTenant(t.tenantId, async (client) => {
    // Raw SQL: the settings schema is locked, so no production path deletes a property of it.
    const removed = await client.query("DELETE FROM properties WHERE database_id = $1 AND key = 'area'", [
      t.settingsDatabaseId,
    ]);
    expect(removed.rowCount).toBe(1);
  });
  expect(await areaPropertyCount(t)).toBe(0);
}

function createArea(t: TenantFixture, name: string): Promise<string> {
  return runInTenant(t.tenantId, async () => {
    const item = await createChokePoint(dataPool).createItem(
      { databaseId: t.areasDatabaseId, properties: { name } },
      undefined,
      undefined,
      USER,
    );
    return item.id;
  });
}

async function areaPropertyId(t: TenantFixture): Promise<string> {
  const [row] = await areaRelation(t);
  if (!row) throw new Error("The tenant has no area relation");
  return row.property_id;
}

async function connect(t: TenantFixture, targetItemId: string) {
  const relationPropertyId = await areaPropertyId(t);
  return runInTenant(t.tenantId, () =>
    createChokePoint(dataPool).createRelation(
      { relationPropertyId, callerItemId: t.settingsItemId, targetItemId },
      USER,
    ),
  );
}

/** The ids the settings item's `area` property points at, read through the choke point. */
async function areaTargets(t: TenantFixture): Promise<string[]> {
  const relationPropertyId = await areaPropertyId(t);
  const edges = await runInTenant(t.tenantId, () =>
    createChokePoint(dataPool).listItemRelations(t.settingsItemId, relationPropertyId),
  );
  return (edges ?? []).map((edge) => edge.targetItemId);
}

const nightsBody = z.object({ areaId: z.string().nullable(), planCount: z.number() }).passthrough();

/** `areaId` of `GET /api/sleep/nights`, parsed from what JSON carries. */
async function nightsAreaId(tenantId: string): Promise<string | null> {
  const result = await runInTenant(tenantId, () => sleepNightsGet(dataPool)({ req: { url: NIGHTS_URL } }));
  expect(result.status).toBe(200);
  const body = nightsBody.parse(JSON.parse(JSON.stringify(result.body)));
  // The seeded plans are in the answer, so a null `areaId` is not an empty fixture.
  expect(body.planCount).toBe(2);
  return body.areaId;
}

function runCutovers(): Promise<void> {
  return runAsSystem("test sleep area cutover", () => runTenantCutoverMigrations(dataPool));
}

describe("sleepSettings.area relation (issue gh-1833)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    const role = await dataPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  describe("seed", () => {
    it(
      "gives a new tenant a user-owned one-to-one area relation from sleepSettings to Areas, without an inverse property and without an edge",
      async () => {
        const t = await seededFixture();

        const rows = await areaRelation(t);

        expect(rows).toHaveLength(1);
        const [row] = rows;
        if (!row) throw new Error("unreachable");
        expect(relationValue(row)).toEqual(expectedRelation(t));
        expect(row.property_id_a).toBe(row.property_id);
        // The schema stays locked and Areas gained no property for the relation.
        const { locked, areaProperties } = await inTenant(t.tenantId, async (client) => {
          const settings = await databasesStore.getDatabase(client, t.settingsDatabaseId);
          const { rows: areas } = await client.query<{ key: string }>(
            "SELECT key FROM properties WHERE database_id = $1 AND config->>'targetDatabaseId' = $2",
            [t.areasDatabaseId, t.settingsDatabaseId],
          );
          return { locked: settings?.schemaLocked, areaProperties: areas };
        });
        expect(locked).toBe(true);
        expect(areaProperties).toEqual([]);
        expect(await areaTargets(t)).toEqual([]);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );
  });

  describe("cutover", () => {
    it(
      "gives an existing tenant the same relation as the seed, and a second run changes nothing",
      async () => {
        const fresh = await seededFixture();
        const existing = await seededFixture();
        await removeAreaRelation(existing);

        await runCutovers();

        const delivered = await areaRelation(existing);
        expect(delivered).toHaveLength(1);
        const [row] = delivered;
        if (!row) throw new Error("unreachable");
        expect(relationValue(row)).toEqual(expectedRelation(existing));
        expect(row.property_id_a).toBe(row.property_id);
        const [freshRow] = await areaRelation(fresh);
        if (!freshRow) throw new Error("The fresh tenant has no area relation");
        expect(relationValue(row)).toEqual({
          ...relationValue(freshRow),
          config: { targetDatabaseId: existing.areasDatabaseId },
        });
        const freshBefore = await areaRelation(fresh);

        await runCutovers();

        // The same rows at the same row versions: the second run wrote neither the property nor the definition.
        expect(await areaRelation(existing)).toEqual(delivered);
        expect(await areaRelation(fresh)).toEqual(freshBefore);
        expect(await areaPropertyCount(existing)).toBe(1);
        const schemaLocked = await inTenant(existing.tenantId, (client) =>
          databasesStore.getDatabase(client, existing.settingsDatabaseId),
        );
        expect(schemaLocked?.schemaLocked).toBe(true);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "keeps the area a user set when it runs again",
      async () => {
        const t = await seededFixture();
        await removeAreaRelation(t);
        await runCutovers();
        const areaId = await createArea(t, "Health");
        await connect(t, areaId);

        await runCutovers();

        expect(await areaTargets(t)).toEqual([areaId]);
        expect(await areaPropertyCount(t)).toBe(1);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it.each([SLEEP_SETTINGS_MODULE_ID, AREAS_MODULE_ID])(
      "does nothing when the %s database is missing",
      async (moduleId) => {
        const t = await seededFixture();
        await removeAreaRelation(t);
        await inTenant(t.tenantId, async (client) => {
          // No production path removes a system database; hiding its module id is the state of a tenant without it.
          const hidden = await client.query("UPDATE databases SET owner_module_id = NULL WHERE owner_module_id = $1", [
            moduleId,
          ]);
          expect(hidden.rowCount).toBe(1);
        });

        await expect(
          runInTenant(t.tenantId, () => runSleepSettingsAreaCutoverMigration(dataPool)),
        ).resolves.toBeUndefined();

        expect(await areaPropertyCount(t)).toBe(0);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it("does nothing for a tenant that has not been seeded", async () => {
      const bare = await createTestTenant(adminPool);

      await expect(runInTenant(bare, () => runSleepSettingsAreaCutoverMigration(dataPool))).resolves.toBeUndefined();

      const { rows } = await adminPool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM properties WHERE tenant_id = $1",
        [bare],
      );
      expect(rows).toEqual([{ count: 0 }]);
    });

    it(
      "changes only the tenant in scope",
      async () => {
        const inScope = await seededFixture();
        const other = await seededFixture();
        await removeAreaRelation(inScope);
        await removeAreaRelation(other);

        await runInTenant(inScope.tenantId, () => runSleepSettingsAreaCutoverMigration(dataPool));

        expect((await areaRelation(inScope)).map(relationValue)).toEqual([expectedRelation(inScope)]);
        expect(await areaPropertyCount(other)).toBe(0);
        // The delivered relation points at the tenant's own Areas database.
        expect(inScope.areasDatabaseId).not.toBe(other.areasDatabaseId);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );
  });

  describe("edges", () => {
    it(
      "refuses a second edge from the settings item with 409 cardinality_violation and keeps the first",
      async () => {
        const t = await seededFixture();
        const first = await createArea(t, "Health");
        const second = await createArea(t, "Home");
        await connect(t, first);

        await expect(connect(t, second)).rejects.toMatchObject({ status: 409, code: "cardinality_violation" });

        expect(await areaTargets(t)).toEqual([first]);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "points the settings item at another area with relation.set, without a 409 and with one edge left",
      async () => {
        const t = await seededFixture();
        const first = await createArea(t, "Health");
        const second = await createArea(t, "Home");
        await connect(t, first);
        const relationPropertyId = await areaPropertyId(t);

        const moved = await runInTenant(t.tenantId, () =>
          createChokePoint(dataPool).setRelation(
            { relationPropertyId, callerItemId: t.settingsItemId, targetItemId: second },
            USER,
          ),
        );

        expect(moved).toMatchObject({ itemA: t.settingsItemId, itemB: second });
        expect(await areaTargets(t)).toEqual([second]);
        expect((await areaRelation(t)).map((row) => row.edge_count)).toEqual([1]);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );
  });

  describe("GET /api/sleep/nights areaId", () => {
    it(
      "is null while the settings item has no area edge",
      async () => {
        const t = await seededFixture();

        expect(await nightsAreaId(t.tenantId)).toBeNull();
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "is the id of the related area, follows relation.set and is null again once the edge is cleared",
      async () => {
        const t = await seededFixture();
        const first = await createArea(t, "Health");
        const second = await createArea(t, "Home");
        const relationPropertyId = await areaPropertyId(t);
        const set = (targetItemId: string | null) =>
          runInTenant(t.tenantId, () =>
            createChokePoint(dataPool).setRelation(
              { relationPropertyId, callerItemId: t.settingsItemId, targetItemId },
              USER,
            ),
          );

        await set(first);
        expect(await nightsAreaId(t.tenantId)).toBe(first);
        await set(second);
        expect(await nightsAreaId(t.tenantId)).toBe(second);
        await set(null);
        expect(await nightsAreaId(t.tenantId)).toBeNull();
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "still names an area that is in the trash, because trashing keeps the edge",
      async () => {
        const t = await seededFixture();
        const areaId = await createArea(t, "Health");
        await connect(t, areaId);

        await runInTenant(t.tenantId, () =>
          createChokePoint(dataPool).softDeleteItem(t.areasDatabaseId, areaId, undefined, USER),
        );

        expect(await nightsAreaId(t.tenantId)).toBe(areaId);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "is null for a tenant whose sleepSettings has no area property yet",
      async () => {
        const t = await seededFixture();
        await removeAreaRelation(t);

        expect(await nightsAreaId(t.tenantId)).toBeNull();
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "shows a tenant only its own area, through the runtime role",
      async () => {
        const a = await seededFixture();
        const b = await seededFixture();
        const areaOfA = await createArea(a, "Health of A");
        const areaOfB = await createArea(b, "Health of B");
        await connect(a, areaOfA);
        await connect(b, areaOfB);

        expect(await nightsAreaId(a.tenantId)).toBe(areaOfA);
        expect(await nightsAreaId(b.tenantId)).toBe(areaOfB);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );

    it(
      "is null for a tenant without an edge while another tenant has one",
      async () => {
        const withEdge = await seededFixture();
        const without = await seededFixture();
        await connect(withEdge, await createArea(withEdge, "Health"));

        expect(await nightsAreaId(without.tenantId)).toBeNull();
      },
      SEEDING_TEST_TIMEOUT_MS,
    );
  });
});
