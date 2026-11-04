import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createUser } from "../../auth/usersStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { reindexPersonEmails } from "../../mail/personEmailIndexStore.js";
import { withTransaction } from "../../db/pool.js";
import { getSelfPersonId, setSelfPersonId } from "../../selfPerson.js";
import { runSelfPersonCutoverMigration } from "../selfPersonCutoverMigration.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
const email = "owner@example.com";
const read = () => withTransaction(pool, getSelfPersonId);
async function createPerson(address = email) {
  const people = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "people"));
  if (!people) throw new Error("People missing");
  const person = await createChokePoint(pool).createItem({
    databaseId: people.id,
    properties: { name: "Owner", emails: address },
  });
  const indexed = await withTransaction(pool, (client) => reindexPersonEmails(client, person.id, [address]));
  return { person, indexed };
}
async function removeSelfPersonSchema() {
  // Emulate the old populated schema; fixture cleanup is deliberately direct SQL.
  await pool.query(`DELETE FROM properties p USING databases d
    WHERE p.database_id = d.id AND d.owner_module_id = 'systemSettings' AND p.key = 'selfPerson'`);
}
async function shape() {
  const { rows } = await pool.query<{
    owner: string;
    locked: boolean;
    type: string;
    cardinality: string;
    property_id_b: string | null;
  }>(
    `SELECT p.owner, p.locked, p.type, rd.cardinality, rd.property_id_b FROM properties p
     JOIN databases d ON d.id = p.database_id JOIN relation_definitions rd ON rd.property_id_a = p.id
     WHERE d.owner_module_id = 'systemSettings' AND p.key = 'selfPerson'`,
  );
  return rows;
}

describe("self person tenant cutover", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:verify-runtime-role", () =>
      pool.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ role_name: "semprec_data", rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runAsSystem("self person cutover test", () =>
      createUser(admin, { tenantId: tenant, email, passwordHash: "unused-test-hash" }),
    );
    await runInTenant(tenant, () => seedSystem(pool));
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("seeds a one-way user-owned one-to-one relation and leaves an unmatched account unset", async () =>
    runInTenant(tenant, async () => {
      expect(await shape()).toEqual([
        { owner: "user", locked: true, type: "relation", cardinality: "one_to_one", property_id_b: null },
      ]);
      await runSelfPersonCutoverMigration(pool);
      expect(await read()).toBeNull();
    }));
  it("runs the registered self-person migration through the tenant cutover runner", async () => {
    const person = await runInTenant(tenant, async () => {
      const { person } = await createPerson();
      expect(await read()).toBeNull();
      return person;
    });
    await runTenantCutoverMigrations(pool);
    expect(await runInTenant(tenant, read)).toBe(person.id);
  });
  it("adds the missing locked schema, fills a normalized email match once, and preserves a chosen person", async () =>
    runInTenant(tenant, async () => {
      const { person } = await createPerson("OWNER@EXAMPLE.COM");
      await removeSelfPersonSchema();
      expect(await shape()).toEqual([]);
      await runSelfPersonCutoverMigration(pool);
      expect(await shape()).toEqual([
        { owner: "user", locked: true, type: "relation", cardinality: "one_to_one", property_id_b: null },
      ]);
      expect(await read()).toBe(person.id);
      const before = await pool.query<{ id: string }>("SELECT id FROM item_relations ORDER BY id");
      await runSelfPersonCutoverMigration(pool);
      expect((await pool.query<{ id: string }>("SELECT id FROM item_relations ORDER BY id")).rows).toEqual(before.rows);
      const { person: chosen } = await createPerson("chosen@example.com");
      await withTransaction(pool, (client) => setSelfPersonId(client, chosen.id));
      await runSelfPersonCutoverMigration(pool);
      expect(await read()).toBe(chosen.id);
    }));
  it("does not invent a match, create a person or link a deleted index target", async () =>
    runInTenant(tenant, async () => {
      const { person } = await createPerson();
      await createChokePoint(pool).softDeleteItem(person.databaseId, person.id);
      await removeSelfPersonSchema();
      await runSelfPersonCutoverMigration(pool);
      expect(await read()).toBeNull();
      const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM items WHERE database_id = $1", [
        person.databaseId,
      ]);
      expect(rows[0]?.count).toBe("1");
    }));
  it("keeps the first address owner when a second person lists the same address", async () =>
    runInTenant(tenant, async () => {
      const first = await createPerson();
      const second = await createPerson();
      expect(second.indexed.conflicts).toEqual([email]);
      await runSelfPersonCutoverMigration(pool);
      expect(await read()).toBe(first.person.id);
    }));
  it("fills only the scoped tenant even when both tenants use the same contact address", async () => {
    const other = await createTestTenant(admin);
    await runInTenant(other, async () => {
      await seedSystem(pool);
      await createPerson();
    });
    await runInTenant(tenant, async () => {
      await runSelfPersonCutoverMigration(pool);
      expect(await read()).toBeNull();
    });
    await runInTenant(other, async () => {
      expect(await read()).toBeNull();
    });
  });
  it("skips an unseeded tenant", async () => {
    const empty = await createTestTenant(admin);
    await runInTenant(empty, async () => {
      await runSelfPersonCutoverMigration(pool);
      expect(await read()).toBeNull();
    });
  });
});
