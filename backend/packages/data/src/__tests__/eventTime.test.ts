import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { prepareUserItemPatch } from "../chokePoint/itemWrites.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../systemSettings.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import type { ItemRow } from "../types.js";

let pool: Pool;
let chokePoint: ChokePoint;
let eventsId: string;

const USER = { writerKind: "user" } as const;

async function createEvent(properties: Record<string, unknown>): Promise<ItemRow> {
  return chokePoint.createItem(
    { databaseId: eventsId, properties: { name: "Event", ...properties } },
    undefined,
    undefined,
    USER,
  );
}

async function storedTimestamps(itemId: string): Promise<{ created: string; updated: string }> {
  const { rows } = await pool.query<{ created: string; updated: string }>(
    "SELECT created_at::text AS created, updated_at::text AS updated FROM items WHERE database_id = $1 AND id = $2",
    [eventsId, itemId],
  );
  if (!rows[0]) throw new Error("Event row missing");
  return rows[0];
}

async function setTenantZone(zone: string): Promise<void> {
  const databaseId = await withTransaction(pool, (client) => getSystemSettingsDatabaseId(client));
  const itemId = await withTransaction(pool, (client) => getSystemSettingsItemId(client));
  await chokePoint.updateItem({ databaseId, itemId, propertiesPatch: { timezone: zone } });
}

function times(item: ItemRow) {
  const { date, endDate, timeFrom, timeTo, time } = item.properties;
  return { date, endDate: endDate ?? null, timeFrom: timeFrom ?? null, timeTo: timeTo ?? null, time: time ?? null };
}

describe("Events time normalization before the write (issue #1598)", () => {
  beforeAll(() => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedSystem(pool);
    const database = await withTransaction(pool, (client) => databasesStore.getDatabaseByModuleId(client, "events"));
    if (!database) throw new Error("Events database was not seeded");
    eventsId = database.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("normalizes 9:00 and 11:30 and derives time in the same single write", async () => {
    const event = await createEvent({ date: "2026-10-16", timeFrom: "9:00", timeTo: "11:30" });
    expect(times(event)).toEqual({
      date: "2026-10-16",
      endDate: null,
      timeFrom: "09:00",
      timeTo: "11:30",
      time: "09:00–11:30",
    });
    // One insert: the row was never updated after it was created.
    const stamps = await storedTimestamps(event.id);
    expect(stamps.updated).toBe(stamps.created);
    expect(times((await chokePoint.getItem(eventsId, event.id))!)).toEqual(times(event));
  });

  it.each([
    ["14:00", "15:00"],
    ["23:30", "24:00"],
    ["23:00", "24:00"],
  ])("gives a single-day Event starting at %s an end at %s", async (timeFrom, timeTo) => {
    const event = await createEvent({ date: "2026-10-16", timeFrom });
    expect(times(event)).toMatchObject({ timeFrom, timeTo, time: `${timeFrom}–${timeTo}` });
  });

  it("gives an Event whose endDate equals its date the one-hour end too", async () => {
    const event = await createEvent({ date: "2026-10-16", endDate: "2026-10-16", timeFrom: "8:15" });
    expect(times(event)).toMatchObject({ timeFrom: "08:15", timeTo: "09:15", time: "08:15–09:15" });
  });

  it("does not invent an end for a multi-day Event", async () => {
    const event = await createEvent({ date: "2026-10-16", endDate: "2026-10-18", timeFrom: "08:00" });
    expect(times(event)).toEqual({
      date: "2026-10-16",
      endDate: "2026-10-18",
      timeFrom: "08:00",
      timeTo: null,
      time: "08:00",
    });
  });

  it("stores time null for an all-day Event", async () => {
    const event = await createEvent({ date: "2026-10-16" });
    expect(times(event)).toEqual({ date: "2026-10-16", endDate: null, timeFrom: null, timeTo: null, time: null });
    expect(Object.hasOwn(event.properties, "time")).toBe(true);
  });

  it("converts an instant date in the Europe/Prague tenant to the wall-clock date, start and one-hour end", async () => {
    const event = await createEvent({ date: "2026-10-16T08:00:00Z" });
    expect(times(event)).toEqual({
      date: "2026-10-16",
      endDate: null,
      timeFrom: "10:00",
      timeTo: "11:00",
      time: "10:00–11:00",
    });
  });

  it("converts an instant date in the America/New_York tenant zone", async () => {
    await setTenantZone("America/New_York");
    const event = await createEvent({ date: "2026-10-16T14:00:00Z" });
    expect(times(event)).toMatchObject({ date: "2026-10-16", timeFrom: "10:00", timeTo: "11:00" });
    // The tenant zone decides the day as well: 02:30 UTC is still the previous evening in New York.
    const evening = await createEvent({ date: "2026-10-17T02:30:00+00:00" });
    expect(times(evening)).toMatchObject({ date: "2026-10-16", timeFrom: "22:30", timeTo: "23:30" });
  });

  it("reads a date with a time but no offset as wall-clock, and leaves date-only and unreadable dates alone", async () => {
    await setTenantZone("America/New_York");
    const wallClock = await createEvent({ date: "2026-10-16T08:00" });
    expect(times(wallClock)).toMatchObject({ date: "2026-10-16", timeFrom: "08:00", timeTo: "09:00" });
    const unreadable = await createEvent({ date: "next Tuesday" });
    expect(times(unreadable)).toEqual({
      date: "next Tuesday",
      endDate: null,
      timeFrom: null,
      timeTo: null,
      time: null,
    });
  });

  it("leaves an unreadable time unchanged and derives no time from it", async () => {
    const event = await createEvent({ date: "2026-10-16", timeFrom: "nine", timeTo: "25:00" });
    expect(times(event)).toEqual({ date: "2026-10-16", endDate: null, timeFrom: "nine", timeTo: "25:00", time: null });
  });

  it("recomputes time from the stored timeTo when a patch changes only timeFrom, in the same write", async () => {
    const event = await createEvent({ date: "2026-10-16", timeFrom: "09:00", timeTo: "12:00" });
    const updated = await chokePoint.updateItem(
      { databaseId: eventsId, itemId: event.id, propertiesPatch: { timeFrom: "10:30" } },
      undefined,
      undefined,
      USER,
    );
    expect(times(updated)).toEqual({
      date: "2026-10-16",
      endDate: null,
      timeFrom: "10:30",
      timeTo: "12:00",
      time: "10:30–12:00",
    });
    // The returned row is the one UPDATE's own result, and nothing wrote the row after it.
    const read = await chokePoint.getItem(eventsId, event.id);
    expect(read?.updatedAt).toBe(updated.updatedAt);
    expect(times(read!)).toEqual(times(updated));
  });

  it("leaves time untouched on a patch that changes no time input", async () => {
    const event = await createEvent({ date: "2026-10-16", timeFrom: "09:00" });
    const updated = await chokePoint.updateItem(
      { databaseId: eventsId, itemId: event.id, propertiesPatch: { name: "Renamed", place: "Office" } },
      undefined,
      undefined,
      USER,
    );
    expect(updated.properties).toMatchObject({ name: "Renamed", place: "Office" });
    expect(times(updated)).toEqual(times(event));
  });

  it("prepares an update proposal with the same normalization and refuses to predict an instant without the zone", async () => {
    const event = await createEvent({ date: "2026-10-16", timeFrom: "09:00" });
    const { database, properties } = await withTransaction(pool, async (client) => ({
      database: (await databasesStore.getDatabase(client, eventsId))!,
      properties: await propertiesStore.listPropertiesByDatabase(client, eventsId),
    }));
    const stored = (await withTransaction(pool, (client) => itemsStore.getItemById(client, eventsId, event.id)))!;
    const prepared = await prepareUserItemPatch(properties, { timeFrom: "7:45" }, database, stored);
    // The iCalendar preparation that runs after it adds the bumped sequence (issue #1599).
    expect(prepared).toEqual({ patch: { timeFrom: "07:45", time: "07:45–10:00", icalSequence: 1 }, deferredKeys: [] });
    await expect(prepareUserItemPatch(properties, { date: "2026-10-16T08:00:00Z" }, database, stored)).rejects.toThrow(
      ValidationError,
    );
  });
});
