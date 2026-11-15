import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createPool, withTransaction } from "../db/pool.js";
import { createUser } from "../auth/usersStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { ValidationError } from "../errors.js";
import {
  DEFAULT_INBOX_TYPES,
  SEEDED_DEFAULT_INBOX_TYPES_KEY,
  seedDefaultInboxItemTypes,
  type DefaultInboxTypeSpec,
} from "../inbox/defaultInboxTypes.js";
import { getInboxCatalogs } from "../inbox/inboxCatalogs.js";
import { createInboxTypesRouteHandler } from "../inbox/inboxRouteHandlers.js";
import { assertValidProcessingConfig, deleteInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import { createTestTenant, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import "../domainWriteHooks.js";

let adminPool: Pool;
let dataPool: Pool;
let zero: string;
let b: string;

const ENGLISH_NAMES = ["Idea", "Task", "Event", "Thought", "Mood", "Note", "Contact"];
const CZECH_NAMES = ["Nápad", "Úkol", "Událost", "Myšlenka", "Nálada", "Poznámka", "Kontakt"];
const ALL_KEYS = ["idea", "task", "event", "thought", "mood", "note", "contact"];

const typeRowSchema = z.object({
  id: z.string(),
  deleted_at: z.date().nullable(),
  properties: z.record(z.string(), z.unknown()),
});
type TypeRow = z.infer<typeof typeRowSchema>;

/** All Inbox item types of the tenant, live and trashed, read through the runtime role the tenant scope applies to. */
async function readTypes(tenantId: string): Promise<TypeRow[]> {
  return runInTenant(tenantId, () =>
    withTransaction(dataPool, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT i.id, i.deleted_at, i.properties FROM items i JOIN databases d ON d.id = i.database_id
          WHERE d.owner_module_id = 'inboxItemTypes' ORDER BY i.id`,
      );
      return rows.map((row) => typeRowSchema.parse(row));
    }),
  );
}

function liveNames(types: TypeRow[]): string[] {
  return types.filter((row) => row.deleted_at === null).map((row) => String(row.properties.name));
}

async function readSettings(tenantId: string): Promise<{ marker: unknown; updatedAt: string }> {
  return runInTenant(tenantId, () =>
    withTransaction(dataPool, async (client) => {
      const { rows } = await client.query<{ properties: Record<string, unknown>; updated_at: Date }>(
        `SELECT i.properties, i.updated_at FROM items i JOIN databases d ON d.id = i.database_id
          WHERE d.owner_module_id = 'systemSettings'`,
      );
      const row = rows[0];
      if (!row) throw new Error("System settings row missing");
      return { marker: row.properties[SEEDED_DEFAULT_INBOX_TYPES_KEY], updatedAt: row.updated_at.toISOString() };
    }),
  );
}

async function readMarker(tenantId: string): Promise<string[]> {
  return z.array(z.string()).parse((await readSettings(tenantId)).marker);
}

function seed(tenantId: string, defaults?: readonly DefaultInboxTypeSpec[]): Promise<string[]> {
  return runInTenant(tenantId, () =>
    withTransaction(dataPool, (client) => seedDefaultInboxItemTypes(client, defaults)),
  );
}

async function seedTenant(tenantId: string): Promise<void> {
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
}

/** Gives the tenant its one user, with `locale`. */
async function addUser(tenantId: string, locale: string): Promise<string> {
  const user = await createUser(adminPool, {
    tenantId,
    email: `default-types-${tenantId}@example.test`,
    passwordHash: "unused",
    locale,
  });
  return user.id;
}

/** Hides (or shows again) the system database of `moduleId` from its module-id lookup; no production write can remove a system database. */
async function setModuleId(tenantId: string, from: string, to: string): Promise<void> {
  const result = await adminPool.query(
    "UPDATE databases SET owner_module_id = $3 WHERE tenant_id = $1 AND owner_module_id = $2",
    [tenantId, from, to],
  );
  expect(result.rowCount).toBe(1);
}

describe("default Inbox item types seeding (issue gh-1977)", () => {
  beforeAll(() => {
    adminPool = getTestPool();
    dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    zero = getTenantZeroId();
    b = await createTestTenant(adminPool);
  });

  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  describe("the table", () => {
    it("holds the seven defaults of the decision, in order, with the methods and targets listed", () => {
      expect(
        DEFAULT_INBOX_TYPES.map((spec) => [spec.key, spec.emoji, spec.processingMethod, spec.targetDatabase ?? null]),
      ).toEqual([
        ["idea", "\u{1F4A1}", "pageContent", null],
        ["task", "✅", "database", "tasks"],
        ["event", "\u{1F4C5}", "database", "events"],
        ["thought", "\u{1F4AD}", "journal", null],
        ["mood", "\u{1F60A}", "journal", null],
        ["note", "\u{1F4DD}", "pageContent", null],
        ["contact", "\u{1F464}", "database", "people"],
      ]);
    });

    it("passes the type write validation for every row", () => {
      for (const spec of DEFAULT_INBOX_TYPES) {
        expect(() => assertValidProcessingConfig(spec.processingMethod, spec.targetDatabase)).not.toThrow();
      }
    });

    it("has an English and a Czech name for every row in the Inbox catalog", async () => {
      const catalogs = await getInboxCatalogs();
      expect(DEFAULT_INBOX_TYPES.map((spec) => catalogs.en[`seed.inboxTypes.${spec.key}.name`])).toEqual(ENGLISH_NAMES);
      expect(DEFAULT_INBOX_TYPES.map((spec) => catalogs.cs[`seed.inboxTypes.${spec.key}.name`])).toEqual(CZECH_NAMES);
    });
  });

  describe("a fresh seed", () => {
    it("declares the marker with an empty list and no types", async () => {
      await seedTenant(zero);

      expect(await readMarker(zero)).toEqual([]);
      expect(await readTypes(zero)).toEqual([]);
    });
  });

  describe("seedDefaultInboxItemTypes", () => {
    it("creates the seven active types with the emoji, method and target of the table and records the seven keys", async () => {
      await seedTenant(zero);

      expect(await seed(zero)).toEqual(ALL_KEYS);

      const types = await readTypes(zero);
      expect(types).toHaveLength(7);
      const byName = new Map(types.map((row) => [String(row.properties.name), row.properties]));
      expect(byName.get("Nápad")).toMatchObject({
        emoji: "\u{1F4A1}",
        status: "active",
        processingMethod: "pageContent",
      });
      expect(byName.get("Úkol")).toMatchObject({
        emoji: "✅",
        status: "active",
        processingMethod: "database",
        targetDatabase: "tasks",
      });
      expect(byName.get("Událost")).toMatchObject({
        emoji: "\u{1F4C5}",
        status: "active",
        processingMethod: "database",
        targetDatabase: "events",
      });
      expect(byName.get("Myšlenka")).toMatchObject({
        emoji: "\u{1F4AD}",
        status: "active",
        processingMethod: "journal",
      });
      expect(byName.get("Nálada")).toMatchObject({
        emoji: "\u{1F60A}",
        status: "active",
        processingMethod: "journal",
      });
      expect(byName.get("Poznámka")).toMatchObject({
        emoji: "\u{1F4DD}",
        status: "active",
        processingMethod: "pageContent",
      });
      expect(byName.get("Kontakt")).toMatchObject({
        emoji: "\u{1F464}",
        status: "active",
        processingMethod: "database",
        targetDatabase: "people",
      });
      // A type without a target carries no target key at all, and no row stores the table's key.
      for (const name of ["Nápad", "Myšlenka", "Nálada", "Poznámka"]) {
        expect(byName.get(name)).not.toHaveProperty("targetDatabase");
      }
      for (const row of types) expect(row.properties).not.toHaveProperty("key");
      expect(await readMarker(zero)).toEqual(ALL_KEYS);
    });

    it("adds no type and changes nothing on a second run", async () => {
      await seedTenant(zero);
      await seed(zero);
      const typesBefore = await readTypes(zero);
      const settingsBefore = await readSettings(zero);

      expect(await seed(zero)).toEqual([]);

      expect(await readTypes(zero)).toEqual(typesBefore);
      expect(await readSettings(zero)).toEqual(settingsBefore);
    });

    it("does not restore a deleted type or change a renamed one, and does not seed a tenant whose types were all deleted", async () => {
      await seedTenant(zero);
      await seed(zero);
      const ids = await runInTenant(zero, () =>
        withTransaction(dataPool, async (client) => {
          const [types, inbox, proposals] = await Promise.all([
            getDatabaseByModuleId(client, "inboxItemTypes"),
            getDatabaseByModuleId(client, "inbox"),
            getDatabaseByModuleId(client, "processingProposals"),
          ]);
          if (!types || !inbox || !proposals) throw new Error("Inbox databases missing");
          return { types: types.id, inbox: inbox.id, proposals: proposals.id };
        }),
      );
      const before = await readTypes(zero);
      const renamed = before.find((row) => row.properties.name === "Úkol");
      if (!renamed) throw new Error("Task type missing");
      await adminPool.query('UPDATE items SET properties = properties || \'{"name": "Moje úkoly"}\' WHERE id = $1', [
        renamed.id,
      ]);
      const deleted = before.filter((row) => ["Nápad", "Kontakt"].includes(String(row.properties.name)));
      expect(deleted).toHaveLength(2);
      for (const row of deleted) {
        await runInTenant(zero, () =>
          withTransaction(dataPool, (client) =>
            deleteInboxTypeWithClient(client, {
              inboxDatabaseId: ids.inbox,
              inboxItemTypesDatabaseId: ids.types,
              processingProposalsDatabaseId: ids.proposals,
              typeItemId: row.id,
            }),
          ),
        );
      }
      const afterDeletion = await readTypes(zero);

      expect(await seed(zero)).toEqual([]);

      expect(await readTypes(zero)).toEqual(afterDeletion);
      expect(liveNames(afterDeletion).sort()).toEqual(
        ["Událost", "Moje úkoly", "Myšlenka", "Nálada", "Poznámka"].sort(),
      );
      expect(await readMarker(zero)).toEqual(ALL_KEYS);

      // Every remaining type is deleted as well: the tenant is still not seeded again.
      for (const row of afterDeletion.filter((candidate) => candidate.deleted_at === null)) {
        await runInTenant(zero, () =>
          withTransaction(dataPool, (client) =>
            deleteInboxTypeWithClient(client, {
              inboxDatabaseId: ids.inbox,
              inboxItemTypesDatabaseId: ids.types,
              processingProposalsDatabaseId: ids.proposals,
              typeItemId: row.id,
            }),
          ),
        );
      }
      expect(liveNames(await readTypes(zero))).toEqual([]);
      expect(await seed(zero)).toEqual([]);
      expect(liveNames(await readTypes(zero))).toEqual([]);
    });

    it("creates a default added to the table after the first run once and leaves the deleted ones deleted", async () => {
      await seedTenant(zero);
      await seed(zero);
      const first = await readTypes(zero);
      const idea = first.find((row) => row.properties.name === "Nápad");
      if (!idea) throw new Error("Idea type missing");
      // Fixture: the type is trashed directly, the shape `deleteInboxTypeWithClient` leaves for a type no item uses.
      await adminPool.query("UPDATE items SET deleted_at = now() WHERE id = $1", [idea.id]);
      const extended: DefaultInboxTypeSpec[] = [
        ...DEFAULT_INBOX_TYPES,
        { key: "recipe", emoji: "\u{1F372}", processingMethod: "pageContent" },
      ];

      expect(await seed(zero, extended)).toEqual(["recipe"]);
      expect(await seed(zero, extended)).toEqual([]);

      const types = await readTypes(zero);
      expect(types).toHaveLength(8);
      expect(liveNames(types)).toHaveLength(7);
      expect(liveNames(types)).not.toContain("Nápad");
      expect(await readMarker(zero)).toEqual([...ALL_KEYS, "recipe"]);
    });

    it("skips a default whose target database is absent, does not record it and creates it once the database exists", async () => {
      await seedTenant(zero);
      await setModuleId(zero, "events", "eventsHidden");

      expect(await seed(zero)).toEqual(ALL_KEYS.filter((key) => key !== "event"));

      expect(liveNames(await readTypes(zero))).not.toContain("Událost");
      expect(liveNames(await readTypes(zero))).toHaveLength(6);
      expect(await readMarker(zero)).toEqual(ALL_KEYS.filter((key) => key !== "event"));

      await setModuleId(zero, "eventsHidden", "events");

      expect(await seed(zero)).toEqual(["event"]);
      expect(await seed(zero)).toEqual([]);

      const types = await readTypes(zero);
      expect(types).toHaveLength(7);
      expect(types.find((row) => row.properties.name === "Událost")?.properties).toMatchObject({
        processingMethod: "database",
        targetDatabase: "events",
      });
      expect(await readMarker(zero)).toEqual([...ALL_KEYS.filter((key) => key !== "event"), "event"]);
    });

    it("writes nothing when every default is skipped", async () => {
      await seedTenant(zero);
      await setModuleId(zero, "events", "eventsHidden");
      const settingsBefore = await readSettings(zero);
      const onlyEvent = DEFAULT_INBOX_TYPES.filter((spec) => spec.key === "event");

      expect(await seed(zero, onlyEvent)).toEqual([]);

      expect(await readSettings(zero)).toEqual(settingsBefore);
      expect(await readTypes(zero)).toEqual([]);
    });

    it("does nothing when the tenant has no Inbox item types database", async () => {
      await seedTenant(zero);
      await setModuleId(zero, "inboxItemTypes", "inboxItemTypesHidden");
      const settingsBefore = await readSettings(zero);

      expect(await seed(zero)).toEqual([]);

      expect(await readSettings(zero)).toEqual(settingsBefore);
      await setModuleId(zero, "inboxItemTypesHidden", "inboxItemTypes");
      expect(await readTypes(zero)).toEqual([]);
    });

    it("treats a settings row without a marker value, and one with a null marker, as an empty list", async () => {
      await seedTenant(zero);
      await seedTenant(b);
      // Fixtures: a populated tenant's settings row has no value for the property the cutover adds.
      await adminPool.query(
        `UPDATE items SET properties = properties - 'seededDefaultInboxTypes'
          WHERE tenant_id = $1 AND database_id IN (SELECT id FROM databases WHERE owner_module_id = 'systemSettings')`,
        [zero],
      );
      await adminPool.query(
        `UPDATE items SET properties = properties || '{"seededDefaultInboxTypes": null}'
          WHERE tenant_id = $1 AND database_id IN (SELECT id FROM databases WHERE owner_module_id = 'systemSettings')`,
        [b],
      );

      expect(await seed(zero)).toEqual(ALL_KEYS);
      expect(await seed(b)).toEqual(ALL_KEYS);

      expect(await readMarker(zero)).toEqual(ALL_KEYS);
      expect(await readMarker(b)).toEqual(ALL_KEYS);
    });

    it("refuses a marker that is not a list of strings and creates nothing", async () => {
      await seedTenant(zero);
      await adminPool.query(
        `UPDATE items SET properties = properties || '{"seededDefaultInboxTypes": {"idea": true}}'
          WHERE tenant_id = $1 AND database_id IN (SELECT id FROM databases WHERE owner_module_id = 'systemSettings')`,
        [zero],
      );

      await expect(seed(zero)).rejects.toBeInstanceOf(z.ZodError);

      expect(await readTypes(zero)).toEqual([]);
    });

    it("refuses a settings database without the marker property and creates nothing", async () => {
      await seedTenant(zero);
      await adminPool.query(`DELETE FROM properties WHERE key = 'seededDefaultInboxTypes' AND tenant_id = $1`, [zero]);

      await expect(seed(zero)).rejects.toThrow("no 'seededDefaultInboxTypes' property");

      expect(await readTypes(zero)).toEqual([]);
    });

    it("validates each type through the type write hook and rolls the whole run back when one is refused", async () => {
      await seedTenant(zero);
      const withBrokenRow: DefaultInboxTypeSpec[] = [
        { key: "idea", emoji: "\u{1F4A1}", processingMethod: "pageContent" },
        // A `database` type without a target is a pair the write hook refuses.
        { key: "broken", emoji: "X", processingMethod: "database" },
      ];

      const failure = await seed(zero, withBrokenRow).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ValidationError);
      expect(failure).toMatchObject({ details: { field: "targetDatabase" } });
      expect(await readTypes(zero)).toEqual([]);
      expect(await readMarker(zero)).toEqual([]);
    });

    it("gives two concurrent seeders each type once", async () => {
      await seedTenant(zero);

      const [first, second] = await Promise.all([seed(zero), seed(zero)]);

      expect([...first, ...second].sort()).toEqual([...ALL_KEYS].sort());
      expect(first.length === 0 || second.length === 0).toBe(true);
      expect(await readTypes(zero)).toHaveLength(7);
      expect(await readMarker(zero)).toEqual(ALL_KEYS);
    });

    it("seeds one tenant without touching another", async () => {
      await seedTenant(zero);
      await seedTenant(b);

      await seed(zero);

      expect(await readTypes(b)).toEqual([]);
      expect(await readMarker(b)).toEqual([]);
      await seed(b);
      const zeroTypes = await readTypes(zero);
      const bTypes = await readTypes(b);
      expect(zeroTypes).toHaveLength(7);
      expect(bTypes).toHaveLength(7);
      expect(new Set([...zeroTypes, ...bTypes].map((row) => row.id)).size).toBe(14);
    });
  });

  describe("names and locale", () => {
    it("gives Czech names to a tenant without a user", async () => {
      await seedTenant(zero);

      await seed(zero);

      expect(liveNames(await readTypes(zero)).sort()).toEqual([...CZECH_NAMES].sort());
    });

    it("gives Czech names to a user whose locale is cs", async () => {
      await seedTenant(zero);
      await addUser(zero, "cs");

      await seed(zero);

      expect(liveNames(await readTypes(zero)).sort()).toEqual([...CZECH_NAMES].sort());
    });

    it("gives English names to a user whose locale is en", async () => {
      await seedTenant(zero);
      await addUser(zero, "en");

      await seed(zero);

      expect(liveNames(await readTypes(zero)).sort()).toEqual([...ENGLISH_NAMES].sort());
    });

    it("gives English names to a user whose locale has no catalog", async () => {
      await seedTenant(zero);
      await addUser(zero, "de");

      await seed(zero);

      expect(liveNames(await readTypes(zero)).sort()).toEqual([...ENGLISH_NAMES].sort());
    });

    it("fixes the language when a type is created: a later locale change renames none and names a later type in the new language", async () => {
      await seedTenant(zero);
      const userId = await addUser(zero, "cs");
      await seed(
        zero,
        DEFAULT_INBOX_TYPES.filter((spec) => spec.key === "idea"),
      );
      await adminPool.query("UPDATE users SET locale = 'en' WHERE id = $1", [userId]);

      expect(await seed(zero)).toEqual(ALL_KEYS.filter((key) => key !== "idea"));

      expect(liveNames(await readTypes(zero)).sort()).toEqual(
        ["Nápad", ...ENGLISH_NAMES.filter((name) => name !== "Idea")].sort(),
      );
    });
  });

  describe("provisionTenant", () => {
    it("gives a new tenant the seven active types and GET /api/inbox-types returns them", async () => {
      await seedTenant(zero);
      const fresh = await createTestTenant(adminPool, { status: "provisioning" });
      await addUser(fresh, "en");

      await expect(provisionTenant(dataPool, fresh)).resolves.toBe("created");

      const types = await readTypes(fresh);
      expect(types).toHaveLength(7);
      expect(types.every((row) => row.properties.status === "active")).toBe(true);
      expect(await readMarker(fresh)).toEqual(ALL_KEYS);
      // A tenant provisioned before the user existed would be Czech; this one had its user first, so it is English.
      const response = await runInTenant(fresh, () =>
        createInboxTypesRouteHandler(dataPool)({ identity: { user: { locale: "en" } } }),
      );
      const { status, body } = z
        .object({
          status: z.number(),
          body: z.object({
            types: z.array(
              z.object({
                label: z.string(),
                emoji: z.string(),
                processingMethod: z.string().nullable(),
                targetDatabaseKey: z.string().nullable(),
              }),
            ),
          }),
        })
        .parse(response);
      expect(status).toBe(200);
      expect(body.types.map((entry) => [entry.label, entry.processingMethod, entry.targetDatabaseKey]).sort()).toEqual(
        [
          ["Idea", "pageContent", null],
          ["Task", "database", "tasks"],
          ["Event", "database", "events"],
          ["Thought", "journal", null],
          ["Mood", "journal", null],
          ["Note", "pageContent", null],
          ["Contact", "database", "people"],
        ].sort(),
      );
      expect(await readTypes(zero)).toEqual([]);
    });

    it("adds no type when a provisioned tenant is provisioned again, and does not restore a deleted one", async () => {
      const fresh = await createTestTenant(adminPool, { status: "provisioning" });
      await provisionTenant(dataPool, fresh);
      const idea = (await readTypes(fresh)).find((row) => row.properties.name === "Nápad");
      if (!idea) throw new Error("Idea type missing");
      // Fixture: trashed directly; a type with no Inbox item is the only shape this test needs.
      await adminPool.query("UPDATE items SET deleted_at = now() WHERE id = $1", [idea.id]);

      await expect(provisionTenant(dataPool, fresh)).resolves.toBe("already-provisioned");

      const types = await readTypes(fresh);
      expect(types).toHaveLength(7);
      expect(liveNames(types)).toHaveLength(6);
      expect(await readMarker(fresh)).toEqual(ALL_KEYS);
    });
  });
});
