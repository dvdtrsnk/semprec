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
import { CardinalityViolationError } from "../../errors.js";
import { withTransaction } from "../../db/pool.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { lockTenantSeedInTransaction, seedSystem } from "../../seed/seedSystem.js";
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
        WHERE r.tenant_id = $1 AND (pa.database_id = $2 OR pb.database_id = $2)`,
      [tenantId, calendarsId],
    );
    expect(definitions).toEqual([
      { cardinality: "one_to_many", a_database: calendarsId, a_key: "events", b_database: eventsId, b_key: "calendar" },
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

    /** Every row of `tenantId` in the tables the cutover reads or writes, on the admin pool filtered by the tenant. */
    async function tenantRows(tenantId: string) {
      const read = async (sql: string) =>
        (await adminPool.query<{ row: unknown }>(sql, [tenantId])).rows.map((entry) => entry.row);
      return {
        databases: await read("SELECT to_jsonb(d) AS row FROM databases d WHERE tenant_id = $1 ORDER BY id"),
        properties: await read("SELECT to_jsonb(p) AS row FROM properties p WHERE tenant_id = $1 ORDER BY id"),
        relationDefinitions: await read(
          "SELECT to_jsonb(r) AS row FROM relation_definitions r WHERE tenant_id = $1 ORDER BY id",
        ),
        items: await read("SELECT to_jsonb(i) AS row FROM items i WHERE tenant_id = $1 ORDER BY id"),
        itemRelations: await read("SELECT to_jsonb(r) AS row FROM item_relations r WHERE tenant_id = $1 ORDER BY id"),
      };
    }

    it("runs one tenant's cutover without changing any row of another tenant that also needs it", async () => {
      const tenantId = await tenantWithUser("cs");
      const other = await tenantWithUser("en");
      await createEvents(tenantId, 2);
      await createEvents(other, 2);
      await revertToOldShape(tenantId);
      await revertToOldShape(other);
      const otherBefore = await tenantRows(other);

      await runInTenant(tenantId, () => runCalendarsCutoverMigration(dataPool));

      expect(await tenantRows(other)).toEqual(otherBefore);
      expect(await databaseId(other, CALENDARS_MODULE_ID)).toBeNull();
      // The scoped tenant itself was cut over.
      expect(await calendars(tenantId)).toHaveLength(8);
      expect(await calendarEdges(tenantId)).toHaveLength(2);
    });

    const deadline = <T>(promise: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 20_000);
      });
      return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
    };

    /** The backends `holderPid` blocks; bounded: each probe is one short statement and the probes stop. */
    async function waitingOn(holderPid: number, expected: number): Promise<number[]> {
      let waiting: number[] = [];
      for (let probe = 0; probe < 4000 && waiting.length < expected; probe += 1) {
        const { rows } = await adminPool.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [holderPid],
        );
        waiting = rows.map((row) => row.pid);
      }
      return waiting;
    }

    /** A transaction on its own admin connection, in `tenantId`'s scope, held open until the test commits it. */
    async function heldTransaction(tenantId: string) {
      const client = await adminPool.connect();
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      return { client, pid: rows[0]!.pid };
    }

    it("serializes two cutovers of a tenant without calendars on the seed lock, so exactly one seeds", async () => {
      const tenantId = await tenantWithUser("cs");
      const eventIds = await createEvents(tenantId, 2);
      await revertToOldShape(tenantId);
      const holder = await heldTransaction(tenantId);
      let runs: Promise<void>[] = [];
      let outcomes: PromiseSettledResult<void>[];
      try {
        await lockTenantSeedInTransaction(holder.client, "test seed lock holder");
        runs = [1, 2].map(() => runInTenant(tenantId, () => runCalendarsCutoverMigration(dataPool)));
        // Both wait for the seed lock before their existence check.
        expect(await waitingOn(holder.pid, 2)).toHaveLength(2);
        await holder.client.query("COMMIT");
      } finally {
        holder.client.release(true);
        outcomes = await deadline(Promise.allSettled(runs), "both cutovers to settle");
      }
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
      const { rows } = await adminPool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM databases WHERE tenant_id = $1 AND owner_module_id = $2",
        [tenantId, CALENDARS_MODULE_ID],
      );
      expect(rows).toEqual([{ count: 1 }]);
      const rowsAfter = await calendars(tenantId);
      expect(rowsAfter).toHaveLength(8);
      const personal = rowsAfter.find((row) => row.properties.isDefault);
      expect(await calendarEdges(tenantId)).toEqual([...eventIds].sort().map((eventId) => [personal!.id, eventId]));
    });

    it("serializes concurrent edge batches on the relation definition lock, so an Event linked meanwhile keeps its calendar", async () => {
      const tenantId = await tenantWithUser("cs");
      const eventIds = await createEvents(tenantId, 3);
      const rows = await calendars(tenantId);
      const personal = rows.find((row) => row.properties.isDefault);
      const work = rows.find((row) => !row.properties.isDefault);
      if (!personal || !work) throw new Error("Expected the default and another calendar");
      const { rows: definitions } = await adminPool.query<{ id: string }>(
        `SELECT p.config->>'relationDefinitionId' AS id FROM properties p JOIN databases d ON d.id = p.database_id
          WHERE d.tenant_id = $1 AND d.owner_module_id = $2 AND p.key = 'events'`,
        [tenantId, CALENDARS_MODULE_ID],
      );
      const holder = await heldTransaction(tenantId);
      let runs: Promise<void>[] = [];
      let outcomes: PromiseSettledResult<void>[];
      try {
        // Raw SQL, labeled: a relation write of the definition held open. Its insert fires the cardinality
        // trigger of 0013, which takes the definition's advisory lock until this transaction ends.
        await holder.client.query(
          "INSERT INTO item_relations (relation_definition_id, item_a, item_b) VALUES ($1, $2, $3)",
          [definitions[0]!.id, work.id, eventIds[0]],
        );
        runs = [1, 2].map(() => runInTenant(tenantId, () => runCalendarsCutoverMigration(dataPool)));
        expect(await waitingOn(holder.pid, 2)).toHaveLength(2);
        await holder.client.query("COMMIT");
      } finally {
        holder.client.release(true);
        outcomes = await deadline(Promise.allSettled(runs), "both cutovers to settle");
      }
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
      const expected = eventIds
        .map((eventId): [string, string] => [eventId === eventIds[0] ? work.id : personal.id, eventId])
        .sort((left, right) => left[1].localeCompare(right[1]));
      expect(await calendarEdges(tenantId)).toEqual(expected);
    });

    it("leaves valid partial progress when an edge batch fails, and the next run completes it", async () => {
      const tenantId = await tenantWithUser("cs");
      const eventsId = await databaseId(tenantId, "events");
      // One more Event than a batch holds, so a second batch runs.
      const eventIds = await runInTenant(tenantId, () =>
        withTransaction(dataPool, async (client) => {
          const ids: string[] = [];
          for (let index = 0; index < 501; index += 1) {
            ids.push(
              (
                await createItemWithClient(client, {
                  databaseId: eventsId!,
                  properties: { name: `Bulk ${index}`, date: "2026-10-16" },
                })
              ).id,
            );
          }
          return ids;
        }),
      );
      await revertToOldShape(tenantId);
      // Raw SQL, labeled: a fault injected into the second batch only. Batches link Events in id order, so the
      // largest id is the one Event the second batch inserts; the probe table names it without interpolation.
      const failing = [...eventIds].sort().at(-1)!;
      await adminPool.query("CREATE TABLE calendar_cutover_failure_probe (event_id uuid PRIMARY KEY)");
      try {
        await adminPool.query("GRANT SELECT ON calendar_cutover_failure_probe TO semprec_data");
        await adminPool.query(`CREATE FUNCTION calendar_cutover_failure_probe() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF EXISTS (SELECT 1 FROM calendar_cutover_failure_probe WHERE event_id = NEW.item_b) THEN
              RAISE EXCEPTION 'injected calendar edge failure';
            END IF;
            RETURN NEW;
          END $$`);
        await adminPool.query(`CREATE TRIGGER calendar_cutover_failure_probe BEFORE INSERT ON item_relations
          FOR EACH ROW EXECUTE FUNCTION calendar_cutover_failure_probe()`);
        await adminPool.query("INSERT INTO calendar_cutover_failure_probe (event_id) VALUES ($1)", [failing]);

        await expect(runInTenant(tenantId, () => runCalendarsCutoverMigration(dataPool))).rejects.toThrow(
          /injected calendar edge failure/,
        );
        // The schema transaction and the first batch committed; the failed batch wrote nothing.
        const rows = await calendars(tenantId);
        expect(rows).toHaveLength(8);
        const personal = rows.find((row) => row.properties.isDefault);
        const partial = await calendarEdges(tenantId);
        expect(partial).toHaveLength(500);
        expect(partial.every(([calendar]) => calendar === personal?.id)).toBe(true);
        expect(new Set(partial.map(([, eventId]) => eventId)).size).toBe(500);
        expect(partial.some(([, eventId]) => eventId === failing)).toBe(false);
      } finally {
        await adminPool.query("DROP TRIGGER IF EXISTS calendar_cutover_failure_probe ON item_relations");
        await adminPool.query("DROP FUNCTION IF EXISTS calendar_cutover_failure_probe()");
        await adminPool.query("DROP TABLE IF EXISTS calendar_cutover_failure_probe");
      }

      await runInTenant(tenantId, () => runCalendarsCutoverMigration(dataPool));
      const complete = await calendarEdges(tenantId);
      expect(complete.map(([, eventId]) => eventId)).toEqual([...eventIds].sort());
      await runInTenant(tenantId, () => runCalendarsCutoverMigration(dataPool));
      expect(await calendarEdges(tenantId)).toEqual(complete);
    });

    it("links more Events than one statement inserts", async () => {
      const tenantId = await tenantWithUser("cs");
      const eventsId = await databaseId(tenantId, "events");
      // One more Event than an edge batch holds, created in one transaction through the production writer.
      await runInTenant(tenantId, () =>
        withTransaction(dataPool, async (client) => {
          for (let index = 0; index < 501; index += 1) {
            await createItemWithClient(client, {
              databaseId: eventsId!,
              properties: { name: `Bulk ${index}`, date: "2026-10-16" },
            });
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
