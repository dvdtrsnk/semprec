import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { runCalendarsCutoverMigration } from "../calendarsCutoverMigration.js";

let adminPool: Pool;
let dataPool: Pool;

const USER = { writerKind: "user" } as const;

const EXPECTED = [
  { name: "Osobní", english: "Personal", color: "#5856D6", notify: true, isDefault: true, systemKey: null },
  { name: "Práce", english: "Work", color: "#007AFF", notify: true, isDefault: false, systemKey: null },
  { name: "Rodina", english: "Family", color: "#34C759", notify: true, isDefault: false, systemKey: null },
  { name: "Zdraví", english: "Health", color: "#FF2D55", notify: true, isDefault: false, systemKey: null },
  {
    name: "Narozeniny",
    english: "Birthdays",
    color: "#8E8E93",
    notify: true,
    isDefault: false,
    systemKey: "birthdays",
  },
  { name: "Úkoly", english: "Tasks", color: "#007AFF", notify: false, isDefault: false, systemKey: "tasks" },
  { name: "Spánek", english: "Sleep", color: "#5856D6", notify: false, isDefault: false, systemKey: "sleep" },
  {
    name: "Státní svátky - Česko",
    english: "Public holidays - Czechia",
    color: "#34C759",
    notify: false,
    isDefault: false,
    systemKey: "holidaysCz",
  },
];

const calendarRow = z.object({
  id: z.string(),
  properties: z.object({
    name: z.string(),
    color: z.string(),
    notify: z.boolean(),
    hidden: z.boolean(),
    isDefault: z.boolean(),
    kind: z.enum(["own", "system"]),
    systemKey: z.string().optional(),
  }),
});

async function tenantWithUser(locale: string | null): Promise<string> {
  const tenantId = await createTestTenant(adminPool);
  if (locale !== null) {
    await createUser(adminPool, {
      tenantId,
      email: `${randomUUID()}@example.com`,
      passwordHash: "unused",
      locale,
    });
  }
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  return tenantId;
}

async function databaseId(tenantId: string, moduleId: string): Promise<string | null> {
  return runInTenant(tenantId, async () => {
    const database = await withTransaction(dataPool, (client) =>
      databasesStore.getDatabaseByModuleId(client, moduleId),
    );
    return database?.id ?? null;
  });
}

async function calendars(tenantId: string) {
  const id = await databaseId(tenantId, CALENDARS_MODULE_ID);
  if (!id) throw new Error("No calendars database");
  return runInTenant(tenantId, async () => {
    const { items } = await createChokePoint(dataPool).listItems(id, { limit: 50 });
    return z.array(calendarRow).parse(items);
  });
}

/** Every calendar edge of the tenant, as `[calendar, event]`, read through its runtime-role scope. */
async function calendarEdges(tenantId: string): Promise<Array<[string, string]>> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<{ item_a: string; item_b: string }>(
      `SELECT r.item_a, r.item_b FROM item_relations r
         JOIN properties p ON (p.config->>'relationDefinitionId')::uuid = r.relation_definition_id
         JOIN databases d ON d.id = p.database_id
        WHERE d.owner_module_id = $1 AND p.key = 'events'
        ORDER BY r.item_b`,
      [CALENDARS_MODULE_ID],
    );
    return rows.map((row) => [row.item_a, row.item_b]);
  });
}

describe("calendars system database (issue #1600)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("seeds a Czech tenant with exactly the eight calendars, their colours, notify values and system keys", async () => {
    const tenantId = await tenantWithUser("cs");
    const rows = await calendars(tenantId);
    const byName = new Map(rows.map((row) => [row.properties.name, row.properties]));
    expect(rows).toHaveLength(8);
    for (const expected of EXPECTED) {
      const row = byName.get(expected.name);
      expect(row, expected.name).toMatchObject({
        color: expected.color,
        notify: expected.notify,
        hidden: false,
        isDefault: expected.isDefault,
        kind: expected.systemKey === null ? "own" : "system",
      });
      expect(row?.systemKey ?? null, expected.name).toBe(expected.systemKey);
    }
    expect(rows.filter((row) => row.properties.isDefault).map((row) => row.properties.name)).toEqual(["Osobní"]);
  });

  it("names the calendars in Czech when the tenant has no user yet, and in English for an English user", async () => {
    const withoutUser = await tenantWithUser(null);
    expect((await calendars(withoutUser)).map((row) => row.properties.name).sort()).toEqual(
      EXPECTED.map((row) => row.name).sort(),
    );
    const english = await tenantWithUser("en");
    expect((await calendars(english)).map((row) => row.properties.name).sort()).toEqual(
      EXPECTED.map((row) => row.english).sort(),
    );
  });

  it("declares the schema: owners, the system-owned kind and systemKey, a locked schema and the Events.calendar relation", async () => {
    const tenantId = await tenantWithUser("cs");
    const calendarsId = await databaseId(tenantId, CALENDARS_MODULE_ID);
    const eventsId = await databaseId(tenantId, "events");
    const { rows } = await adminPool.query<{
      key: string;
      type: string;
      owner: string;
      owner_process: string | null;
      database: string;
      locked: boolean;
    }>(
      `SELECT p.key, p.type, p.owner, p.owner_process, d.owner_module_id AS database, d.schema_locked AS locked
         FROM properties p JOIN databases d ON d.id = p.database_id
        WHERE p.database_id = $1 OR (p.database_id = $2 AND p.key = 'calendar')
        ORDER BY d.owner_module_id, p.key`,
      [calendarsId, eventsId],
    );
    expect(rows.map((row) => [row.database, row.key, row.type, row.owner, row.owner_process])).toEqual([
      ["calendars", "color", "color", "user", null],
      ["calendars", "events", "relation", "user", null],
      ["calendars", "hidden", "checkbox", "user", null],
      ["calendars", "isDefault", "checkbox", "user", null],
      ["calendars", "kind", "select", "system", "calendar"],
      ["calendars", "name", "title", "user", null],
      ["calendars", "notify", "checkbox", "user", null],
      ["calendars", "systemKey", "text", "system", "calendar"],
      ["events", "calendar", "relation", "user", null],
    ]);
    expect(rows.every((row) => row.locked)).toBe(true);
  });

  it.each(["kind", "systemKey"])(
    "answers a generic write of %s with 403 and leaves the calendar unchanged",
    async (key) => {
      const tenantId = await tenantWithUser("cs");
      const calendarsId = await databaseId(tenantId, CALENDARS_MODULE_ID);
      const [personal] = (await calendars(tenantId)).filter((row) => row.properties.isDefault);
      if (!calendarsId || !personal) throw new Error("No default calendar");
      const chokePoint = createChokePoint(dataPool);
      await runInTenant(tenantId, async () => {
        await expect(
          chokePoint.updateItem(
            { databaseId: calendarsId, itemId: personal.id, propertiesPatch: { [key]: "system" } },
            undefined,
            undefined,
            USER,
          ),
        ).rejects.toMatchObject({ status: 403, code: "owner_violation", details: { field: key } });
        await expect(
          chokePoint.createItem(
            { databaseId: calendarsId, properties: { name: "Mine", [key]: "system" } },
            undefined,
            undefined,
            USER,
          ),
        ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
      });
      expect(await calendars(tenantId)).toHaveLength(8);
      expect((await calendars(tenantId)).find((row) => row.id === personal.id)).toEqual(personal);
    },
  );

  it("shows no calendar of one tenant to a user of another tenant", async () => {
    const owner = await tenantWithUser("cs");
    const other = await tenantWithUser("en");
    const ownerCalendars = await databaseId(owner, CALENDARS_MODULE_ID);
    if (!ownerCalendars) throw new Error("No calendars database");
    const ownerIds = (await calendars(owner)).map((row) => row.id);
    const chokePoint = createChokePoint(dataPool);
    await runInTenant(other, async () => {
      const page = await chokePoint.listItems(ownerCalendars, { limit: 50 });
      expect(page.items).toEqual([]);
      for (const id of ownerIds) expect(await chokePoint.getItem(ownerCalendars, id)).toBeNull();
    });
    const otherIds = (await calendars(other)).map((row) => row.id);
    expect(otherIds.filter((id) => ownerIds.includes(id))).toEqual([]);
  });

  describe("cutover", () => {
    /**
     * Removes everything issue #1600 seeds from a tenant, leaving the state of a tenant seeded before it.
     * The calendars database is locked and system-owned and no public path deletes it or the locked Events
     * relation, so this runs in the tenant's scope on the admin pool; the database and its partition go
     * through the store's own drop. The admin pool bypasses row-level security, so every lookup names the
     * tenant itself.
     */
    async function revertToOldShape(tenantId: string): Promise<void> {
      const calendarsId = await databaseId(tenantId, CALENDARS_MODULE_ID);
      const eventsId = await databaseId(tenantId, "events");
      const projectsId = await databaseId(tenantId, "projects");
      if (!calendarsId || !eventsId || !projectsId) throw new Error("Seeded tenant is missing a database");
      await withTenantTransaction(adminPool, tenantId, async (client) => {
        const calendarsDb = await databasesStore.getDatabase(client, calendarsId);
        if (!calendarsDb) throw new Error("Calendars database missing");
        const events = { id: eventsId };
        const { rows } = await client.query<{ id: string; definition: string }>(
          "SELECT id, config->>'relationDefinitionId' AS definition FROM properties WHERE database_id = $1 AND key = 'calendar'",
          [events.id],
        );
        const relation = rows[0];
        if (!relation) throw new Error("Events.calendar missing");
        await client.query("DELETE FROM item_relations WHERE relation_definition_id = $1", [relation.definition]);
        await client.query("DELETE FROM relation_definitions WHERE id = $1", [relation.definition]);
        await client.query("DELETE FROM properties WHERE id = $1", [relation.id]);
        await client.query("DELETE FROM items WHERE database_id = $1", [calendarsDb.id]);
        await client.query("DELETE FROM properties WHERE database_id = $1", [calendarsDb.id]);
        await client.query("DELETE FROM views WHERE database_id = $1", [calendarsDb.id]);
        await databasesStore.dropDatabaseWithPartition(client, calendarsDb.id);
        await client.query("DELETE FROM items WHERE database_id = $1 AND id = $2", [
          projectsId,
          calendarsDb.ownerProjectItemId,
        ]);
      });
      expect(await databaseId(tenantId, CALENDARS_MODULE_ID)).toBeNull();
    }

    async function createEvents(tenantId: string, count: number): Promise<string[]> {
      const eventsId = await databaseId(tenantId, "events");
      if (!eventsId) throw new Error("No events database");
      const chokePoint = createChokePoint(dataPool);
      return runInTenant(tenantId, async () => {
        const ids: string[] = [];
        for (let index = 0; index < count; index += 1) {
          ids.push(
            (
              await chokePoint.createItem({
                databaseId: eventsId,
                properties: { name: `Event ${index}`, date: "2026-10-16" },
              })
            ).id,
          );
        }
        return ids;
      });
    }

    it("creates the calendars and links every existing Event, trashed ones included, to Personal once", async () => {
      const tenantId = await tenantWithUser("cs");
      const other = await tenantWithUser("en");
      const eventIds = await createEvents(tenantId, 3);
      const eventsId = await databaseId(tenantId, "events");
      await runInTenant(tenantId, () => createChokePoint(dataPool).softDeleteItem(eventsId!, eventIds[2]!));
      await createEvents(other, 1);
      await revertToOldShape(tenantId);
      const otherBefore = { calendars: await calendars(other), edges: await calendarEdges(other) };

      await runAsSystem("test calendars cutover", () => runTenantCutoverMigrations(dataPool));

      const rows = await calendars(tenantId);
      expect(rows.map((row) => row.properties.name).sort()).toEqual(EXPECTED.map((row) => row.name).sort());
      const personal = rows.find((row) => row.properties.isDefault);
      expect(personal?.properties.name).toBe("Osobní");
      const edges = await calendarEdges(tenantId);
      expect(edges).toEqual([...eventIds].sort().map((eventId) => [personal!.id, eventId]));

      // The other tenant had its calendars already: its own Event without a calendar gets Personal, and
      // nothing of the first tenant reaches it.
      const otherAfter = await calendars(other);
      expect(otherAfter).toEqual(otherBefore.calendars);
      const otherPersonal = otherAfter.find((row) => row.properties.isDefault);
      expect((await calendarEdges(other)).every(([calendar]) => calendar === otherPersonal?.id)).toBe(true);
      expect(otherBefore.edges).toEqual([]);

      const before = { rows, edges, other: await calendarEdges(other) };
      await runInTenant(tenantId, () => runCalendarsCutoverMigration(dataPool));
      await runInTenant(other, () => runCalendarsCutoverMigration(dataPool));
      expect(await calendars(tenantId)).toEqual(before.rows);
      expect(await calendarEdges(tenantId)).toEqual(before.edges);
      expect(await calendarEdges(other)).toEqual(before.other);
    });

    it("links more Events than one statement inserts", async () => {
      const tenantId = await tenantWithUser("cs");
      const eventsId = await databaseId(tenantId, "events");
      // One more Event than an edge batch holds, created in one transaction through the production writer.
      await runInTenant(tenantId, () =>
        withTransaction(dataPool, async (client) => {
          for (let index = 0; index < 501; index += 1) {
            await createItemWithClient(client, { databaseId: eventsId!, properties: { name: `Bulk ${index}` } });
          }
        }),
      );
      await runInTenant(tenantId, () => runCalendarsCutoverMigration(dataPool));
      expect(await calendarEdges(tenantId)).toHaveLength(501);
    });

    it("skips a tenant without an Events database", async () => {
      const bare = await createTestTenant(adminPool);
      await expect(runInTenant(bare, () => runCalendarsCutoverMigration(dataPool))).resolves.toBeUndefined();
      const { rows } = await adminPool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM databases WHERE tenant_id = $1",
        [bare],
      );
      expect(rows).toEqual([{ count: 0 }]);
    });
  });
});
