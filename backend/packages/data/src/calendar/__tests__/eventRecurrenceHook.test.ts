import "../../domainWriteHooks.js";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";

const USER = { writerKind: "user" } as const;
const WEEKDAYS = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] };
const MONTHLY = { kind: "monthDates", dates: [31] };
const LAST_FRIDAY = { kind: "nthWeekday", n: -1, weekday: "fri" };
const INVALID = { status: 400, code: "validation_failed", details: { field: "recurrence" } };

let pool: Pool;

/** The error a write was refused with, or `undefined` when it was stored. */
function refusal(write: Promise<unknown>): Promise<unknown> {
  return write.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

describe("Events recurrence hooks (issue gh-1817)", () => {
  let cp: ChokePoint;
  let eventsId: string;

  beforeAll(() => {
    pool = getTestPool();
    cp = createChokePoint(pool);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedSystem(pool);
    const events = (await cp.listDatabases()).find((database) => database.ownerModuleId === "events");
    if (!events) throw new Error("Missing the events database");
    eventsId = events.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  const createEvent = (properties: Record<string, unknown>) =>
    cp.createItem(
      { databaseId: eventsId, properties: { name: "Standup", date: "2026-10-12", ...properties } },
      undefined,
      undefined,
      USER,
    );

  const patchEvent = (itemId: string, propertiesPatch: Record<string, unknown>) =>
    cp.updateItem({ databaseId: eventsId, itemId, propertiesPatch }, undefined, undefined, USER);

  const storedProperties = async (itemId: string) => (await cp.getItem(eventsId, itemId))?.properties;

  it.each([
    ["weekdays", WEEKDAYS],
    ["monthDates", MONTHLY],
    ["nthWeekday", LAST_FRIDAY],
  ])("stores a created Event's valid %s rule", async (_kind, rule) => {
    const created = await createEvent({ recurrence: rule });

    expect(created.properties.recurrence).toEqual(rule);
    expect((await storedProperties(created.id))?.recurrence).toEqual(rule);
  });

  it("stores an Event created without a rule and gives it no recurrence key", async () => {
    const created = await createEvent({});

    expect(Object.hasOwn((await storedProperties(created.id)) ?? {}, "recurrence")).toBe(false);
  });

  it.each([
    ["null", null],
    ["a string", "weekly"],
    ["an empty weekday list", { kind: "weekdays", days: [] }],
    ["an unknown kind", { kind: "daily" }],
    ["a floating rule", { unit: "days", n: 1 }],
    ["the yearly rule", { kind: "yearDates", month: 5, day: 17 }],
  ])("refuses a create with %s as the rule and stores no Event", async (_label, value) => {
    const before = await cp.listItems(eventsId, { limit: 50 });

    expect(await refusal(createEvent({ name: "Refused", recurrence: value }))).toMatchObject(INVALID);

    expect((await cp.listItems(eventsId, { limit: 50 })).items.map((item) => item.id)).toEqual(
      before.items.map((item) => item.id),
    );
  });

  it("stores a rule given by an update", async () => {
    const event = await createEvent({});

    const patched = await patchEvent(event.id, { recurrence: MONTHLY });

    expect(patched.properties.recurrence).toEqual(MONTHLY);
    expect((await storedProperties(event.id))?.recurrence).toEqual(MONTHLY);
  });

  it("replaces the rule of an Event with another valid rule", async () => {
    const event = await createEvent({ recurrence: WEEKDAYS });

    await patchEvent(event.id, { recurrence: LAST_FRIDAY });

    expect((await storedProperties(event.id))?.recurrence).toEqual(LAST_FRIDAY);
  });

  it.each([
    ["null", null],
    ["a number", 3],
    ["a monthDates rule with the date 32", { kind: "monthDates", dates: [32] }],
    ["the yearly rule", { kind: "yearDates", month: 5, day: 17 }],
  ])("refuses an update with %s as the rule and keeps the stored rule", async (_label, value) => {
    const event = await createEvent({ recurrence: WEEKDAYS });
    const before = await cp.getItem(eventsId, event.id);

    expect(await refusal(patchEvent(event.id, { recurrence: value, name: "Renamed" }))).toMatchObject(INVALID);

    expect(await cp.getItem(eventsId, event.id)).toEqual(before);
  });

  it("does not judge an update that does not name the rule", async () => {
    const event = await createEvent({});
    // A value no write can store any more: the stored Event keeps being editable, as the hook only judges a named key.
    const legacy = await pool.query(
      'UPDATE items SET properties = properties || \'{"recurrence": "weekly"}\'::jsonb WHERE id = $1',
      [event.id],
    );
    expect(legacy.rowCount).toBe(1);

    const patched = await patchEvent(event.id, { name: "Renamed" });

    expect(patched.properties).toMatchObject({ name: "Renamed", recurrence: "weekly" });
  });

  it("leaves a database that is not Events alone, whatever its property named recurrence holds", async () => {
    const database = await cp.createDatabase({ name: "Habits" });
    await cp.createProperty({ databaseId: database.id, key: "recurrence", name: "Recurrence", type: "json" });
    await cp.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });

    const created = await cp.createItem(
      { databaseId: database.id, properties: { name: "Run", recurrence: "weekly" } },
      undefined,
      undefined,
      USER,
    );
    const patched = await cp.updateItem(
      { databaseId: database.id, itemId: created.id, propertiesPatch: { recurrence: 3 } },
      undefined,
      undefined,
      USER,
    );

    expect(created.properties.recurrence).toBe("weekly");
    expect(patched.properties.recurrence).toBe(3);
  });
});
