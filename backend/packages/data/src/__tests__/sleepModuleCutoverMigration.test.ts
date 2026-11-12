import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { listViewsByDatabase } from "../chokePoint/viewsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { ConflictError } from "../errors.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { generateSchemaProjection } from "../manifest/schemaProjection.js";
import { lockTenantSeedInTransaction, seedSystem } from "../seed/seedSystem.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { runSleepModuleCutoverMigration } from "../sleep/sleepModuleCutoverMigration.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

// Each test builds one or more tenants with their couple of dozen system databases.
const SEEDING_TEST_TIMEOUT_MS = 90_000;

const SLEEP_KEYS = [SLEEP_SETTINGS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_NIGHTS_MODULE_ID] as const;

let adminPool: Pool;
let dataPool: Pool;

/** The settings item issue #1776 seeds. */
const EXPECTED_SETTINGS = {
  enabled: true,
  prepReminder: true,
  muteSemp: true,
  alarmSnooze: true,
  showInCalendar: true,
  goalMinutes: 480,
  prepReminderMinutes: 30,
  alarmSound: "morning",
  systemActive: true,
};

/** The two plans issue #1776 seeds, in `position` order, under the given names. */
function expectedPlans(weekdays: string, weekend: string) {
  return [
    {
      name: weekdays,
      wakeDays: ["mon", "tue", "wed", "thu", "fri"],
      bedTime: "23:00",
      wakeTime: "06:45",
      alarm: true,
      position: 0,
    },
    { name: weekend, wakeDays: ["sat", "sun"], bedTime: "00:00", wakeTime: "08:30", alarm: false, position: 1 },
  ];
}

/** What `sleepDelivery` returns for a tenant that has no sleep database. */
const NO_SLEEP_MODULE = { project: null, databases: [] };

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

/**
 * Creates a tenant, seeds it and then gives it a user of `locale`, the order in which an existing tenant got its
 * account. Returns the tenant id.
 */
async function seededTenant(locale: "cs" | "en", status: "active" | "suspended" = "active"): Promise<string> {
  const tenantId = await createTestTenant(adminPool, { status });
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  await createUser(adminPool, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused", locale });
  return tenantId;
}

/**
 * What the runtime role sees of the sleep module in the scope of `tenantId`, without ids: the project that owns
 * the sleep databases, and each sleep database that exists, in the order of `SLEEP_KEYS`, with its properties,
 * its views and the properties of its live items in `position` order.
 */
async function sleepDelivery(tenantId: string) {
  const structure = await inTenant(tenantId, async (client) => {
    const owners = new Set<string | null>();
    const databases = [];
    for (const key of SLEEP_KEYS) {
      const found = await databasesStore.getDatabaseByModuleId(client, key);
      if (!found) continue;
      owners.add(found.ownerProjectItemId);
      databases.push({
        id: found.id,
        shape: {
          key: found.key,
          name: found.name,
          system: found.system,
          schemaLocked: found.schemaLocked,
          ownerModuleId: found.ownerModuleId,
          archivedAt: found.archivedAt,
          properties: (await listPropertiesByDatabase(client, found.id)).map((property) => ({
            key: property.key,
            name: property.name,
            type: property.type,
            owner: property.owner,
            ownerProcess: property.ownerProcess,
            locked: property.locked,
            config: property.config,
          })),
          views: (await listViewsByDatabase(client, found.id)).map((view) => ({
            type: view.type,
            name: view.name,
            isDefault: view.isDefault,
            createdBy: view.createdBy,
            ownerModuleId: view.ownerModuleId,
            config: view.config,
          })),
        },
      });
    }
    if (databases.length === 0) return { project: null, databases };
    // One project owns every sleep database of the tenant.
    expect(owners.size).toBe(1);
    const [projectItemId] = [...owners];
    const projects = await databasesStore.getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    const project = projects && projectItemId ? await getItemById(client, projects.id, projectItemId) : null;
    return {
      project: project && {
        name: project.properties.name,
        systemActive: project.properties.systemActive,
        deletedAt: project.deletedAt,
      },
      databases,
    };
  });
  const chokePoint = createChokePoint(dataPool);
  const databases = [];
  for (const { id, shape } of structure.databases) {
    const { items } = await runInTenant(tenantId, () => chokePoint.listItems(id, { limit: 50 }));
    databases.push({
      ...shape,
      items: items.map((item) => item.properties).sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0)),
    });
  }
  return { project: structure.project, databases };
}

/** The ids of the sleep databases of `tenantId` and of the live items in them, read in that tenant's scope. */
async function sleepIds(tenantId: string): Promise<{ databaseId: string; itemIds: string[] }[]> {
  const chokePoint = createChokePoint(dataPool);
  const ids = [];
  for (const key of SLEEP_KEYS) {
    const found = await inTenant(tenantId, (client) => databasesStore.getDatabaseByModuleId(client, key));
    if (!found) throw new Error(`The tenant has no ${key} database`);
    const { items } = await runInTenant(tenantId, () => chokePoint.listItems(found.id, { limit: 50 }));
    ids.push({ databaseId: found.id, itemIds: items.map((item) => item.id) });
  }
  return ids;
}

/**
 * Removes what issue #1776 seeds from a tenant, leaving the state of a tenant seeded before it. The sleep
 * databases are locked system databases and their settings item cannot be deleted, so no public path removes
 * them or their project: the ids are read in the tenant's scope and the rows removed on the admin pool; each
 * database, its partition, properties and views go through the store's own drop.
 */
async function revertToOldShape(tenantId: string): Promise<void> {
  const ids = await inTenant(tenantId, async (client) => {
    const projects = await databasesStore.getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!projects) throw new Error("Seeded tenant is missing the Projects database");
    const settings = await databasesStore.getDatabaseByModuleId(client, SLEEP_SETTINGS_MODULE_ID);
    if (!settings?.ownerProjectItemId) throw new Error("Seeded tenant is missing the sleepSettings database");
    const databases: string[] = [];
    for (const key of SLEEP_KEYS) {
      const found = await databasesStore.getDatabaseByModuleId(client, key);
      if (!found) throw new Error(`Seeded tenant is missing the ${key} database`);
      // One project owns the three, so removing the owner of `sleepSettings` removes the module's project.
      expect(found.ownerProjectItemId).toBe(settings.ownerProjectItemId);
      databases.push(found.id);
    }
    return { projects: projects.id, project: settings.ownerProjectItemId, databases };
  });
  await withTenantTransaction(adminPool, tenantId, async (client) => {
    for (const databaseId of ids.databases) {
      // Raw SQL: the store's drop expects an empty partition, and no production path hard-deletes the settings item.
      await client.query("DELETE FROM items WHERE database_id = $1", [databaseId]);
      await databasesStore.dropDatabaseWithPartition(client, databaseId);
    }
    // Raw SQL: no production path hard-deletes the project item of a system module.
    const removed = await client.query("DELETE FROM items WHERE database_id = $1 AND id = $2", [
      ids.projects,
      ids.project,
    ]);
    expect(removed.rowCount).toBe(1);
  });
  expect(await sleepDelivery(tenantId)).toEqual(NO_SLEEP_MODULE);
}

interface VersionedRow {
  version: string;
  row: unknown;
}

/** Every row of `tenantId` in the tables the seed writes, with its row version, on the admin pool filtered by the tenant. */
async function tenantRows(tenantId: string) {
  const read = async (sql: string) => (await adminPool.query<VersionedRow>(sql, [tenantId])).rows;
  return {
    databases: await read(
      "SELECT xmin::text AS version, to_jsonb(d) AS row FROM databases d WHERE tenant_id = $1 ORDER BY id",
    ),
    properties: await read(
      "SELECT xmin::text AS version, to_jsonb(p) AS row FROM properties p WHERE tenant_id = $1 ORDER BY id",
    ),
    views: await read("SELECT xmin::text AS version, to_jsonb(v) AS row FROM views v WHERE tenant_id = $1 ORDER BY id"),
    items: await read("SELECT xmin::text AS version, to_jsonb(i) AS row FROM items i WHERE tenant_id = $1 ORDER BY id"),
  };
}

/**
 * The rows issue #1776 seeds for `tenantId`, with their row versions: the sleep databases, their properties,
 * views and items, and the project item that owns them. A cutover that rewrote one of them would change its
 * version.
 */
async function sleepRows(tenantId: string) {
  const read = async (sql: string) => (await adminPool.query<VersionedRow>(sql, [tenantId, SLEEP_KEYS])).rows;
  return {
    databases: await read(
      `SELECT xmin::text AS version, to_jsonb(d) AS row FROM databases d
        WHERE tenant_id = $1 AND owner_module_id = ANY($2::text[]) ORDER BY id`,
    ),
    properties: await read(
      `SELECT p.xmin::text AS version, to_jsonb(p) AS row FROM properties p JOIN databases d ON d.id = p.database_id
        WHERE d.tenant_id = $1 AND d.owner_module_id = ANY($2::text[]) ORDER BY p.id`,
    ),
    views: await read(
      `SELECT v.xmin::text AS version, to_jsonb(v) AS row FROM views v JOIN databases d ON d.id = v.database_id
        WHERE d.tenant_id = $1 AND d.owner_module_id = ANY($2::text[]) ORDER BY v.id`,
    ),
    items: await read(
      `SELECT i.xmin::text AS version, to_jsonb(i) AS row FROM items i JOIN databases d ON d.id = i.database_id
        WHERE d.tenant_id = $1 AND d.owner_module_id = ANY($2::text[]) ORDER BY i.id`,
    ),
    projects: await read(
      `SELECT i.xmin::text AS version, to_jsonb(i) AS row FROM items i
        WHERE i.tenant_id = $1 AND i.id IN (
          SELECT d.owner_project_item_id FROM databases d
           WHERE d.tenant_id = $1 AND d.owner_module_id = ANY($2::text[]))
        ORDER BY i.id`,
    ),
  };
}

/** How many rows of each kind `sleepRows` holds. */
function rowCounts(rows: Awaited<ReturnType<typeof sleepRows>>) {
  return {
    databases: rows.databases.length,
    properties: rows.properties.length,
    views: rows.views.length,
    items: rows.items.length,
    projects: rows.projects.length,
  };
}

/** What one delivery writes: three databases, their 20 properties and three views, three items and one project. */
const DELIVERED_ROW_COUNTS = { databases: 3, properties: 20, views: 3, items: 3, projects: 1 };

/** The sleep databases of `tenantId` in the Czech schema projection, in the order of `SLEEP_KEYS` and without ids. */
async function sleepProjection(tenantId: string) {
  const registry = await loadFullModuleRegistry();
  const projection = await inTenant(tenantId, (client) => generateSchemaProjection(client, registry, { locale: "cs" }));
  return SLEEP_KEYS.map((key) => {
    const database = projection.databases.find((entry) => entry.key === key);
    if (!database) throw new Error(`${key} is missing from the schema projection`);
    return {
      ...database,
      databaseId: null,
      properties: database.properties.map((property) => ({ ...property, id: null })),
    };
  });
}

/**
 * The guidance rows of `tenantId` as the runtime role counts them in that tenant's scope: those of its Sleep
 * project, and those of the whole tenant.
 */
async function guidanceRowCounts(tenantId: string): Promise<{ sleepProject: number; tenant: number }> {
  return inTenant(tenantId, async (client) => {
    const settings = await databasesStore.getDatabaseByModuleId(client, SLEEP_SETTINGS_MODULE_ID);
    if (!settings?.ownerProjectItemId) throw new Error("The tenant has no Sleep project");
    const { rows } = await client.query<{ sleep_project: number; tenant: number }>(
      `SELECT count(*) FILTER (WHERE project_item_id = $1)::int AS sleep_project, count(*)::int AS tenant
         FROM project_agent_guidance`,
      [settings.ownerProjectItemId],
    );
    const counts = rows[0];
    if (!counts) throw new Error("The guidance count returned no row");
    return { sleepProject: counts.sleep_project, tenant: counts.tenant };
  });
}

async function tenantStatus(tenantId: string): Promise<string | undefined> {
  const { rows } = await adminPool.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1", [tenantId]);
  return rows[0]?.status;
}

function runCutovers(): Promise<void> {
  return runAsSystem("test sleep cutover", () => runTenantCutoverMigrations(dataPool));
}

describe("sleep module cutover for existing tenants (issue #1779)", () => {
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

  it(
    "delivers the module to an active and a suspended tenant seeded before it when a deploy runs the cutover runner and then provisionTenant: the three locked databases outside the client lists, one settings item and the two default plans",
    async () => {
      const active = await seededTenant("cs");
      const suspended = await seededTenant("cs", "suspended");
      const fresh = await seededTenant("cs");
      await revertToOldShape(active);
      await revertToOldShape(suspended);
      const freshBefore = await sleepRows(fresh);
      expect(rowCounts(freshBefore)).toEqual(DELIVERED_ROW_COUNTS);

      // A deploy runs the cutover runner (`db/runMigrationsCli.ts`) and then `provisionTenant` for each maintained
      // tenant (`db/runSeed.ts`).
      await runCutovers();
      await expect(provisionTenant(dataPool, active)).resolves.toBe("already-provisioned");
      await expect(provisionTenant(dataPool, suspended)).resolves.toBe("already-provisioned");

      const freshDelivery = await sleepDelivery(fresh);
      const freshProjection = await sleepProjection(fresh);
      for (const tenantId of [active, suspended]) {
        const delivered = await sleepDelivery(tenantId);
        expect(delivered.project).toEqual({ name: "Sleep", systemActive: true, deletedAt: null });
        expect(
          delivered.databases.map(({ key, system, schemaLocked, archivedAt }) => ({
            key,
            system,
            schemaLocked,
            archivedAt,
          })),
        ).toEqual([
          { key: "sleepSettings", system: true, schemaLocked: true, archivedAt: null },
          { key: "sleepPlans", system: true, schemaLocked: true, archivedAt: null },
          { key: "sleepNights", system: true, schemaLocked: true, archivedAt: null },
        ]);
        expect(delivered.databases.map((database) => database.items)).toEqual([
          [EXPECTED_SETTINGS],
          expectedPlans("Pracovní dny", "Víkend"),
          [],
        ]);
        // The properties and the views are those of a tenant the fresh seed gave the module.
        expect(delivered).toEqual(freshDelivery);
        expect(rowCounts(await sleepRows(tenantId))).toEqual(DELIVERED_ROW_COUNTS);

        const projected = await sleepProjection(tenantId);
        expect(projected.map(({ key, name, clientVisible }) => ({ key, name, clientVisible }))).toEqual([
          { key: "sleepSettings", name: "Nastavení spánku", clientVisible: false },
          { key: "sleepPlans", name: "Plány spánku", clientVisible: false },
          { key: "sleepNights", name: "Noci spánku", clientVisible: false },
        ]);
        expect(projected).toEqual(freshProjection);
      }
      expect(await tenantStatus(active)).toBe("active");
      expect(await tenantStatus(suspended)).toBe("suspended");
      // The guidance cutover of the same pass wrote rows for the tenant; the Sleep project has no seed text and got none.
      const guidance = await guidanceRowCounts(active);
      expect(guidance.sleepProject).toBe(0);
      expect(guidance.tenant).toBeGreaterThan(0);
      // The tenant that had the module already keeps its rows unwritten.
      expect(await sleepRows(fresh)).toEqual(freshBefore);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "writes nothing when the cutover runs again, through the runner and on its own",
    async () => {
      const tenantId = await seededTenant("cs");
      await revertToOldShape(tenantId);
      await runCutovers();
      const delivered = await sleepRows(tenantId);
      expect(rowCounts(delivered)).toEqual(DELIVERED_ROW_COUNTS);

      await runCutovers();
      expect(await sleepRows(tenantId)).toEqual(delivered);

      // On its own the step writes no row of the tenant at all.
      const before = await tenantRows(tenantId);
      await runInTenant(tenantId, () => runSleepModuleCutoverMigration(dataPool));
      expect(await tenantRows(tenantId)).toEqual(before);
      expect(await sleepRows(tenantId)).toEqual(delivered);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it("skips a tenant that has no Projects database", async () => {
    const bare = await createTestTenant(adminPool);

    await expect(runInTenant(bare, () => runSleepModuleCutoverMigration(dataPool))).resolves.toBeUndefined();

    expect(await tenantRows(bare)).toEqual({ databases: [], properties: [], views: [], items: [] });
  });

  it(
    "delivers only to the tenant in scope, with the plan names in the language of that tenant's user, and leaves another tenant that also lacks the module unchanged and unable to read the delivered rows",
    async () => {
      const tenantId = await seededTenant("en");
      const other = await seededTenant("cs");
      await revertToOldShape(tenantId);
      await revertToOldShape(other);
      const otherBefore = await tenantRows(other);

      await runInTenant(tenantId, () => runSleepModuleCutoverMigration(dataPool));

      expect(await tenantRows(other)).toEqual(otherBefore);
      expect(await sleepDelivery(other)).toEqual(NO_SLEEP_MODULE);
      const delivered = await sleepDelivery(tenantId);
      expect(delivered.databases.map((database) => database.items)).toEqual([
        [EXPECTED_SETTINGS],
        expectedPlans("Weekdays", "Weekend"),
        [],
      ]);
      expect(rowCounts(await sleepRows(tenantId))).toEqual(DELIVERED_ROW_COUNTS);
      // No sleep database was written under any other tenant's id.
      const { rows: owners } = await adminPool.query<{ tenant_id: string; count: number }>(
        `SELECT tenant_id, count(*)::int AS count FROM databases
          WHERE owner_module_id = ANY($1::text[]) GROUP BY tenant_id`,
        [SLEEP_KEYS],
      );
      expect(owners).toEqual([{ tenant_id: tenantId, count: 3 }]);

      const chokePoint = createChokePoint(dataPool);
      const ids = await sleepIds(tenantId);
      expect(ids.map((entry) => entry.itemIds.length)).toEqual([1, 2, 0]);
      await runInTenant(other, async () => {
        for (const { databaseId, itemIds } of ids) {
          expect(await chokePoint.getDatabase(databaseId)).toBeNull();
          for (const itemId of itemIds) expect(await chokePoint.getItem(databaseId, itemId)).toBeNull();
        }
      });
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "rolls the whole delivery back when the seed fails part-way, leaving no Sleep project and no sleep database behind",
    async () => {
      const tenantId = await seededTenant("cs");
      await revertToOldShape(tenantId);
      // A system database that holds the key `sleepPlans` under another owner module: no production path creates
      // one, it only makes the seed's second database insert fail after the project item and the `sleepSettings`
      // database were inserted.
      await inTenant(tenantId, (client) =>
        databasesStore.createDatabase(client, {
          name: "Key holder",
          key: SLEEP_PLANS_MODULE_ID,
          system: true,
          ownerModuleId: "sleepPlansKeyHolder",
        }),
      );
      const before = await tenantRows(tenantId);

      await expect(runInTenant(tenantId, () => runSleepModuleCutoverMigration(dataPool))).rejects.toBeInstanceOf(
        ConflictError,
      );

      expect(await tenantRows(tenantId)).toEqual(before);
      expect(await sleepDelivery(tenantId)).toEqual(NO_SLEEP_MODULE);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  describe("concurrency", () => {
    const deadline = <T>(promise: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 20_000);
      });
      return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
    };

    /** The backends `holderPid` blocks; bounded: each probe is one short statement and the probes stop. */
    async function waitingOn(holderPid: number, expected: number): Promise<number[]> {
      let waiting: number[] = [];
      for (let probe = 0; probe < 4000 && waiting.length < expected; probe += 1) {
        const { rows } = await adminPool.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [holderPid],
        );
        waiting = rows.map((row) => row.pid);
      }
      return waiting;
    }

    it(
      "waits for the tenant's seed lock, so of two cutovers of a tenant without the module exactly one seeds",
      async () => {
        const tenantId = await seededTenant("cs");
        await revertToOldShape(tenantId);
        // A transaction on its own admin connection, in the tenant's scope, that holds the seed lock.
        const holder = await adminPool.connect();
        let runs: Promise<void>[] = [];
        let outcomes: PromiseSettledResult<void>[];
        try {
          await holder.query("BEGIN");
          await holder.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
          const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const holderPid = rows[0]?.pid;
          if (holderPid === undefined) throw new Error("The lock holder has no backend pid");
          await lockTenantSeedInTransaction(holder, "test seed lock holder");
          runs = [1, 2].map(() => runInTenant(tenantId, () => runSleepModuleCutoverMigration(dataPool)));
          // Both wait for the seed lock before their existence check.
          expect(await waitingOn(holderPid, 2)).toHaveLength(2);
          await holder.query("COMMIT");
        } finally {
          holder.release(true);
          outcomes = await deadline(Promise.allSettled(runs), "both cutovers to settle");
        }

        expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
        expect(rowCounts(await sleepRows(tenantId))).toEqual(DELIVERED_ROW_COUNTS);
        const { rows: projects } = await adminPool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM items WHERE tenant_id = $1 AND properties->>'name' = 'Sleep'",
          [tenantId],
        );
        expect(projects).toEqual([{ count: 1 }]);
        const delivered = await sleepDelivery(tenantId);
        expect(delivered.databases.map((database) => database.items)).toEqual([
          [EXPECTED_SETTINGS],
          expectedPlans("Pracovní dny", "Víkend"),
          [],
        ]);
      },
      SEEDING_TEST_TIMEOUT_MS,
    );
  });
});
