import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { loadModuleCatalogs } from "@semprec/module-registry";
import { runInTenant } from "@semprec/shared";
import { CALENDAR_MODULE_ID } from "../calendar/calendarModuleId.js";
import { runSubscribedEventsCutoverMigration } from "../calendar/subscribedEventsCutoverMigration.js";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { CardinalityViolationError } from "../errors.js";
import { withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { CALENDARS_MODULE_ID, SUBSCRIBED_EVENTS_MODULE_ID } from "../seed/calendarsKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

let adminPool: Pool;
let dataPool: Pool;

const USER = { writerKind: "user" } as const;
const AGENT = { writerKind: "agent", onBehalfOfUserId: randomUUID() } as const;

/** The scalar properties of a subscribed event, in key order, with the type and the config the seed gives them. */
const EXPECTED_PROPERTIES = [
  ["allDay", "checkbox", {}],
  ["calendar", "relation", null],
  ["endsAt", "date", { includeTime: true }],
  ["place", "text", {}],
  ["startsAt", "date", { includeTime: true }],
  ["timeZone", "text", {}],
  ["title", "title", {}],
  ["uid", "text", {}],
] as const;

const SYSTEM_KEYS = EXPECTED_PROPERTIES.filter(([key]) => key !== "calendar").map(([key]) => key);

const propertyRow = z.object({
  key: z.string(),
  type: z.string(),
  owner: z.string(),
  owner_process: z.string().nullable(),
  config: z.record(z.string(), z.unknown()),
  locked: z.boolean(),
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

async function requireDatabaseId(tenantId: string, moduleId: string): Promise<string> {
  const id = await databaseId(tenantId, moduleId);
  if (!id) throw new Error(`The tenant has no ${moduleId} database`);
  return id;
}

/**
 * Turns a seeded tenant into one that was seeded before this issue: the subscribed events database, its
 * properties and its relation are removed with SQL. The API cannot produce that state (system databases are
 * locked and never deleted), and it is exactly what the cutover must upgrade.
 */
async function removeSubscribedEventsDatabase(tenantId: string): Promise<void> {
  const subscribedEventsId = await requireDatabaseId(tenantId, SUBSCRIBED_EVENTS_MODULE_ID);
  const calendarsId = await requireDatabaseId(tenantId, CALENDARS_MODULE_ID);
  await withTenantTransaction(adminPool, tenantId, async (client) => {
    await client.query(
      `DELETE FROM relation_definitions
        WHERE property_id_a IN (SELECT id FROM properties WHERE database_id = $1 AND key = 'subscribedEvents')`,
      [calendarsId],
    );
    await client.query("DELETE FROM properties WHERE database_id = $1 AND key = 'subscribedEvents'", [calendarsId]);
    await client.query("DELETE FROM properties WHERE database_id = $1", [subscribedEventsId]);
    await databasesStore.dropDatabaseWithPartition(client, subscribedEventsId);
  });
}

/** The ids of every structural row the cutover can create for a tenant, in a stable order. */
async function structure(
  tenantId: string,
): Promise<{ databases: string[]; properties: string[]; relations: string[] }> {
  const databases = await adminPool.query<{ id: string }>(
    "SELECT id FROM databases WHERE tenant_id = $1 AND key = $2 ORDER BY id",
    [tenantId, SUBSCRIBED_EVENTS_MODULE_ID],
  );
  const properties = await adminPool.query<{ id: string }>(
    `SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id
      WHERE p.tenant_id = $1 AND (d.key = $2 OR (d.key = $3 AND p.key = 'subscribedEvents'))
      ORDER BY p.id`,
    [tenantId, SUBSCRIBED_EVENTS_MODULE_ID, CALENDARS_MODULE_ID],
  );
  const relations = await adminPool.query<{ id: string }>(
    "SELECT id FROM relation_definitions WHERE tenant_id = $1 ORDER BY id",
    [tenantId],
  );
  return {
    databases: databases.rows.map((row) => row.id),
    properties: properties.rows.map((row) => row.id),
    relations: relations.rows.map((row) => row.id),
  };
}

async function propertiesOf(databaseIdValue: string) {
  const { rows } = await adminPool.query(
    // The ids of a relation definition and of its target database differ per tenant, so they are left out.
    `SELECT key, type, owner, owner_process, config - 'relationDefinitionId' - 'targetDatabaseId' AS config, locked
       FROM properties WHERE database_id = $1 ORDER BY key`,
    [databaseIdValue],
  );
  return z.array(propertyRow).parse(rows);
}

describe("subscribedEvents system database (issue gh-1962)", () => {
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

  describe("fresh seed", () => {
    it("creates the system database of the calendar module with a locked schema and no rows", async () => {
      const tenantId = await tenantWithUser("cs");
      const { rows } = await adminPool.query<{
        owner_module_id: string;
        system: boolean;
        schema_locked: boolean;
        name: string | null;
        owner_project_item_id: string | null;
        calendars_project_item_id: string | null;
        items: string;
      }>(
        `SELECT d.owner_module_id, d.system, d.schema_locked, d.name, d.owner_project_item_id,
                c.owner_project_item_id AS calendars_project_item_id,
                (SELECT count(*) FROM items i WHERE i.database_id = d.id)::text AS items
           FROM databases d, databases c
          WHERE d.tenant_id = $1 AND d.key = $2 AND c.tenant_id = $1 AND c.key = $3`,
        [tenantId, SUBSCRIBED_EVENTS_MODULE_ID, CALENDARS_MODULE_ID],
      );
      expect(rows).toHaveLength(1);
      const [database] = rows;
      expect(database).toMatchObject({
        owner_module_id: SUBSCRIBED_EVENTS_MODULE_ID,
        system: true,
        schema_locked: true,
        name: null,
        items: "0",
      });
      expect(database?.owner_project_item_id).not.toBeNull();
      expect(database?.owner_project_item_id).toBe(database?.calendars_project_item_id);
    });

    it("declares every property as system-owned by the calendar module, with the calendar relation among them", async () => {
      const tenantId = await tenantWithUser("cs");
      const properties = await propertiesOf(await requireDatabaseId(tenantId, SUBSCRIBED_EVENTS_MODULE_ID));
      expect(properties.map((property) => [property.key, property.type])).toEqual(
        EXPECTED_PROPERTIES.map(([key, type]) => [key, type]),
      );
      for (const property of properties) {
        expect(property, property.key).toMatchObject({ owner: "system", owner_process: CALENDAR_MODULE_ID });
      }
      for (const [key, , config] of EXPECTED_PROPERTIES) {
        if (config === null) continue;
        expect(properties.find((property) => property.key === key)?.config, key).toEqual(config);
      }
    });

    it("relates each subscribed event to one calendar and each calendar to many, both sides owned by the calendar module", async () => {
      const tenantId = await tenantWithUser("cs");
      const calendarsId = await requireDatabaseId(tenantId, CALENDARS_MODULE_ID);
      const subscribedEventsId = await requireDatabaseId(tenantId, SUBSCRIBED_EVENTS_MODULE_ID);
      const { rows } = await adminPool.query<{
        cardinality: string;
        a_database: string;
        a_key: string;
        a_owner: string;
        a_owner_process: string | null;
        a_target: string;
        b_database: string;
        b_key: string;
        b_owner: string;
        b_owner_process: string | null;
        b_target: string;
      }>(
        `SELECT r.cardinality, pa.database_id::text AS a_database, pa.key AS a_key, pa.owner AS a_owner,
                pa.owner_process AS a_owner_process, pa.config->>'targetDatabaseId' AS a_target,
                pb.database_id::text AS b_database, pb.key AS b_key, pb.owner AS b_owner,
                pb.owner_process AS b_owner_process, pb.config->>'targetDatabaseId' AS b_target
           FROM relation_definitions r
           JOIN properties pa ON pa.id = r.property_id_a
           JOIN properties pb ON pb.id = r.property_id_b
          WHERE r.tenant_id = $1 AND (pa.database_id = $2 OR pb.database_id = $2)`,
        [tenantId, subscribedEventsId],
      );
      expect(rows).toEqual([
        {
          cardinality: "one_to_many",
          a_database: calendarsId,
          a_key: "subscribedEvents",
          a_owner: "system",
          a_owner_process: CALENDAR_MODULE_ID,
          a_target: subscribedEventsId,
          b_database: subscribedEventsId,
          b_key: "calendar",
          b_owner: "system",
          b_owner_process: CALENDAR_MODULE_ID,
          b_target: calendarsId,
        },
      ]);
    });

    it("labels the database and every property in Czech and in English", async () => {
      const tenantId = await tenantWithUser("cs");
      const catalogs = await loadModuleCatalogs(new URL("../calendar/calendarModuleManifest.js", import.meta.url).href);
      expect(catalogs.cs["database.subscribedEvents.name"]).toBe("Odebrané události");
      expect(catalogs.en["database.subscribedEvents.name"]).toBe("Subscribed events");
      expect(catalogs.cs["property.calendars.subscribedEvents.name"]).toBeTypeOf("string");
      expect(catalogs.en["property.calendars.subscribedEvents.name"]).toBeTypeOf("string");
      const properties = await propertiesOf(await requireDatabaseId(tenantId, SUBSCRIBED_EVENTS_MODULE_ID));
      for (const { key } of properties) {
        for (const locale of ["cs", "en"] as const) {
          expect(catalogs[locale][`property.subscribedEvents.${key}.name`], `${locale} ${key}`).toBeTypeOf("string");
        }
      }
    });
  });

  describe("cutover for an existing tenant", () => {
    it("creates the database, the properties and the relation, and a second run changes nothing", async () => {
      const tenantId = await tenantWithUser("cs");
      await removeSubscribedEventsDatabase(tenantId);
      const removed = await structure(tenantId);
      expect(removed).toMatchObject({ databases: [], properties: [] });
      const relationsBefore = removed.relations;

      await runInTenant(tenantId, () => runSubscribedEventsCutoverMigration(dataPool));
      const created = await structure(tenantId);
      expect(created.databases).toHaveLength(1);
      expect(created.properties).toHaveLength(EXPECTED_PROPERTIES.length + 1);
      expect(created.relations).toHaveLength(relationsBefore.length + 1);
      const properties = await propertiesOf(await requireDatabaseId(tenantId, SUBSCRIBED_EVENTS_MODULE_ID));
      expect(
        properties.map((property) => [property.key, property.type, property.owner, property.owner_process]),
      ).toEqual(EXPECTED_PROPERTIES.map(([key, type]) => [key, type, "system", CALENDAR_MODULE_ID]));
      const { rows: locked } = await adminPool.query<{ schema_locked: boolean }>(
        "SELECT schema_locked FROM databases WHERE id = $1",
        [created.databases[0]],
      );
      expect(locked).toEqual([{ schema_locked: true }]);

      await runInTenant(tenantId, () => runSubscribedEventsCutoverMigration(dataPool));
      expect(await structure(tenantId)).toEqual(created);
    });

    it("builds the same schema as the fresh seed", async () => {
      const seeded = await tenantWithUser("cs");
      const upgraded = await tenantWithUser("cs");
      await removeSubscribedEventsDatabase(upgraded);
      await runInTenant(upgraded, () => runSubscribedEventsCutoverMigration(dataPool));

      const properties = async (tenantId: string) =>
        propertiesOf(await requireDatabaseId(tenantId, SUBSCRIBED_EVENTS_MODULE_ID));
      expect(await properties(upgraded)).toEqual(await properties(seeded));
      const calendarSide = async (tenantId: string) => {
        const { rows } = await adminPool.query(
          `SELECT key, type, owner, owner_process, config - 'relationDefinitionId' - 'targetDatabaseId' AS config, locked
             FROM properties WHERE database_id = $1 AND key = 'subscribedEvents'`,
          [await requireDatabaseId(tenantId, CALENDARS_MODULE_ID)],
        );
        return z.array(propertyRow).parse(rows);
      };
      expect(await calendarSide(upgraded)).toEqual(await calendarSide(seeded));
      expect(await calendarSide(upgraded)).toHaveLength(1);
    });

    it("skips a tenant without a Calendars database", async () => {
      const tenantId = await createTestTenant(adminPool);
      await runInTenant(tenantId, () => runSubscribedEventsCutoverMigration(dataPool));
      const { rows } = await adminPool.query<{ databases: string; properties: string }>(
        `SELECT (SELECT count(*) FROM databases WHERE tenant_id = $1)::text AS databases,
                (SELECT count(*) FROM properties WHERE tenant_id = $1)::text AS properties`,
        [tenantId],
      );
      expect(rows).toEqual([{ databases: "0", properties: "0" }]);
    });

    it("changes only the tenant it runs in", async () => {
      const first = await tenantWithUser("cs");
      const second = await tenantWithUser("cs");
      await removeSubscribedEventsDatabase(first);
      await removeSubscribedEventsDatabase(second);

      await runInTenant(first, () => runSubscribedEventsCutoverMigration(dataPool));
      expect((await structure(first)).databases).toHaveLength(1);
      expect((await structure(second)).databases).toEqual([]);
    });

    it("runs through runTenantCutoverMigrations for a suspended tenant", async () => {
      const tenantId = await tenantWithUser("cs");
      await removeSubscribedEventsDatabase(tenantId);
      await adminPool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenantId]);

      await runTenantCutoverMigrations(dataPool);
      expect((await structure(tenantId)).databases).toHaveLength(1);
    });
  });

  describe("writes", () => {
    /** A subscribed event row as the later feed import writes it. */
    const ROW = {
      uid: "event-1@example.com",
      title: "Quarterly review",
      startsAt: "2026-10-20T15:00",
      endsAt: "2026-10-20T16:00",
      timeZone: "America/New_York",
      allDay: false,
      place: "Room 4",
    };

    async function seededTenant(): Promise<{ tenantId: string; subscribedEventsId: string }> {
      const tenantId = await tenantWithUser("cs");
      return { tenantId, subscribedEventsId: await requireDatabaseId(tenantId, SUBSCRIBED_EVENTS_MODULE_ID) };
    }

    /** The write the calendar module's import makes: the system writer with its own owner process. */
    function writeAsCalendarModule(subscribedEventsId: string, properties: Record<string, unknown>) {
      return withTransaction(dataPool, (client) =>
        createItemWithClient(
          client,
          { databaseId: subscribedEventsId, properties },
          { allowedSystemKeys: SYSTEM_KEYS, systemOwnerProcess: CALENDAR_MODULE_ID },
        ),
      );
    }

    it("accepts a write of the calendar module with its system owner process", async () => {
      const { tenantId, subscribedEventsId } = await seededTenant();
      const item = await runInTenant(tenantId, () => writeAsCalendarModule(subscribedEventsId, ROW));
      const stored = await runInTenant(tenantId, () => createChokePoint(dataPool).findItem(item.id));
      expect(stored?.properties).toEqual(ROW);
    });

    it("refuses a system write that names another owner process and stores nothing", async () => {
      const { tenantId, subscribedEventsId } = await seededTenant();
      await runInTenant(tenantId, async () => {
        await expect(
          withTransaction(dataPool, (client) =>
            createItemWithClient(
              client,
              { databaseId: subscribedEventsId, properties: ROW },
              { allowedSystemKeys: SYSTEM_KEYS, systemOwnerProcess: "sleep" },
            ),
          ),
        ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
        expect((await createChokePoint(dataPool).listItems(subscribedEventsId, { limit: 10 })).items).toEqual([]);
      });
    });

    it.each([
      ["user", USER],
      ["agent", AGENT],
    ])("refuses a generic create by a %s writer and stores nothing", async (_name, writer) => {
      const { tenantId, subscribedEventsId } = await seededTenant();
      await runInTenant(tenantId, async () => {
        const chokePoint = createChokePoint(dataPool);
        await expect(
          chokePoint.createItem({ databaseId: subscribedEventsId, properties: ROW }, undefined, undefined, writer),
        ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
        expect((await chokePoint.listItems(subscribedEventsId, { limit: 10 })).items).toEqual([]);
      });
    });

    it.each([
      ["user", USER],
      ["agent", AGENT],
    ])(
      "refuses a generic patch by a %s writer of a row the calendar module wrote and keeps the row",
      async (_name, writer) => {
        const { tenantId, subscribedEventsId } = await seededTenant();
        const item = await runInTenant(tenantId, () => writeAsCalendarModule(subscribedEventsId, ROW));
        await runInTenant(tenantId, async () => {
          const chokePoint = createChokePoint(dataPool);
          await expect(
            chokePoint.updateItem(
              { databaseId: subscribedEventsId, itemId: item.id, propertiesPatch: { title: "Renamed" } },
              undefined,
              undefined,
              writer,
            ),
          ).rejects.toMatchObject({ status: 403, code: "owner_violation", details: { field: "title" } });
          expect((await chokePoint.findItem(item.id))?.properties).toEqual(ROW);
        });
      },
    );

    it.each([
      ["user", USER],
      ["agent", AGENT],
    ])(
      "refuses a generic create by a %s writer that names no property and stores no blank row",
      async (_name, writer) => {
        const { tenantId, subscribedEventsId } = await seededTenant();
        await runInTenant(tenantId, async () => {
          const chokePoint = createChokePoint(dataPool);
          for (const input of [
            { databaseId: subscribedEventsId },
            { databaseId: subscribedEventsId, properties: {} },
          ]) {
            await expect(chokePoint.createItem(input, undefined, undefined, writer)).rejects.toMatchObject({
              status: 403,
              code: "owner_violation",
              details: { field: "databaseId" },
            });
          }
          expect((await chokePoint.listItems(subscribedEventsId, { limit: 10 })).items).toEqual([]);
        });
      },
    );

    it.each([
      ["user", USER],
      ["agent", AGENT],
    ])(
      "refuses a generic patch by a %s writer that names no property and leaves the row untouched",
      async (_name, writer) => {
        const { tenantId, subscribedEventsId } = await seededTenant();
        const item = await runInTenant(tenantId, () => writeAsCalendarModule(subscribedEventsId, ROW));
        await runInTenant(tenantId, async () => {
          const chokePoint = createChokePoint(dataPool);
          await expect(
            chokePoint.updateItem(
              { databaseId: subscribedEventsId, itemId: item.id, propertiesPatch: {} },
              undefined,
              undefined,
              writer,
            ),
          ).rejects.toMatchObject({ status: 403, code: "owner_violation", details: { field: "databaseId" } });
          const stored = await chokePoint.findItem(item.id);
          expect(stored?.properties).toEqual(ROW);
          expect(stored?.updatedAt).toBe(item.updatedAt);
        });
      },
    );

    it("still accepts a create by a user writer that names no property in a user-created database", async () => {
      const { tenantId } = await seededTenant();
      await runInTenant(tenantId, async () => {
        const chokePoint = createChokePoint(dataPool);
        const database = await chokePoint.createDatabase({ name: "Plain" });
        const item = await chokePoint.createItem({ databaseId: database.id }, undefined, undefined, USER);
        expect(item.databaseId).toBe(database.id);
      });
    });

    it("writes the calendar edge only with the calendar owner process, from either side, one calendar per event", async () => {
      const { tenantId, subscribedEventsId } = await seededTenant();
      const calendarsId = await requireDatabaseId(tenantId, CALENDARS_MODULE_ID);
      await runInTenant(tenantId, async () => {
        const chokePoint = createChokePoint(dataPool);
        const event = await writeAsCalendarModule(subscribedEventsId, ROW);
        const calendars = (await chokePoint.listItems(calendarsId, { limit: 50 })).items;
        const [first, second] = calendars;
        if (!first || !second) throw new Error("Expected the seeded calendars");
        const eventSide = (await chokePoint.listProperties(subscribedEventsId)).find((p) => p.key === "calendar");
        const calendarSide = (await chokePoint.listProperties(calendarsId)).find((p) => p.key === "subscribedEvents");
        if (!eventSide || !calendarSide) throw new Error("Missing a relation property");

        await expect(
          chokePoint.createRelation({
            relationPropertyId: eventSide.id,
            callerItemId: event.id,
            targetItemId: first.id,
          }),
        ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
        await expect(
          chokePoint.createRelation({
            relationPropertyId: calendarSide.id,
            callerItemId: first.id,
            targetItemId: event.id,
          }),
        ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
        expect(await countEdges(eventSide.id)).toBe(0);

        const context = { ownerProcess: CALENDAR_MODULE_ID };
        await withTransaction(dataPool, (client) =>
          createRelationWithClient(
            client,
            { relationPropertyId: eventSide.id, callerItemId: event.id, targetItemId: first.id },
            context,
          ),
        );
        expect(await countEdges(eventSide.id)).toBe(1);
        await expect(
          withTransaction(dataPool, (client) =>
            createRelationWithClient(
              client,
              { relationPropertyId: eventSide.id, callerItemId: event.id, targetItemId: second.id },
              context,
            ),
          ),
        ).rejects.toBeInstanceOf(CardinalityViolationError);
        expect(await countEdges(eventSide.id)).toBe(1);
      });
    });

    /** Edges of the definition of `relationPropertyId`, read through the runtime role in the caller's tenant scope. */
    async function countEdges(relationPropertyId: string): Promise<number> {
      const { rows } = await dataPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM item_relations r
           JOIN properties p ON (p.config->>'relationDefinitionId')::uuid = r.relation_definition_id
          WHERE p.id = $1`,
        [relationPropertyId],
      );
      return Number(rows[0]?.count);
    }
  });
});
