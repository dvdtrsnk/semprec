import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bindToTenantZero, getTestPool, inTenantZero, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { ValidationError } from "../errors.js";

// Thursday 22 Oct 2026 in the seeded tenant zone (Europe/Prague).
const THURSDAY = new Date("2026-10-22T10:00:00Z");

let pool: Pool;
let cp: ChokePoint;
let databaseId: string;

async function seed(title: string, properties: Record<string, unknown>): Promise<string> {
  return (await cp.createItem({ databaseId, properties: { title, ...properties } })).id;
}

async function titles(filter: unknown, now: Date = THURSDAY): Promise<string[]> {
  const page = await cp.listItems(databaseId, { filter, now });
  return page.items.map((item) => String(item.properties.title)).sort();
}

function relative(preset: unknown, extra: Record<string, unknown> = {}) {
  return { type: "date_relative", property: "due", preset, ...extra };
}

describe("date_relative filter", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await inTenantZero(() => seedSystem(pool));
    cp = bindToTenantZero(createChokePoint(pool));
    databaseId = (await cp.createDatabase({ name: "Relative dates" })).id;
    await cp.createProperty({ databaseId, key: "title", name: "Title", type: "text" });
    await cp.createProperty({ databaseId, key: "due", name: "Due", type: "date" });
    await cp.createProperty({ databaseId, key: "until", name: "Until", type: "date" });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("matches thisWeek, nextWeek and a day range around Thursday 22 Oct 2026", async () => {
    for (const day of ["21", "22", "23", "25", "26", "27", "31"]) await seed(`oct${day}`, { due: `2026-10-${day}` });
    await seed("nov1", { due: "2026-11-01" });
    await seed("nov2", { due: "2026-11-02" });
    await seed("undated", {});

    expect(await titles(relative("thisWeek"))).toEqual(["oct22", "oct23", "oct25"]);
    expect(await titles(relative("nextWeek"))).toEqual(["nov1", "oct26", "oct27", "oct31"]);
    expect(await titles(relative({ fromDays: 2, toDays: 9 }))).toEqual(["oct25", "oct26", "oct27", "oct31"]);
  });

  it("matches a multi-day event through endProperty", async () => {
    await seed("event", { due: "2026-10-21", until: "2026-10-23" });
    await seed("ended", { due: "2026-10-19", until: "2026-10-21" });
    expect(await titles(relative("today", { endProperty: "until" }))).toEqual(["event"]);
    expect(await titles(relative("today"))).toEqual([]);
  });

  it("reduces a timestamp to the tenant-zone day", async () => {
    // 00:30 on the 22nd in Prague is still the 21st in UTC.
    await seed("prague-morning", { due: "2026-10-21T22:30:00Z" });
    await seed("prague-yesterday", { due: "2026-10-21T21:30:00Z" });
    expect(await titles(relative("today"))).toEqual(["prague-morning"]);
    expect(await titles(relative("past"))).toEqual(["prague-yesterday"]);
  });

  it("evaluates beforeNow as an instant for timestamps and as a day for date-only values", async () => {
    await seed("earlier-today", { due: "2026-10-22T07:00:00Z" });
    await seed("later-today", { due: "2026-10-22T11:00:00Z" });
    await seed("date-today", { due: "2026-10-22" });
    await seed("date-yesterday", { due: "2026-10-21" });
    expect(await titles(relative("beforeNow"))).toEqual(["date-yesterday", "earlier-today"]);
  });

  it("changes a stored view's result on the next day without editing it", async () => {
    await seed("thursday", { due: "2026-10-22" });
    await seed("friday", { due: "2026-10-23" });
    const view = await cp.createView({
      databaseId,
      type: "table",
      name: "Upcoming",
      config: { filter: relative("upcoming") },
    });
    const thursdayItems = await cp.queryView(view.id, { now: THURSDAY });
    const fridayItems = await cp.queryView(view.id, { now: new Date("2026-10-23T10:00:00Z") });
    expect(thursdayItems.items).toHaveLength(2);
    expect(fridayItems.items.map((item) => item.properties.title)).toEqual(["friday"]);
  });

  it("returns dated past items and never items without a date", async () => {
    await seed("overdue", { due: "2026-10-01" });
    await seed("today", { due: "2026-10-22" });
    await seed("empty", { due: "" });
    await seed("undated", {});
    expect(await titles(relative("past"))).toEqual(["overdue"]);
    expect(await titles({ type: "not", node: relative("past") })).toEqual(["empty", "today", "undated"]);
  });

  it("rejects invalid presets and non-date properties with a 400", async () => {
    await expect(cp.listItems(databaseId, { filter: relative("yesterday") })).rejects.toBeInstanceOf(ValidationError);
    await expect(cp.listItems(databaseId, { filter: relative({ fromDays: 3, toDays: 2 }) })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      cp.listItems(databaseId, { filter: { type: "date_relative", property: "title", preset: "today" } }),
    ).rejects.toMatchObject({ status: 400, details: { field: "title" } });
  });
});
