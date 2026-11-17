import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { CardinalityViolationError } from "../../errors.js";
import { withTransaction } from "../../db/pool.js";
import { CALENDARS_MODULE_ID, SUBSCRIBED_EVENTS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";

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
      ["calendars", "subscribedEvents", "relation", "system", "calendar"],
      ["calendars", "subscriptionUrl", "url", "user", null],
      ["calendars", "systemKey", "text", "system", "calendar"],
      ["events", "calendar", "relation", "user", null],
    ]);
    expect(rows.every((row) => row.locked)).toBe(true);
  });

  it("stores Calendars.events as one-to-many and refuses a second calendar for one Event through the choke point", async () => {
    const tenantId = await tenantWithUser("cs");
    const calendarsId = await databaseId(tenantId, CALENDARS_MODULE_ID);
    const eventsId = await databaseId(tenantId, "events");
    if (!calendarsId || !eventsId) throw new Error("Seeded tenant is missing a database");
    const { rows: definitions } = await adminPool.query<{
      cardinality: string;
      a_database: string;
      a_key: string;
      b_database: string;
      b_key: string;
    }>(
      `SELECT r.cardinality, pa.database_id::text AS a_database, pa.key AS a_key,
              pb.database_id::text AS b_database, pb.key AS b_key
         FROM relation_definitions r
         JOIN properties pa ON pa.id = r.property_id_a
         JOIN properties pb ON pb.id = r.property_id_b
        WHERE r.tenant_id = $1 AND (pa.database_id = $2 OR pb.database_id = $2)
        ORDER BY pa.key`,
      [tenantId, calendarsId],
    );
    const subscribedEventsId = await databaseId(tenantId, SUBSCRIBED_EVENTS_MODULE_ID);
    if (!subscribedEventsId) throw new Error("Seeded tenant has no subscribed events database");
    expect(definitions).toEqual([
      { cardinality: "one_to_many", a_database: calendarsId, a_key: "events", b_database: eventsId, b_key: "calendar" },
      {
        cardinality: "one_to_many",
        a_database: calendarsId,
        a_key: "subscribedEvents",
        b_database: subscribedEventsId,
        b_key: "calendar",
      },
    ]);

    const rows = await calendars(tenantId);
    const personal = rows.find((row) => row.properties.isDefault);
    const work = rows.find((row) => !row.properties.isDefault);
    if (!personal || !work) throw new Error("Expected the default and another calendar");
    const chokePoint = createChokePoint(dataPool);
    const eventId = await runInTenant(tenantId, async () => {
      const event = await chokePoint.createItem(
        { databaseId: eventsId, properties: { name: "Standup", date: "2026-10-16" } },
        undefined,
        undefined,
        USER,
      );
      const eventCalendar = (await chokePoint.listProperties(eventsId)).find((property) => property.key === "calendar");
      const calendarEvents = (await chokePoint.listProperties(calendarsId)).find(
        (property) => property.key === "events",
      );
      if (!eventCalendar || !calendarEvents) throw new Error("Missing a calendar relation property");
      await chokePoint.createRelation({
        relationPropertyId: eventCalendar.id,
        callerItemId: event.id,
        targetItemId: personal.id,
      });
      await expect(
        chokePoint.createRelation({
          relationPropertyId: eventCalendar.id,
          callerItemId: event.id,
          targetItemId: work.id,
        }),
      ).rejects.toBeInstanceOf(CardinalityViolationError);
      await expect(
        chokePoint.createRelation({
          relationPropertyId: calendarEvents.id,
          callerItemId: work.id,
          targetItemId: event.id,
        }),
      ).rejects.toBeInstanceOf(CardinalityViolationError);
      return event.id;
    });
    expect(await calendarEdges(tenantId)).toEqual([[personal.id, eventId]]);
  });

  it("names the calendar system project from the module catalog in the tenant's language", async () => {
    for (const [locale, name] of [
      ["cs", "Kalendář"],
      ["en", "Calendar"],
    ] as const) {
      const tenantId = await tenantWithUser(locale);
      const calendarsId = await databaseId(tenantId, CALENDARS_MODULE_ID);
      const { rows } = await adminPool.query<{ properties: unknown; deleted: boolean; database: string }>(
        `SELECT project.properties, project.deleted_at IS NOT NULL AS deleted, owner.owner_module_id AS database
           FROM databases calendars
           JOIN items project ON project.id = calendars.owner_project_item_id
           JOIN databases owner ON owner.id = project.database_id
          WHERE calendars.tenant_id = $1 AND calendars.id = $2`,
        [tenantId, calendarsId],
      );
      expect(rows, locale).toEqual([
        { properties: { name, systemActive: true }, deleted: false, database: "projects" },
      ]);
    }
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
});
