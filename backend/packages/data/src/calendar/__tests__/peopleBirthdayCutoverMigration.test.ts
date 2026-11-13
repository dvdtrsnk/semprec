import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { generateSchemaProjection } from "../../manifest/schemaProjection.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { runPeopleBirthdayCutoverMigration } from "../peopleBirthdayCutoverMigration.js";

let admin: Pool;
let pool: Pool;

const KEYS = ["birthday", "birthdayYearKnown"];

interface PropertyShape {
  key: string;
  name: string | null;
  type: string;
  config: unknown;
  locked: boolean;
  owner: string;
  owner_process: string | null;
}

/** A seeded tenant, so its People database holds what a fresh seed creates. */
async function seededTenant(): Promise<string> {
  const tenantId = await createTestTenant(admin);
  await runInTenant(tenantId, () => seedSystem(pool));
  return tenantId;
}

/** The People properties of the tenant in scope, every column the cutover writes. */
async function peopleProperties(): Promise<PropertyShape[]> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<PropertyShape>(
      `SELECT p.key, p.name, p.type, p.config, p.locked, p.owner, p.owner_process
         FROM properties p JOIN databases d ON d.id = p.database_id
        WHERE d.owner_module_id = 'people' ORDER BY p.key`,
    );
    return rows;
  });
}

/** Per-row version of the birthday properties; it changes when the row is written again. */
async function birthdayVersions(): Promise<{ key: string; xmin: string }[]> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ key: string; xmin: string }>(
      `SELECT p.key, p.xmin::text AS xmin
         FROM properties p JOIN databases d ON d.id = p.database_id
        WHERE d.owner_module_id = 'people' AND p.key = ANY($1::text[]) ORDER BY p.key`,
      [KEYS],
    );
    return rows;
  });
}

/** Models a tenant seeded before the cutover; the locked People schema has no public delete path. */
async function removeBirthdayProperties(): Promise<number> {
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `DELETE FROM properties p USING databases d
        WHERE d.id = p.database_id AND d.owner_module_id = 'people' AND p.key = ANY($1::text[])`,
      [KEYS],
    );
    return result.rowCount ?? 0;
  });
}

describe("People birthday cutover (issue #1795)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("seeds both properties as user-owned, unlocked, without a time, and names them in both catalogs", async () => {
    const tenant = await seededTenant();
    await runInTenant(tenant, async () => {
      const byKey = new Map((await peopleProperties()).map((property) => [property.key, property]));
      expect(byKey.get("birthday")).toMatchObject({
        name: null,
        type: "date",
        config: {},
        locked: false,
        owner: "user",
        owner_process: null,
      });
      expect(byKey.get("birthdayYearKnown")).toMatchObject({
        name: null,
        type: "checkbox",
        config: {},
        locked: false,
        owner: "user",
        owner_process: null,
      });
      const registry = await loadFullModuleRegistry();
      for (const [locale, names] of [
        ["cs", { birthday: "Narozeniny", birthdayYearKnown: "Rok znám" }],
        ["en", { birthday: "Birthday", birthdayYearKnown: "Year known" }],
      ] as const) {
        const schema = await withTransaction(pool, (client) => generateSchemaProjection(client, registry, { locale }));
        const properties = schema.databases.find((db) => db.key === "people")?.properties ?? [];
        expect(properties.find((property) => property.key === "birthday")?.name).toBe(names.birthday);
        expect(properties.find((property) => property.key === "birthdayYearKnown")?.name).toBe(names.birthdayYearKnown);
      }
    });
  });

  it("gives a cut-over tenant the same definitions as a fresh seed and keeps its people", async () => {
    const fresh = await seededTenant();
    const freshProperties = await runInTenant(fresh, peopleProperties);
    const freshBirthday = freshProperties.filter((property) => KEYS.includes(property.key));
    expect(freshBirthday).toHaveLength(2);

    const old = await seededTenant();
    await runInTenant(old, async () => {
      const people = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "people"));
      if (!people) throw new Error("People missing");
      const cp = createChokePoint(pool);
      const person = await cp.createItem({ databaseId: people.id, properties: { name: "Existing person" } });
      const original = await cp.getItem(people.id, person.id);
      expect(await removeBirthdayProperties()).toBe(2);
      expect((await peopleProperties()).map((property) => property.key)).toEqual(
        freshProperties.map((property) => property.key).filter((key) => !KEYS.includes(key)),
      );

      await runPeopleBirthdayCutoverMigration(pool);

      // Relation properties carry the ids of their tenant's databases, so the whole list is compared by key.
      const upgraded = await peopleProperties();
      expect(upgraded.map((property) => property.key)).toEqual(freshProperties.map((property) => property.key));
      expect(upgraded.filter((property) => KEYS.includes(property.key))).toEqual(freshBirthday);
      expect(await cp.getItem(people.id, person.id)).toEqual(original);
    });
  });

  it("fills in only the property that is missing", async () => {
    const tenant = await seededTenant();
    await runInTenant(tenant, async () => {
      const fresh = await peopleProperties();
      await withTransaction(pool, (client) =>
        client.query(
          `DELETE FROM properties p USING databases d
            WHERE d.id = p.database_id AND d.owner_module_id = 'people' AND p.key = 'birthdayYearKnown'`,
        ),
      );
      const before = (await birthdayVersions()).filter((row) => row.key === "birthday");

      await runPeopleBirthdayCutoverMigration(pool);

      expect(await peopleProperties()).toEqual(fresh);
      expect((await birthdayVersions()).filter((row) => row.key === "birthday")).toEqual(before);
    });
  });

  it("changes nothing when it runs a second time", async () => {
    const tenant = await seededTenant();
    await runInTenant(tenant, async () => {
      await removeBirthdayProperties();
      await runPeopleBirthdayCutoverMigration(pool);
      const properties = await peopleProperties();
      const versions = await birthdayVersions();
      expect(versions).toHaveLength(2);

      await runPeopleBirthdayCutoverMigration(pool);

      expect(await peopleProperties()).toEqual(properties);
      expect(await birthdayVersions()).toEqual(versions);
    });
  });

  it("skips a tenant without a People database", async () => {
    const empty = await createTestTenant(admin);
    await runInTenant(empty, async () => {
      await runPeopleBirthdayCutoverMigration(pool);
      const { rows } = await withTransaction(pool, (client) =>
        client.query<{ databases: number; properties: number }>(
          "SELECT (SELECT count(*)::int FROM databases) AS databases, (SELECT count(*)::int FROM properties) AS properties",
        ),
      );
      expect(rows).toEqual([{ databases: 0, properties: 0 }]);
    });
  });

  it("does not touch the People of another tenant", async () => {
    const old = await seededTenant();
    const other = await seededTenant();
    await runInTenant(other, removeBirthdayProperties);
    await runInTenant(old, async () => {
      await runPeopleBirthdayCutoverMigration(pool);
      expect((await peopleProperties()).map((property) => property.key)).toEqual(expect.arrayContaining(KEYS));
    });
    await runInTenant(other, async () => {
      expect((await peopleProperties()).map((property) => property.key)).not.toEqual(expect.arrayContaining(KEYS));
    });
  });

  it("runs through the registered tenant maintenance entry point", async () => {
    const tenant = await seededTenant();
    const fresh = await runInTenant(tenant, peopleProperties);
    await runInTenant(tenant, removeBirthdayProperties);

    await runAsSystem("test People birthday cutover", () => runTenantCutoverMigrations(pool));

    expect(await runInTenant(tenant, peopleProperties)).toEqual(fresh);
  });
});
