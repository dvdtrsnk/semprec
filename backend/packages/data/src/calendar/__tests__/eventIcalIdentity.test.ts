import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@alldots/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { ForbiddenError } from "../../errors.js";
import { createInboxItemWithClient } from "../../inbox/inboxStore.js";
import { createInboxTypeWithClient } from "../../inbox/inboxTypesStore.js";
import { createAlldotsTickAction } from "../../inbox/inboxTickAction.js";
import { confirmProposalWithClient } from "../../inbox/proposalActions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import type { ItemRow } from "../../types.js";

const UID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@alldots$/;
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

  it("gives a created Event a distinct <uuid>@alldots UID and sequence 0", async () => {
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
    const tick = createAlldotsTickAction(pool, async () => ({
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

describe("Events iCalendar identity definitions (issue #1599)", () => {
  let adminPool: Pool;
  let dataPool: Pool;

  const propertyShape = z.array(
    z.object({
      key: z.string(),
      type: z.string(),
      locked: z.boolean(),
      owner: z.string(),
    }),
  );

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "alldots_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("declares icalUid and icalSequence in a fresh seed as locked system properties", async () => {
    const zero = getTenantZeroId();
    await runInTenant(zero, () => seedSystem(dataPool, createViewTypeRegistry()));
    const { rows } = await adminPool.query<Record<string, unknown>>(
      `SELECT p.key, p.type, p.locked, p.owner
         FROM properties p JOIN databases d ON d.id = p.database_id
        WHERE d.tenant_id = $1 AND d.owner_module_id = 'events' AND p.key IN ('icalUid', 'icalSequence')
        ORDER BY p.key`,
      [zero],
    );
    expect(propertyShape.parse(rows)).toEqual([
      { key: "icalSequence", type: "number", locked: true, owner: "system" },
      { key: "icalUid", type: "text", locked: true, owner: "system" },
    ]);
  });
});
