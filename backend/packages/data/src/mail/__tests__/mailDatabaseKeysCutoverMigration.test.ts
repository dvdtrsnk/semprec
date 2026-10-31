import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestModuleItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
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
      const itemId = await createTestModuleItem(pool, "emails");
      const email = seeded.find((row) => row.owner_module_id === "emails");
      if (!email) throw new Error("Missing Emails database");
      const content = () =>
        pool.query<{ id: string; database_id: string; properties: unknown }>(
          "SELECT id, database_id, properties FROM items WHERE database_id = $1 AND id = $2",
          [email.id, itemId],
        );
      const relations = () =>
        pool.query<{ id: string }>(
          "SELECT r.id FROM relation_definitions r JOIN properties p ON p.id = r.property_id_a WHERE p.database_id = $1 ORDER BY r.id",
          [email.id],
        );
      const beforeContent = (await content()).rows;
      const beforeRelations = (await relations()).rows;
      expect(beforeContent).toHaveLength(1);
      expect(beforeRelations.length).toBeGreaterThan(0);
      await makeLegacy();
      const legacy = await rows();
      await runMailDatabaseKeysCutoverMigration(pool);
      const repaired = await rows();
      expect(repaired.map((row) => row.key)).toEqual(keys);
      expect(repaired.map(({ id, name, owner_module_id }) => ({ id, name, owner_module_id }))).toEqual(
        legacy.map(({ id, name, owner_module_id }) => ({ id, name, owner_module_id })),
      );
      expect((await content()).rows).toEqual(beforeContent);
      expect((await relations()).rows).toEqual(beforeRelations);
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

  it("rolls back an earlier update when a later key update fails", async () => {
    await runInTenant(tenant, makeLegacy);
    await admin.query(`CREATE FUNCTION test_fail_mail_key() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.key = 'folders' THEN RAISE EXCEPTION 'test later update failure'; END IF; RETURN NEW; END $$`);
    await admin.query(
      "CREATE TRIGGER test_fail_mail_key BEFORE UPDATE OF key ON databases FOR EACH ROW EXECUTE FUNCTION test_fail_mail_key()",
    );
    try {
      const before = await runInTenant(tenant, rows);
      await expect(runInTenant(tenant, () => runMailDatabaseKeysCutoverMigration(pool))).rejects.toThrow(
        "test later update failure",
      );
      expect(await runInTenant(tenant, rows)).toEqual(before);
    } finally {
      await admin.query("DROP TRIGGER test_fail_mail_key ON databases");
      await admin.query("DROP FUNCTION test_fail_mail_key()");
    }
  });

  it("serializes overlapping cutovers and rolls back on a concurrent key collision without blocking another tenant", async () => {
    const other = await createTestTenant(admin);
    await runInTenant(other, () => seedSystem(pool));
    await runInTenant(tenant, makeLegacy);
    await runInTenant(other, makeLegacy);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal: (pid: number) => void = () => {};
    let fail: (reason: unknown) => void = () => {};
    const ready = new Promise<number>((resolve, reject) => {
      signal = resolve;
      fail = reject;
    });
    const holder = runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        try {
          await client.query(
            "SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND owner_module_id = 'mailboxes' AND system FOR UPDATE",
          );
          const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const pid = result.rows[0]?.pid;
          if (pid === undefined) throw new Error("Missing lock holder pid");
          signal(pid);
          await gate;
        } catch (error) {
          fail(error);
          throw error;
        }
      }),
    );
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    try {
      const holderPid = await ready;
      first = runInTenant(tenant, () => runMailDatabaseKeysCutoverMigration(pool)).then(
        () => null,
        (error: unknown) => error,
      );
      let firstPid = 0;
      await expect
        .poll(
          async () => {
            const result = await admin.query<{ pid: number }>(
              "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
              [holderPid],
            );
            firstPid = result.rows[0]?.pid ?? 0;
            return firstPid > 0;
          },
          { timeout: 5000 },
        )
        .toBe(true);
      second = runInTenant(tenant, () => runMailDatabaseKeysCutoverMigration(pool)).then(
        () => null,
        (error: unknown) => error,
      );
      await expect
        .poll(
          async () => {
            const result = await admin.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
              [firstPid],
            );
            return result.rows[0]?.count;
          },
          { timeout: 5000 },
        )
        .toBe("1");
      await runInTenant(other, () => runMailDatabaseKeysCutoverMigration(pool));
      expect((await runInTenant(other, rows)).map((row) => row.key)).toEqual(keys);
      await runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          createDatabase(client, {
            name: "Key collision",
            key: "mailboxes",
            system: true,
            ownerModuleId: "collisionFixture",
          }),
        ),
      );
      release();
      await holder;
      expect(await first).toBeInstanceOf(Error);
      expect(await second).toBeInstanceOf(Error);
      expect((await runInTenant(tenant, rows)).map((row) => row.key)).toEqual([null, null, null]);
    } finally {
      release();
      await Promise.allSettled([holder, ...(first ? [first] : []), ...(second ? [second] : [])]);
    }
  });
});
