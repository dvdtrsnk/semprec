import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { ForbiddenError } from "../../errors.js";
import { createInboxItemWithClient } from "../../inbox/inboxStore.js";
import { createInboxTypeWithClient } from "../../inbox/inboxTypesStore.js";
import { createSemprecTickAction } from "../../inbox/inboxTickAction.js";
import { confirmProposalWithClient } from "../../inbox/proposalActions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import type { ItemRow } from "../../types.js";
import { runEventsIcalIdentityCutoverMigration } from "../eventsIcalIdentityCutoverMigration.js";

const UID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@semprec$/;
const USER = { writerKind: "user" } as const;

let pool: Pool;

async function databaseIdFor(moduleId: string, client?: Pool): Promise<string> {
  const database = await withTransaction(client ?? pool, (tx) => databasesStore.getDatabaseByModuleId(tx, moduleId));
  if (!database) throw new Error(`Database '${moduleId}' was not seeded`);
  return database.id;
}

function identity(item: ItemRow | null) {
  return { icalUid: item?.properties.icalUid, icalSequence: item?.properties.icalSequence };
}

describe("Events iCalendar UID and sequence (issue #1599)", () => {
  let chokePoint: ChokePoint;
  let eventsId: string;

  beforeAll(() => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedSystem(pool);
    eventsId = await databaseIdFor("events");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createEvent(properties: Record<string, unknown> = {}): Promise<ItemRow> {
    return chokePoint.createItem(
      { databaseId: eventsId, properties: { name: "Planning", date: "2026-10-16", ...properties } },
      undefined,
      undefined,
      USER,
    );
  }

  it("gives a created Event a distinct <uuid>@semprec UID and sequence 0", async () => {
    const first = await createEvent();
    const second = await createEvent();
    expect(first.properties.icalUid).toMatch(UID_PATTERN);
    expect(first.properties.icalSequence).toBe(0);
    expect(second.properties.icalUid).toMatch(UID_PATTERN);
    expect(second.properties.icalUid).not.toBe(first.properties.icalUid);
    expect(identity(await chokePoint.getItem(eventsId, first.id))).toEqual(identity(first));
  });

  it("overwrites a value an internal caller passes on create", async () => {
    const created = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        {
          databaseId: eventsId,
          properties: { name: "Copy", date: "2026-10-16", icalUid: "forged@example.com", icalSequence: 7 },
        },
        { allowedSystemKeys: ["icalUid", "icalSequence"] },
      ),
    );
    expect(created.properties.icalUid).toMatch(UID_PATTERN);
    expect(created.properties.icalSequence).toBe(0);
  });

  it.each(["icalUid", "icalSequence"])(
    "refuses a generic create that names %s with 403 and writes nothing",
    async (key) => {
      const before = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM items WHERE database_id = $1",
        [eventsId],
      );
      await expect(createEvent({ [key]: key === "icalUid" ? "forged@example.com" : 5 })).rejects.toMatchObject({
        status: 403,
        code: "owner_violation",
        details: { field: key },
      });
      const after = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM items WHERE database_id = $1",
        [eventsId],
      );
      expect(after.rows).toEqual(before.rows);
    },
  );

  it.each([
    ["timeFrom", { timeFrom: "08:00" }],
    ["date", { date: "2026-10-17" }],
    ["endDate", { endDate: "2026-10-18" }],
    ["timeTo", { timeTo: "12:00" }],
    ["place", { place: "Room 2" }],
  ])("bumps the sequence by 1 when %s changes", async (_key, patch) => {
    const event = await createEvent({ timeFrom: "09:00", timeTo: "10:00", place: "Room 1" });
    const updated = await chokePoint.updateItem(
      { databaseId: eventsId, itemId: event.id, propertiesPatch: patch },
      undefined,
      undefined,
      USER,
    );
    expect(updated.properties.icalSequence).toBe(1);
    expect(updated.properties.icalUid).toBe(event.properties.icalUid);
    const again = await chokePoint.updateItem(
      { databaseId: eventsId, itemId: event.id, propertiesPatch: { place: "Room 3" } },
      undefined,
      undefined,
      USER,
    );
    expect(again.properties.icalSequence).toBe(2);
  });

  it.each([
    ["a name change", { name: "Renamed" }],
    ["9:00 normalized to the stored 09:00", { timeFrom: "9:00" }],
    ["the same place with surrounding spaces", { place: "  Room 1 " }],
    ["the same date", { date: "2026-10-16" }],
  ])("leaves the sequence alone for %s", async (_label, patch) => {
    const event = await createEvent({ timeFrom: "09:00", timeTo: "10:00", place: "Room 1" });
    const updated = await chokePoint.updateItem(
      { databaseId: eventsId, itemId: event.id, propertiesPatch: patch },
      undefined,
      undefined,
      USER,
    );
    expect(identity(updated)).toEqual(identity(event));
    expect((await chokePoint.getItem(eventsId, event.id))?.properties.icalSequence).toBe(0);
  });

  it.each([
    ["icalUid", "forged@example.com"],
    ["icalSequence", 42],
  ])("refuses a generic PATCH of %s with 403 and leaves the row unchanged", async (key, value) => {
    const event = await createEvent();
    const error = await chokePoint
      .updateItem(
        { databaseId: eventsId, itemId: event.id, propertiesPatch: { [key]: value } },
        undefined,
        undefined,
        USER,
      )
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({ status: 403, code: "owner_violation", details: { field: key } });
    const after = await chokePoint.getItem(eventsId, event.id);
    expect(after?.properties).toEqual(event.properties);
    expect(after?.updatedAt).toBe(event.updatedAt);
  });

  it("gives an Event created by confirming an Inbox proposal the same identity", async () => {
    const inboxId = await databaseIdFor("inbox");
    const typesId = await databaseIdFor("inboxItemTypes");
    const proposalsId = await databaseIdFor("processingProposals");
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Meeting",
        emoji: "📅",
        processingMethod: "database",
        targetDatabase: "events",
      }),
    );
    const inboxItem = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-10-16",
        time: "09:00",
        text: "Meeting with the client",
        type: type.id,
      }),
    );
    const tick = createSemprecTickAction(pool, async () => ({
      properties: { name: "Client meeting", date: "2026-10-16", timeFrom: "9:00" },
    }));
    await tick(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb", projectItemId: "proj", itemId: inboxItem.id },
    );
    const proposal = await withTransaction(pool, async (client) => {
      const sourceInbox = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, sourceInbox!.id);
      const [edge] = await relationsStore.listRelationsForItem(client, definition!.id, inboxItem.id);
      if (!edge) throw new Error("The tick made no proposal");
      return itemsStore.getItemById(client, proposalsId, relationsStore.otherSide(edge, inboxItem.id));
    });
    if (!proposal) throw new Error("Proposal missing");
    const confirmed = await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );
    const resultItemId = z.string().parse(confirmed.properties.resultItemId);
    const event = await chokePoint.getItem(eventsId, resultItemId);
    expect(event?.properties).toMatchObject({ timeFrom: "09:00", timeTo: "10:00", icalSequence: 0 });
    expect(event?.properties.icalUid).toMatch(UID_PATTERN);
  });
});

describe("Events iCalendar identity cutover (issue #1599)", () => {
  let adminPool: Pool;
  let dataPool: Pool;
  let zero: string;
  let other: string;

  const propertyShape = z.array(
    z.object({
      key: z.string(),
      name: z.string().nullable(),
      type: z.string(),
      config: z.unknown(),
      locked: z.boolean(),
      owner: z.string(),
      owner_process: z.string().nullable(),
      migration_status: z.string(),
    }),
  );

  async function icalProperties(tenantId: string) {
    const { rows } = await adminPool.query<Record<string, unknown>>(
      `SELECT p.key, p.name, p.type, p.config, p.locked, p.owner, p.owner_process, p.migration_status
         FROM properties p JOIN databases d ON d.id = p.database_id
        WHERE d.tenant_id = $1 AND d.owner_module_id = 'events' AND p.key IN ('icalUid', 'icalSequence')
        ORDER BY p.key`,
      [tenantId],
    );
    return propertyShape.parse(rows);
  }

  const eventRows = z.array(
    z.object({
      id: z.string(),
      properties: z.record(z.string(), z.unknown()),
      updated_at: z.string(),
      deleted: z.boolean(),
    }),
  );

  async function events(tenantId: string) {
    const { rows } = await adminPool.query<Record<string, unknown>>(
      `SELECT i.id::text, i.properties, i.updated_at::text, i.deleted_at IS NOT NULL AS deleted
         FROM items i JOIN databases d ON d.id = i.database_id
        WHERE d.tenant_id = $1 AND d.owner_module_id = 'events' ORDER BY i.id`,
      [tenantId],
    );
    return eventRows.parse(rows);
  }

  /**
   * Reproduces a tenant seeded before issue #1599: its Events carry no identity and its Events database
   * has no definitions. The locked schema and the system-owned keys have no public removal path, so this
   * runs on the admin pool.
   */
  async function revertToOldShape(tenantId: string): Promise<void> {
    await adminPool.query(
      `UPDATE items i SET properties = i.properties - 'icalUid' - 'icalSequence'
         FROM databases d WHERE d.id = i.database_id AND d.tenant_id = $1 AND d.owner_module_id = 'events'`,
      [tenantId],
    );
    await adminPool.query(
      `DELETE FROM properties p USING databases d
        WHERE d.id = p.database_id AND d.tenant_id = $1 AND d.owner_module_id = 'events'
          AND p.key IN ('icalUid', 'icalSequence')`,
      [tenantId],
    );
  }

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    zero = getTenantZeroId();
    other = await createTestTenant(adminPool);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  async function seedWithEvents(tenantId: string, count: number): Promise<string[]> {
    return runInTenant(tenantId, async () => {
      await seedSystem(dataPool, createViewTypeRegistry());
      const cp = createChokePoint(dataPool);
      const databaseId = await databaseIdFor("events", dataPool);
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        ids.push((await cp.createItem({ databaseId, properties: { name: `Event ${index}`, date: "2026-10-16" } })).id);
      }
      return ids;
    });
  }

  it("adds the definitions identical to a fresh seed and backfills every Event, trashed ones included, once", async () => {
    const zeroEvents = await seedWithEvents(zero, 3);
    await seedWithEvents(other, 1);
    const fresh = await icalProperties(zero);
    expect(fresh.map((property) => [property.key, property.type, property.owner, property.locked])).toEqual([
      ["icalSequence", "number", "system", true],
      ["icalUid", "text", "system", true],
    ]);
    await runInTenant(zero, async () => {
      await createChokePoint(dataPool).softDeleteItem(await databaseIdFor("events", dataPool), zeroEvents[2]!);
    });
    await revertToOldShape(zero);
    const untouchedOther = await events(other);
    const before = await events(zero);
    expect(before.every((row) => !Object.hasOwn(row.properties, "icalUid"))).toBe(true);
    expect(before.filter((row) => row.deleted)).toHaveLength(1);
    expect(await icalProperties(zero)).toEqual([]);

    await runAsSystem("test iCalendar cutover", () => runTenantCutoverMigrations(dataPool));

    expect(await icalProperties(zero)).toEqual(fresh);
    const after = await events(zero);
    expect(after.map((row) => [row.id, row.properties.icalUid, row.properties.icalSequence])).toEqual(
      before.map((row) => [row.id, `${row.id}@semprec`, 0]),
    );
    expect(new Set(after.map((row) => row.properties.icalUid)).size).toBe(after.length);
    expect(after.map((row) => row.updated_at)).toEqual(before.map((row) => row.updated_at));
    expect(await events(other)).toEqual(untouchedOther);

    await runInTenant(zero, () => runEventsIcalIdentityCutoverMigration(dataPool));
    expect(await icalProperties(zero)).toEqual(fresh);
    expect(await events(zero)).toEqual(after);
  });

  it("keeps the UID of an Event that already has one and backfills only the others", async () => {
    const [kept, missing] = await seedWithEvents(zero, 2);
    const keptRow = (await events(zero)).find((row) => row.id === kept);
    // A tenant cut over halfway: one Event lost its identity, the other keeps the transform's UID.
    await adminPool.query("UPDATE items SET properties = properties - 'icalUid' - 'icalSequence' WHERE id = $1", [
      missing,
    ]);
    await runInTenant(zero, () => runEventsIcalIdentityCutoverMigration(dataPool));
    const after = await events(zero);
    expect(after.find((row) => row.id === kept)).toEqual(keptRow);
    expect(after.find((row) => row.id === missing)?.properties).toMatchObject({
      icalUid: `${missing}@semprec`,
      icalSequence: 0,
    });
  });

  it("backfills more Events than one batch of 500 holds, each with its own UID and sequence 0, once", async () => {
    await seedWithEvents(zero, 0);
    // 501 Events, one more than a batch, created through the production writer in one transaction.
    await runInTenant(zero, async () => {
      const databaseId = await databaseIdFor("events", dataPool);
      await withTransaction(dataPool, async (client) => {
        for (let index = 0; index < 501; index += 1) {
          await createItemWithClient(client, {
            databaseId,
            properties: { name: `Bulk ${index}`, date: "2026-10-16" },
          });
        }
      });
    });
    await revertToOldShape(zero);
    const before = await events(zero);
    expect(before).toHaveLength(501);
    expect(before.every((row) => !Object.hasOwn(row.properties, "icalUid"))).toBe(true);

    await runInTenant(zero, () => runEventsIcalIdentityCutoverMigration(dataPool));

    const after = await events(zero);
    expect(after.map((row) => row.properties.icalUid)).toEqual(after.map((row) => `${row.id}@semprec`));
    expect(after.every((row) => row.properties.icalSequence === 0)).toBe(true);
    expect(new Set(after.map((row) => row.properties.icalUid)).size).toBe(501);
    // The backfill writes only the identity: updated_at and the other properties are as before.
    expect(after.map(({ id, updated_at }) => ({ id, updated_at }))).toEqual(
      before.map(({ id, updated_at }) => ({ id, updated_at })),
    );
    await runInTenant(zero, () => runEventsIcalIdentityCutoverMigration(dataPool));
    expect(await events(zero)).toEqual(after);
  });

  it("does nothing for a tenant without an Events database", async () => {
    await expect(runInTenant(other, () => runEventsIcalIdentityCutoverMigration(dataPool))).resolves.toBeUndefined();
    const { rows } = await adminPool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM properties WHERE tenant_id = $1",
      [other],
    );
    expect(rows).toEqual([{ count: 0 }]);
  });
});
