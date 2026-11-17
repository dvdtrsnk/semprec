import "../../domainWriteHooks.js";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { prepareItemPreWriteTransforms } from "../../chokePoint/hooks.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../../systemSettings.js";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { materializeEventOccurrence } from "../materializeEventOccurrence.js";

const USER = { writerKind: "user" } as const;
const WEEKDAYS = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] };
/** Saturday 17 October 2026, noon in Prague. */
const SATURDAY = new Date("2026-10-17T10:00:00Z");
const FORBIDDEN = { status: 403, code: "owner_violation", details: { field: "nextOccurrenceDate" } };

let pool: Pool;

describe("Events nextOccurrenceDate on write (issue gh-1905)", () => {
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
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SATURDAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await pool?.end();
  });

  const createEvent = (properties: Record<string, unknown>) =>
    cp.createItem({ databaseId: eventsId, properties: { name: "Event", ...properties } }, undefined, undefined, USER);

  const patchEvent = (itemId: string, propertiesPatch: Record<string, unknown>) =>
    cp.updateItem({ databaseId: eventsId, itemId, propertiesPatch }, undefined, undefined, USER);

  const stored = async (itemId: string) => (await cp.getItem(eventsId, itemId))?.properties.nextOccurrenceDate;

  async function setTimezone(timezone: string): Promise<void> {
    const settings = await withTransaction(pool, async (client) => ({
      databaseId: await getSystemSettingsDatabaseId(client),
      itemId: await getSystemSettingsItemId(client),
    }));
    await cp.updateItem({ ...settings, propertiesPatch: { timezone } });
  }

  it("gives a created recurring Event the day of its nearest occurrence from today", async () => {
    const created = await createEvent({ name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });

    expect(created.properties.nextOccurrenceDate).toBe("2026-10-19");
    expect(await stored(created.id)).toBe("2026-10-19");
  });

  it("gives a created recurring Event its own day on a day it occurs", async () => {
    vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));

    const created = await createEvent({ name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });

    expect(await stored(created.id)).toBe("2026-10-16");
  });

  it("gives a created Event without a rule its own date", async () => {
    const created = await createEvent({ name: "Dentist", date: "2026-10-12" });

    expect(await stored(created.id)).toBe("2026-10-12");
  });

  it("reads today in the tenant time zone", async () => {
    vi.setSystemTime(new Date("2026-10-16T23:30:00Z"));
    await setTimezone("America/Los_Angeles");

    const created = await createEvent({ name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });

    expect(await stored(created.id)).toBe("2026-10-16");
  });

  it("gives an occurrence item materialized from the series its own date", async () => {
    const series = await createEvent({ name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });

    const result = await withTransaction(pool, (client) =>
      materializeEventOccurrence(client, { seriesId: series.id, occurrenceDate: "2026-10-21", options: {} }),
    );

    expect(result.item.properties.nextOccurrenceDate).toBe("2026-10-21");
    expect(await stored(series.id)).toBe("2026-10-19");
  });

  it("recomputes when the recurrence rule changes", async () => {
    const created = await createEvent({ name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    expect(await stored(created.id)).toBe("2026-10-19");

    await patchEvent(created.id, { recurrence: { kind: "weekdays", days: ["sat"] } });

    expect(await stored(created.id)).toBe("2026-10-17");
  });

  it("skips a cancelled occurrence when a stored series is recomputed, as the timeline does", async () => {
    const series = await createEvent({ name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    const monday = await withTransaction(pool, (client) =>
      materializeEventOccurrence(client, { seriesId: series.id, occurrenceDate: "2026-10-19", options: {} }),
    );
    await cp.softDeleteItem(eventsId, monday.item.id, undefined, USER);
    expect(await stored(series.id)).toBe("2026-10-20");

    // Rule only, Monday 19 Oct would be the next day again; the cancelled Monday is not an occurrence.
    await patchEvent(series.id, { recurrence: { kind: "weekdays", days: ["mon", "tue"] } });

    expect(await stored(series.id)).toBe("2026-10-20");
  });

  it("names the day an occurrence was moved to when a stored series is recomputed", async () => {
    const series = await createEvent({ name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    const monday = await withTransaction(pool, (client) =>
      materializeEventOccurrence(client, { seriesId: series.id, occurrenceDate: "2026-10-19", options: {} }),
    );
    await patchEvent(monday.item.id, { date: "2026-10-18" });
    expect(await stored(series.id)).toBe("2026-10-18");

    await patchEvent(series.id, { endDate: "2026-10-12" });

    expect(await stored(series.id)).toBe("2026-10-18");
  });

  it("recomputes when the date changes", async () => {
    const created = await createEvent({ name: "Dentist", date: "2026-10-12" });

    await patchEvent(created.id, { date: "2026-10-30" });

    expect(await stored(created.id)).toBe("2026-10-30");
  });

  it("keeps the value of an update that changes the end date only, which does not move the day", async () => {
    const created = await createEvent({ name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });

    const patched = await patchEvent(created.id, { endDate: "2026-10-13" });

    expect(patched.properties.nextOccurrenceDate).toBe("2026-10-19");
    expect(await stored(created.id)).toBe("2026-10-19");
  });

  it("leaves the stored value alone on an update that names no day and no rule", async () => {
    const created = await createEvent({ name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    vi.setSystemTime(new Date("2026-10-21T10:00:00Z"));

    await patchEvent(created.id, { name: "Daily standup" });

    expect(await stored(created.id)).toBe("2026-10-19");
  });

  it("refuses a generic create that sets the property, with 403, and stores nothing", async () => {
    await expect(
      createEvent({ name: "Dentist", date: "2026-10-12", nextOccurrenceDate: "2026-12-01" }),
    ).rejects.toMatchObject(FORBIDDEN);

    expect((await cp.queryDatabaseItems(eventsId, {})).items).toEqual([]);
  });

  it("refuses a generic update that sets the property, with 403, and keeps the stored value", async () => {
    const created = await createEvent({ name: "Dentist", date: "2026-10-12" });

    await expect(patchEvent(created.id, { nextOccurrenceDate: "2026-12-01" })).rejects.toMatchObject(FORBIDDEN);
    await expect(
      patchEvent(created.id, { date: "2026-10-30", nextOccurrenceDate: "2026-12-01" }),
    ).rejects.toMatchObject(FORBIDDEN);

    expect(await stored(created.id)).toBe("2026-10-12");
    expect((await cp.getItem(eventsId, created.id))?.properties.date).toBe("2026-10-12");
  });

  it("lists a series once, at its next day, when the Events are sorted by the property", async () => {
    const standup = await createEvent({ name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    const dentist = await createEvent({ name: "Dentist", date: "2026-10-18" });
    const lunch = await createEvent({ name: "Lunch", date: "2026-10-14" });

    const ascending = await cp.queryDatabaseItems(eventsId, {
      sort: [{ property: "nextOccurrenceDate", direction: "asc" }],
    });
    const descending = await cp.queryDatabaseItems(eventsId, {
      sort: [{ property: "nextOccurrenceDate", direction: "desc" }],
    });

    expect(ascending.items.map((item) => item.id)).toEqual([lunch.id, dentist.id, standup.id]);
    expect(descending.items.map((item) => item.id)).toEqual([standup.id, dentist.id, lunch.id]);
  });

  it("keeps Events proposals preparable and prepares the same value the write stores", async () => {
    const prepared = await prepareItemPreWriteTransforms("events", {
      stored: null,
      patch: { name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS },
      timezone: "Europe/Prague",
    });

    expect(prepared).not.toBeNull();
    expect(prepared?.patch.nextOccurrenceDate).toBe("2026-10-19");
  });
});
