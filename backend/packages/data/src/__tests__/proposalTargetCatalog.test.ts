import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@alldots/shared";
import { setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import {
  buildTargetCatalog,
  MAX_CATALOG_TEXT_PROPERTIES,
  MAX_CATALOG_TEXT_VALUE_LENGTH,
  MAX_CATALOG_TEXT_VALUES,
  type TargetCatalog,
} from "../inbox/proposalTargetCatalog.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;

interface Fixture {
  tenant: string;
  projectItemId: string;
  healthId: string;
  writer: ReturnType<typeof createChokePoint>;
}

async function setup(): Promise<Fixture> {
  const tenant = await createTestTenant(admin);
  return runInTenant(tenant, async () => {
    await seedSystem(runtime);
    const health = await runtime.query<{ id: string }>(
      "SELECT id FROM databases WHERE owner_module_id = 'healthRecords'",
    );
    if (!health.rows[0]) throw new Error("Missing Health records database");
    return {
      tenant,
      projectItemId: await createTestProjectItem(runtime),
      healthId: health.rows[0].id,
      writer: createChokePoint(runtime),
    };
  });
}

function catalogOf(
  fixture: Fixture,
  databaseId: string,
  locale: string,
  projectItemId = fixture.projectItemId,
  tenant = fixture.tenant,
): Promise<TargetCatalog> {
  return runInTenant(tenant, () =>
    withTransaction(runtime, async (client) => {
      await client.query("SET TRANSACTION READ ONLY");
      return buildTargetCatalog(client, databaseId, locale, projectItemId);
    }),
  );
}

async function createRecords(fixture: Fixture, subjects: Array<string | undefined>): Promise<string[]> {
  return runInTenant(fixture.tenant, async () => {
    const ids: string[] = [];
    for (const subject of subjects) {
      const item = await fixture.writer.createItem({
        databaseId: fixture.healthId,
        properties: { name: `Record ${ids.length}`, ...(subject === undefined ? {} : { subject }) },
      });
      ids.push(item.id);
    }
    return ids;
  });
}

function grant(fixture: Fixture, access: "none" | "read"): Promise<void> {
  return runInTenant(fixture.tenant, () =>
    withTransaction(runtime, async (client) => {
      await setAgentDatabaseGrant(client, {
        projectItemId: fixture.projectItemId,
        databaseId: fixture.healthId,
        access,
      });
    }),
  );
}

function optionsOf(catalog: TargetCatalog, propertyKey: string) {
  return catalog.selects.find((select) => select.propertyKey === propertyKey)?.options;
}

describe("buildTargetCatalog (issue gh-1990)", () => {
  beforeEach(async () => {
    admin ??= getTestPool();
    runtime ??= await createRuntimeRolePool(admin, "alldots_data");
    await resetDatabase(admin);
  });
  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  describe("Health records", () => {
    it("lists type, status and tags with Czech labels and the subjects in use with their counts", async () => {
      const f = await setup();
      await grant(f, "read");
      await createRecords(f, ["David", "David", "David", "Heduš", "Max (pes)", undefined]);
      const [trashed] = await createRecords(f, ["Trashed subject"]);
      await runInTenant(f.tenant, () => f.writer.softDeleteItem(f.healthId, trashed!));

      const catalog = await catalogOf(f, f.healthId, "cs");

      expect(catalog.selects.map((select) => select.propertyKey).sort()).toEqual(["status", "tags", "type"]);
      expect(optionsOf(catalog, "status")).toEqual([
        { key: "monitoring", label: "Sleduje se" },
        { key: "resolved", label: "Vyřešeno" },
      ]);
      expect(optionsOf(catalog, "type")).toEqual([
        { key: "health", label: "Zdraví" },
        { key: "condition", label: "Stav" },
        { key: "symptom", label: "Příznak" },
      ]);
      expect(optionsOf(catalog, "tags")).toEqual([
        { key: "bloodTests", label: "Krevní testy" },
        { key: "medication", label: "Léky" },
        { key: "epilepsy", label: "Epilepsie" },
        { key: "dentalHygiene", label: "Dentální hygiena" },
        { key: "bloodPressure", label: "Krevní tlak" },
        { key: "prevention", label: "Prevence" },
      ]);
      expect(catalog.selects.map((select) => [select.propertyKey, select.multi]).sort()).toEqual([
        ["status", false],
        ["tags", true],
        ["type", false],
      ]);
      expect(catalog.textValues).toEqual([
        {
          propertyKey: "subject",
          values: [
            { value: "David", count: 3 },
            { value: "Heduš", count: 1 },
            { value: "Max (pes)", count: 1 },
          ],
        },
      ]);
      // The title is never listed: not as a property and not as a value, and a trashed record is not counted.
      const serialized = JSON.stringify(catalog);
      expect(serialized).not.toContain("Record ");
      expect(serialized).not.toContain("Trashed subject");
    });

    it("lists the English labels for an English user and for a locale that is neither Czech nor English", async () => {
      const f = await setup();
      await grant(f, "read");
      await createRecords(f, ["David"]);

      for (const locale of ["en", "de"]) {
        const catalog = await catalogOf(f, f.healthId, locale);
        expect(optionsOf(catalog, "tags")).toContainEqual({ key: "bloodPressure", label: "Blood pressure" });
        expect(optionsOf(catalog, "status")).toEqual([
          { key: "monitoring", label: "Monitoring" },
          { key: "resolved", label: "Resolved" },
        ]);
        expect(catalog.textValues).toEqual([{ propertyKey: "subject", values: [{ value: "David", count: 1 }] }]);
      }
    });

    it("lists no value of Health records, a sensitive database, without a grant and the options all the same", async () => {
      const f = await setup();
      await createRecords(f, ["David"]);

      const closed = await catalogOf(f, f.healthId, "cs");
      expect(closed.textValues).toEqual([]);
      expect(optionsOf(closed, "tags")).toContainEqual({ key: "bloodPressure", label: "Krevní tlak" });
      expect(JSON.stringify(closed)).not.toContain("David");

      await grant(f, "read");
      expect((await catalogOf(f, f.healthId, "cs")).textValues).toEqual([
        { propertyKey: "subject", values: [{ value: "David", count: 1 }] },
      ]);

      await grant(f, "none");
      const revoked = await catalogOf(f, f.healthId, "cs");
      expect(revoked.textValues).toEqual([]);
      expect(revoked.selects).toHaveLength(3);
    });

    it("lists the values for the project of a sensitive database only when that project holds the grant", async () => {
      const f = await setup();
      await createRecords(f, ["David"]);
      await grant(f, "read");
      const otherProjectItemId = await runInTenant(f.tenant, () => createTestProjectItem(runtime));

      expect((await catalogOf(f, f.healthId, "cs", otherProjectItemId)).textValues).toEqual([]);
      expect((await catalogOf(f, f.healthId, "cs", f.projectItemId)).textValues).toHaveLength(1);
    });
  });

  describe("a user-created database", () => {
    async function createCustomDatabase(f: Fixture, textKeys: string[]) {
      return runInTenant(f.tenant, async () => {
        const database = await f.writer.createDatabase({ name: "Custom" });
        for (const key of textKeys)
          await f.writer.createProperty({ databaseId: database.id, key, name: key, type: "text" });
        return database;
      });
    }

    it("lists a select with stored labels and a key without one, and flags a multi_select", async () => {
      const f = await setup();
      const database = await createCustomDatabase(f, []);
      await runInTenant(f.tenant, async () => {
        await f.writer.createProperty({
          databaseId: database.id,
          key: "kind",
          name: "Kind",
          type: "select",
          config: { options: [{ key: "alpha", label: "Alpha label" }, { key: "beta" }] },
        });
        await f.writer.createProperty({
          databaseId: database.id,
          key: "labels",
          name: "Labels",
          type: "multi_select",
          config: { options: [{ key: "one" }] },
        });
        await f.writer.createProperty({
          databaseId: database.id,
          key: "empty",
          name: "Empty",
          type: "select",
          config: { options: [] },
        });
      });

      const catalog = await catalogOf(f, database.id, "cs");

      expect(catalog.selects).toEqual([
        { propertyKey: "empty", multi: false, options: [] },
        {
          propertyKey: "kind",
          multi: false,
          options: [
            { key: "alpha", label: "Alpha label" },
            { key: "beta", label: "beta" },
          ],
        },
        { propertyKey: "labels", multi: true, options: [{ key: "one", label: "one" }] },
      ]);
      expect(catalog.textValues).toEqual([]);
    });

    it("leaves out a select and a text property that a system process owns", async () => {
      const f = await setup();
      const database = await createCustomDatabase(f, ["mine", "managed"]);
      await runInTenant(f.tenant, async () => {
        for (const key of ["ownSelect", "managedSelect"])
          await f.writer.createProperty({
            databaseId: database.id,
            key,
            name: key,
            type: "select",
            config: { options: [{ key: "a" }] },
          });
        await f.writer.createItem({ databaseId: database.id, properties: { mine: "kept", managed: "managed value" } });
      });
      await admin.query(
        "UPDATE properties SET owner = 'system', owner_process = 'calendar' WHERE database_id = $1 AND key = ANY($2::text[])",
        [database.id, ["managed", "managedSelect"]],
      );

      const catalog = await catalogOf(f, database.id, "en");

      expect(catalog.selects.map((select) => select.propertyKey)).toEqual(["ownSelect"]);
      expect(catalog.textValues).toEqual([{ propertyKey: "mine", values: [{ value: "kept", count: 1 }] }]);
    });

    it("reads the values of the first five text properties only", async () => {
      const f = await setup();
      const keys = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"];
      const database = await createCustomDatabase(f, keys);
      await runInTenant(f.tenant, async () => {
        await f.writer.createItem({
          databaseId: database.id,
          properties: Object.fromEntries(keys.map((key) => [key, `value ${key}`])),
        });
      });

      const catalog = await catalogOf(f, database.id, "en");

      expect(MAX_CATALOG_TEXT_PROPERTIES).toBe(5);
      expect(catalog.textValues.map((entry) => entry.propertyKey)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    });

    it("lists the most frequent values first, leaves out a text that is too long and keeps the rest of the twenty", async () => {
      const f = await setup();
      const database = await createCustomDatabase(f, ["place", "unused"]);
      const long = "x".repeat(MAX_CATALOG_TEXT_VALUE_LENGTH + 1);
      const exact = "y".repeat(MAX_CATALOG_TEXT_VALUE_LENGTH);
      const place = (n: number) => `place ${String(n).padStart(2, "0")}`;
      await runInTenant(f.tenant, async () => {
        const store = async (value: string, copies: number) => {
          for (let copy = 0; copy < copies; copy++)
            await f.writer.createItem({ databaseId: database.id, properties: { place: value } });
        };
        await store(long, 5);
        await store(exact, 4);
        for (let n = 0; n < 24; n++) await store(place(n), n === 23 ? 3 : n === 22 ? 2 : 1);
      });

      const catalog = await catalogOf(f, database.id, "en");

      // 26 values stored, the facet lists the 20 most frequent; the long text among them is dropped, leaving 19.
      expect(MAX_CATALOG_TEXT_VALUES).toBe(20);
      expect(catalog.textValues).toEqual([
        {
          propertyKey: "place",
          values: [
            { value: exact, count: 4 },
            { value: place(23), count: 3 },
            { value: place(22), count: 2 },
            ...Array.from({ length: 16 }, (_, n) => ({ value: place(n), count: 1 })),
          ],
        },
      ]);
    });

    it("keeps a value of exactly the longest allowed length", async () => {
      const f = await setup();
      const database = await createCustomDatabase(f, ["place"]);
      const exact = "y".repeat(MAX_CATALOG_TEXT_VALUE_LENGTH);
      await runInTenant(f.tenant, () => f.writer.createItem({ databaseId: database.id, properties: { place: exact } }));

      expect((await catalogOf(f, database.id, "en")).textValues).toEqual([
        { propertyKey: "place", values: [{ value: exact, count: 1 }] },
      ]);
    });
  });

  describe("tenancy", () => {
    it("never lists a value or an option of another tenant and gives an empty catalog for its database", async () => {
      const a = await setup();
      const b = await setup();
      await createRecords(a, ["Own subject"]);
      await createRecords(b, ["Foreign subject"]);
      await grant(a, "read");
      await grant(b, "read");
      const foreign = await runInTenant(b.tenant, async () => {
        const database = await b.writer.createDatabase({ name: "Foreign" });
        await b.writer.createProperty({
          databaseId: database.id,
          key: "foreignSelect",
          name: "Foreign",
          type: "select",
          config: { options: [{ key: "foreignOption" }] },
        });
        return database;
      });

      const own = await catalogOf(a, a.healthId, "cs");
      expect(JSON.stringify(own)).toContain("Own subject");
      expect(JSON.stringify(own)).not.toContain("Foreign subject");
      expect(JSON.stringify(own)).not.toContain("foreignOption");

      // The foreign database id, asked for under tenant A, is as absent as an id that never existed.
      expect(await catalogOf(a, foreign.id, "cs")).toEqual({ selects: [], textValues: [] });
      expect(await catalogOf(a, b.healthId, "cs")).toEqual({ selects: [], textValues: [] });
      expect(await catalogOf(a, "00000000-0000-4000-8000-000000000000", "cs")).toEqual({
        selects: [],
        textValues: [],
      });
    });
  });
});
