import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { ValidationError } from "../errors.js";
import { runSensitiveDatabasesCutoverMigration } from "../seed/sensitiveDatabasesCutoverMigration.js";
import { SENSITIVE_DATABASE_KEYS } from "../seed/sensitiveDatabaseKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

// Each test seeds one or two tenants with their couple of dozen system databases.
const SEEDING_TEST_TIMEOUT_MS = 90_000;

const EXPECTED_SENSITIVE_KEYS = ["healthRecords", "sleepNights", "sleepPlans", "sleepSettings"];

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

/** The keys of the tenant's sensitive databases and how many databases it has, read through the runtime role. */
async function sensitiveState(tenantId: string): Promise<{ sensitiveKeys: string[]; databaseCount: number }> {
  const databases = await inTenant(tenantId, (client) => databasesStore.listAllDatabases(client));
  return {
    sensitiveKeys: databases
      .filter((database) => database.sensitive)
      .flatMap((database) => (database.key === null ? [] : [database.key]))
      .sort(),
    databaseCount: databases.length,
  };
}

/**
 * Puts a seeded tenant back into the state of a tenant seeded before issue #1808. The flag is set by the system
 * only and no production path clears it, so the test clears it with raw SQL on the admin pool.
 */
async function clearSensitiveFlags(tenantId: string): Promise<void> {
  await adminPool.query("UPDATE databases SET sensitive = false WHERE tenant_id = $1", [tenantId]);
  expect((await sensitiveState(tenantId)).sensitiveKeys).toEqual([]);
}

/** Every `databases` row of the tenant with its row version, read on the admin pool filtered by the tenant. */
async function databaseVersions(tenantId: string): Promise<Map<string, string>> {
  const { rows } = await adminPool.query<{ key: string; version: string }>(
    "SELECT key, xmin::text AS version FROM databases WHERE tenant_id = $1 AND key IS NOT NULL",
    [tenantId],
  );
  return new Map(rows.map((row) => [row.key, row.version]));
}

describe("sensitive databases (issue #1808)", () => {
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

  it("keeps the four keys in one constant", () => {
    expect([...SENSITIVE_DATABASE_KEYS].sort()).toEqual(EXPECTED_SENSITIVE_KEYS);
  });

  it(
    "marks exactly the four keys sensitive for a newly provisioned tenant",
    async () => {
      const tenantId = await createTestTenant(adminPool, { status: "provisioning" });

      await expect(provisionTenant(dataPool, tenantId)).resolves.toBe("created");

      const state = await sensitiveState(tenantId);
      expect(state.sensitiveKeys).toEqual(EXPECTED_SENSITIVE_KEYS);
      // The other databases exist and are not sensitive.
      expect(state.databaseCount).toBeGreaterThan(EXPECTED_SENSITIVE_KEYS.length);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "marks the same four databases sensitive when the cutover runs on a tenant seeded before the flag",
    async () => {
      const tenantId = await seededTenant();
      await clearSensitiveFlags(tenantId);
      const before = await databaseVersions(tenantId);

      await runAsSystem("test sensitive cutover", () => runTenantCutoverMigrations(dataPool));

      const state = await sensitiveState(tenantId);
      expect(state.sensitiveKeys).toEqual(EXPECTED_SENSITIVE_KEYS);
      expect(state.databaseCount).toBeGreaterThan(EXPECTED_SENSITIVE_KEYS.length);
      // Only the four rows were written: every other database keeps its row version.
      const after = await databaseVersions(tenantId);
      const rewritten = [...after.keys()].filter((key) => after.get(key) !== before.get(key)).sort();
      expect(rewritten).toEqual(EXPECTED_SENSITIVE_KEYS);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "changes no row when the cutover runs a second time",
    async () => {
      const tenantId = await seededTenant();
      await clearSensitiveFlags(tenantId);
      await runAsSystem("test sensitive cutover", () => runTenantCutoverMigrations(dataPool));
      const afterFirst = await databaseVersions(tenantId);

      await runAsSystem("test sensitive cutover", () => runTenantCutoverMigrations(dataPool));

      expect(await databaseVersions(tenantId)).toEqual(afterFirst);
      expect((await sensitiveState(tenantId)).sensitiveKeys).toEqual(EXPECTED_SENSITIVE_KEYS);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "marks only the databases of the tenant whose scope it runs in, and reports how many it marked",
    async () => {
      const tenantA = await seededTenant();
      const tenantB = await seededTenant();
      await clearSensitiveFlags(tenantA);
      await clearSensitiveFlags(tenantB);

      const first = await runInTenant(tenantA, () => runSensitiveDatabasesCutoverMigration(dataPool));
      const second = await runInTenant(tenantA, () => runSensitiveDatabasesCutoverMigration(dataPool));

      expect(first).toBe(EXPECTED_SENSITIVE_KEYS.length);
      expect(second).toBe(0);
      expect((await sensitiveState(tenantA)).sensitiveKeys).toEqual(EXPECTED_SENSITIVE_KEYS);
      expect((await sensitiveState(tenantB)).sensitiveKeys).toEqual([]);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it("does nothing for a tenant that has none of the databases", async () => {
    const tenantId = await createTestTenant(adminPool);

    const marked = await runInTenant(tenantId, () => runSensitiveDatabasesCutoverMigration(dataPool));

    expect(marked).toBe(0);
    expect(await sensitiveState(tenantId)).toEqual({ sensitiveKeys: [], databaseCount: 0 });
  });

  it("leaves a system database outside the four keys not sensitive", async () => {
    const tenantId = await createTestTenant(adminPool);
    await inTenant(tenantId, (client) =>
      databasesStore.createDatabase(client, { name: null, key: "tasks", system: true, ownerModuleId: "tasks" }),
    );

    const marked = await runInTenant(tenantId, () => runSensitiveDatabasesCutoverMigration(dataPool));

    expect(marked).toBe(0);
    expect(await sensitiveState(tenantId)).toEqual({ sensitiveKeys: [], databaseCount: 1 });
  });

  describe("createDatabase", () => {
    it("creates a system database as sensitive when asked and stores the flag", async () => {
      const tenantId = await createTestTenant(adminPool);

      const created = await inTenant(tenantId, (client) =>
        databasesStore.createDatabase(client, {
          name: null,
          key: "healthRecords",
          system: true,
          ownerModuleId: "healthRecords",
          sensitive: true,
        }),
      );

      expect(created.sensitive).toBe(true);
      const stored = await inTenant(tenantId, (client) => databasesStore.getDatabase(client, created.id));
      expect(stored?.sensitive).toBe(true);
    });

    it("creates a system database that does not ask for it as not sensitive", async () => {
      const tenantId = await createTestTenant(adminPool);

      const created = await inTenant(tenantId, (client) =>
        databasesStore.createDatabase(client, { name: null, key: "tasks", system: true, ownerModuleId: "tasks" }),
      );

      expect(created.sensitive).toBe(false);
    });

    it("creates a non-system database that sets the flag to false", async () => {
      const tenantId = await createTestTenant(adminPool);

      const created = await inTenant(tenantId, (client) =>
        databasesStore.createDatabase(client, { name: "Wine cellar", sensitive: false }),
      );

      expect(created.sensitive).toBe(false);
    });

    it("refuses to create a non-system database as sensitive and writes no row", async () => {
      const tenantId = await createTestTenant(adminPool);

      const refused = inTenant(tenantId, (client) =>
        databasesStore.createDatabase(client, { name: "Wine cellar", sensitive: true }),
      );

      await expect(refused).rejects.toBeInstanceOf(ValidationError);
      await expect(refused).rejects.toMatchObject({ details: { field: "sensitive" } });
      expect(await sensitiveState(tenantId)).toEqual({ sensitiveKeys: [], databaseCount: 0 });
    });
  });

  it("lets an insert of the previous release, which omits the column, create a database that is not sensitive", async () => {
    const tenantId = await createTestTenant(adminPool);

    // Raw SQL: the statement of the previous release, which does not name the column.
    const inserted = await withTenantTransaction(adminPool, tenantId, async (client) => {
      const result = await client.query<{ sensitive: boolean }>(
        "INSERT INTO databases (name) VALUES ('Previous release') RETURNING sensitive",
      );
      return result.rows;
    });

    expect(inserted).toEqual([{ sensitive: false }]);
  });
});
