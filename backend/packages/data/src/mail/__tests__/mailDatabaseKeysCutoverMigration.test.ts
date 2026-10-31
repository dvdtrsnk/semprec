import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createDatabase } from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { runMailDatabaseKeysCutoverMigration } from "../mailDatabaseKeysCutoverMigration.js";

const keys = ["emails", "folders", "mailboxes"];
let admin: Pool;
let pool: Pool;
let tenant: string;

async function rows() {
  return (
    await pool.query<{ id: string; key: string | null; name: string | null; owner_module_id: string; xmin: string }>(
      "SELECT id, key, name, owner_module_id, xmin::text AS xmin FROM databases WHERE system AND owner_module_id = ANY($1::text[]) ORDER BY owner_module_id",
      [keys],
    )
  ).rows;
}
async function makeLegacy() {
  // A populated tenant created before mail seeds began setting canonical keys.
  await pool.query("UPDATE databases SET key = NULL WHERE system AND owner_module_id = ANY($1::text[])", [keys]);
}

describe("mail database key cutover", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("seeds all three keys and repairs legacy rows once without changing their identities", async () => {
    await runInTenant(tenant, async () => {
      const seeded = await rows();
      expect(seeded.map((row) => row.key)).toEqual(keys);
      await makeLegacy();
      const legacy = await rows();
      await runMailDatabaseKeysCutoverMigration(pool);
      const repaired = await rows();
      expect(repaired.map((row) => row.key)).toEqual(keys);
      expect(repaired.map(({ id, name, owner_module_id }) => ({ id, name, owner_module_id }))).toEqual(
        legacy.map(({ id, name, owner_module_id }) => ({ id, name, owner_module_id })),
      );
      await runMailDatabaseKeysCutoverMigration(pool);
      expect(await rows()).toEqual(repaired);
    });
  });

  it("repairs only the scoped tenant and skips an unseeded tenant", async () => {
    const other = await createTestTenant(admin);
    await runInTenant(other, () => seedSystem(pool));
    await runInTenant(tenant, makeLegacy);
    await runInTenant(other, makeLegacy);
    await runInTenant(tenant, () => runMailDatabaseKeysCutoverMigration(pool));
    expect(await runInTenant(tenant, rows).then((result) => result.map((row) => row.key))).toEqual(keys);
    expect(await runInTenant(other, rows).then((result) => result.map((row) => row.key))).toEqual([null, null, null]);
    const empty = await createTestTenant(admin);
    await runInTenant(empty, () => runMailDatabaseKeysCutoverMigration(pool));
    expect(await runInTenant(empty, rows)).toEqual([]);
  });

  it("repairs a present legacy mail database when the other two do not exist", async () => {
    const partial = await createTestTenant(admin);
    await runInTenant(partial, async () => {
      await withTransaction(pool, (client) =>
        createDatabase(client, { name: "Emails", system: true, ownerModuleId: "emails" }),
      );
      await runMailDatabaseKeysCutoverMigration(pool);
      expect((await rows()).map((row) => row.key)).toEqual(["emails"]);
    });
  });

  it.each(["unexpected", "collision"] as const)("rolls back all repairs on %s", async (kind) => {
    await runInTenant(tenant, async () => {
      await makeLegacy();
      if (kind === "unexpected") {
        await pool.query("UPDATE databases SET key = 'legacyEmails' WHERE owner_module_id = 'emails' AND system");
      } else {
        await pool.query("UPDATE databases SET key = 'emails' WHERE owner_module_id = 'projects' AND system");
      }
      const before = await rows();
      await expect(runMailDatabaseKeysCutoverMigration(pool)).rejects.toThrow();
      expect(await rows()).toEqual(before);
    });
  });
});
