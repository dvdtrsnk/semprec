import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@alldots/shared";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { SENSITIVE_DATABASE_KEYS } from "../seed/sensitiveDatabaseKeys.js";
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

describe("sensitive databases (issue #1808)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "alldots_data");
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
      expect(state.databaseCount).toBeGreaterThan(EXPECTED_SENSITIVE_KEYS.length);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

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

    // Raw SQL: the previous release's statement, which does not name the column.
    const inserted = await withTenantTransaction(adminPool, tenantId, async (client) => {
      const result = await client.query<{ sensitive: boolean }>(
        "INSERT INTO databases (name) VALUES ('Previous release') RETURNING sensitive",
      );
      return result.rows;
    });

    expect(inserted).toEqual([{ sensitive: false }]);
  });
});
