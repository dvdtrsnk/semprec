import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { prepareUserItemPatch } from "../chokePoint/itemWrites.js";
import { prepareEventTime } from "../calendar/eventTime.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { withTransaction } from "../db/pool.js";
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

function timesOf(properties: Record<string, unknown>) {
  const { date, endDate, timeFrom, timeTo, time } = properties;
  return { date, endDate: endDate ?? null, timeFrom: timeFrom ?? null, timeTo: timeTo ?? null, time: time ?? null };
}

function times(item: ItemRow) {
  return timesOf(item.properties);
}

/** The properties the Events time transform would store for this write, read through its preparation. */
async function prepared(stored: ItemRow | null, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await prepareEventTime({ stored, patch: { ...patch }, timezone: "Europe/Prague" });
  return { ...(stored?.properties ?? {}), ...result.patch };
}

function patchEvent(event: ItemRow, propertiesPatch: Record<string, unknown>): Promise<ItemRow> {
  return chokePoint.updateItem({ databaseId: eventsId, itemId: event.id, propertiesPatch }, undefined, undefined, USER);
}

/** The write is refused by the Events validation of issue #1663, naming `field`. */
async function expectRefused(write: Promise<unknown>, field: string): Promise<void> {
  await expect(write).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field } });
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
    const multiDay = { date: "2026-10-16", endDate: "2026-10-18", timeFrom: "08:00" };
    expect(timesOf(await prepared(null, multiDay))).toEqual({
      date: "2026-10-16",
      endDate: "2026-10-18",
      timeFrom: "08:00",
      timeTo: null,
      time: "08:00",
    });
    // Issue #1663: a timed Event spanning days needs an explicit end, so the write without one is refused; with one,
    // the write stores the given end unchanged.
    await expectRefused(createEvent(multiDay), "timeTo");
    const ended = await createEvent({ ...multiDay, timeTo: "02:00" });
    expect(times(ended)).toEqual({
      date: "2026-10-16",
      endDate: "2026-10-18",
      timeFrom: "08:00",
      timeTo: "02:00",
      time: "08:00–02:00",
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

  // Issue #1663 rejects every value the transform leaves unreadable, so the transform's own output for those values is
  // read through its read-only preparation (the same `deriveEventTimeProperties`), and the write is asserted refused.
  it("reads a date with a time but no offset as wall-clock, and leaves date-only and unreadable dates alone", async () => {
    await setTenantZone("America/New_York");
    const wallClock = await createEvent({ date: "2026-10-16T08:00" });
    expect(times(wallClock)).toMatchObject({ date: "2026-10-16", timeFrom: "08:00", timeTo: "09:00" });
    expect(timesOf(await prepared(null, { date: "next Tuesday" }))).toEqual({
      date: "next Tuesday",
      endDate: null,
      timeFrom: null,
      timeTo: null,
      time: null,
    });
    await expectRefused(createEvent({ date: "next Tuesday" }), "date");
  });

  it("leaves a wall-clock date with unreadable seconds unchanged on create and update, and still reads valid seconds", async () => {
    for (const date of ["2026-10-16T10:15:99", "2026-10-16 10:15:60"]) {
      expect(timesOf(await prepared(null, { date })), date).toEqual({
        date,
        endDate: null,
        timeFrom: null,
        timeTo: null,
        time: null,
      });
      await expectRefused(createEvent({ date }), "date");
    }
    const valid = await createEvent({ date: "2026-10-16T10:15:30" });
    expect(times(valid)).toMatchObject({ date: "2026-10-16", timeFrom: "10:15", timeTo: "11:15" });

    const event = await createEvent({ date: "2026-10-16", timeFrom: "09:00" });
    // The malformed value does not replace the stored start in the transform, and issue #1663 refuses the write.
    expect(timesOf(await prepared(event, { date: "2026-10-16T10:15:99" }))).toEqual({
      date: "2026-10-16T10:15:99",
      endDate: null,
      timeFrom: "09:00",
      timeTo: "10:00",
      time: "09:00–10:00",
    });
    await expectRefused(patchEvent(event, { date: "2026-10-16T10:15:99" }), "date");
    expect(times((await chokePoint.getItem(eventsId, event.id))!)).toEqual(times(event));
  });

  it("stores time null without a start even when the end is unreadable, on create and update", async () => {
    const created = await prepared(null, { date: "2026-10-16", timeTo: "invalid" });
    expect(timesOf(created)).toEqual({
      date: "2026-10-16",
      endDate: null,
      timeFrom: null,
      timeTo: "invalid",
      time: null,
    });
    expect(Object.hasOwn(created, "time")).toBe(true);
    await expectRefused(createEvent({ date: "2026-10-16", timeTo: "invalid" }), "timeTo");

    const event = await createEvent({ date: "2026-10-16", timeFrom: "09:00" });
    expect(times(event).time).toBe("09:00–10:00");
    expect(timesOf(await prepared(event, { timeFrom: null, timeTo: "invalid" }))).toEqual({
      date: "2026-10-16",
      endDate: null,
      timeFrom: null,
      timeTo: "invalid",
      time: null,
    });
    await expectRefused(patchEvent(event, { timeFrom: null, timeTo: "invalid" }), "timeTo");

    // Clearing only the start drops the derived time and keeps the stored end in the transform; issue #1663 then
    // refuses an end without a start.
    expect(timesOf(await prepared(event, { timeFrom: null }))).toMatchObject({
      timeFrom: null,
      timeTo: "10:00",
      time: null,
    });
    await expectRefused(patchEvent(event, { timeFrom: null }), "timeTo");
    expect(times((await chokePoint.getItem(eventsId, event.id))!)).toEqual(times(event));
  });

  it("keeps a start of 24:00 as written on create and update and derives no time or end from it", async () => {
    expect(timesOf(await prepared(null, { date: "2026-10-16", timeFrom: "24:00" }))).toEqual({
      date: "2026-10-16",
      endDate: null,
      timeFrom: "24:00",
      timeTo: null,
      time: null,
    });
    await expectRefused(createEvent({ date: "2026-10-16", timeFrom: "24:00" }), "timeFrom");

    const event = await createEvent({ date: "2026-10-16", timeFrom: "09:00" });
    // Only an end may be 24:00: the start stays unreadable, and the derived time stays as stored.
    expect(timesOf(await prepared(event, { timeFrom: "24:00" }))).toEqual({
      date: "2026-10-16",
      endDate: null,
      timeFrom: "24:00",
      timeTo: "10:00",
      time: "09:00–10:00",
    });
    await expectRefused(patchEvent(event, { timeFrom: "24:00" }), "timeFrom");
  });

  it("leaves an unreadable time unchanged and derives no time from it", async () => {
    expect(timesOf(await prepared(null, { date: "2026-10-16", timeFrom: "nine", timeTo: "25:00" }))).toEqual({
      date: "2026-10-16",
      endDate: null,
      timeFrom: "nine",
      timeTo: "25:00",
      time: null,
    });
    await expectRefused(createEvent({ date: "2026-10-16", timeFrom: "nine", timeTo: "25:00" }), "timeFrom");
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

  it("prepares an update proposal with the supplied tenant zone exactly as the write stores it", async () => {
    const event = await createEvent({ date: "2026-10-16", timeFrom: "09:00" });
    const { database, properties } = await withTransaction(pool, async (client) => ({
      database: (await databasesStore.getDatabase(client, eventsId))!,
      properties: await propertiesStore.listPropertiesByDatabase(client, eventsId),
    }));
    const stored = (await withTransaction(pool, (client) => itemsStore.getItemById(client, eventsId, event.id)))!;
    const prepared = await prepareUserItemPatch(properties, { timeFrom: "7:45" }, database, stored, "Europe/Prague");
    // The iCalendar preparation that runs after it adds the bumped sequence (issue #1599).
    expect(prepared).toEqual({ patch: { timeFrom: "07:45", time: "07:45–10:00", icalSequence: 1 }, deferredKeys: [] });

    for (const zone of ["Europe/Prague", "America/New_York"]) {
      // The row as this iteration's write will find it: the previous iteration wrote and restored it.
      const current = (await withTransaction(pool, (client) => itemsStore.getItemById(client, eventsId, event.id)))!;
      // The end is cleared so the moved start gets its one-hour end: a start after the stored end is refused (#1663).
      const patch = { date: "2026-10-16T14:00:00Z", timeTo: null };
      const instant = await prepareUserItemPatch(properties, patch, database, current, zone);
      await setTenantZone(zone);
      const written = await chokePoint.updateItem(
        { databaseId: eventsId, itemId: event.id, propertiesPatch: patch },
        undefined,
        undefined,
        USER,
      );
      // The prepared patch names only the keys it changes; the stored row supplies the rest.
      const effective = { ...current.properties, ...instant.patch };
      for (const key of ["date", "timeFrom", "timeTo", "time", "icalSequence"]) {
        expect(effective[key], `${zone} ${key}`).toEqual(written.properties[key]);
      }
      expect(instant.patch.timeFrom).toBe(zone === "Europe/Prague" ? "16:00" : "10:00");
      // The iCalendar preparation compares the time-normalized values: the start moved, so the sequence is bumped.
      expect(instant.patch.icalSequence).toBe(Number(current.properties.icalSequence) + 1);
      // Restore the stored row the next zone's preparation starts from.
      await chokePoint.updateItem(
        { databaseId: eventsId, itemId: event.id, propertiesPatch: { date: "2026-10-16", timeFrom: "09:00" } },
        undefined,
        undefined,
        USER,
      );
    }
  });

  it("refuses to prepare an instant date when the caller supplied no zone, and guesses none", async () => {
    const event = await createEvent({ date: "2026-10-16", timeFrom: "09:00" });
    const stored = (await withTransaction(pool, (client) => itemsStore.getItemById(client, eventsId, event.id)))!;
    const patch = { date: "2026-10-16T08:00:00Z" };
    await expect(prepareEventTime({ stored, patch })).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { field: "date" },
    });
    // A date-only patch needs no zone and still prepares.
    await expect(prepareEventTime({ stored, patch: { date: "2026-10-17" } })).resolves.toMatchObject({
      patch: { date: "2026-10-17", time: "09:00–10:00" },
    });
  });
});
