import "../../domainWriteHooks.js";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { materializeEventOccurrence } from "../materializeEventOccurrence.js";

const USER = { writerKind: "user" } as const;
const WEEKDAYS = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] };
/** Saturday 17 October 2026, noon in Prague: the next weekday occurrence of a Standup is Monday 19 October. */
const SATURDAY = new Date("2026-10-17T10:00:00Z");

let pool: Pool;

describe("the series' nextOccurrenceDate follows its occurrence items (issue gh-1905)", () => {
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

  const createStandup = () => createEvent({ name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });

  /** The occurrence item of `occurrenceDate`, created as the materialization route creates it. */
  const occurrence = async (seriesId: string, occurrenceDate: string) =>
    (
      await withTransaction(pool, (client) =>
        materializeEventOccurrence(client, { seriesId, occurrenceDate, options: {} }),
      )
    ).item;

  const trash = (itemId: string) => cp.softDeleteItem(eventsId, itemId, undefined, USER);
  const restore = (itemId: string) => cp.restoreItem(eventsId, itemId, undefined, USER);

  const row = async (itemId: string) => {
    const item = await cp.getItem(eventsId, itemId);
    if (!item) throw new Error(`Missing Event ${itemId}`);
    return item;
  };
  const value = async (itemId: string) => (await row(itemId)).properties.nextOccurrenceDate;

  it("moves the series on to the next day when the occurrence it was on is cancelled", async () => {
    const series = await createStandup();
    const monday = await occurrence(series.id, "2026-10-19");
    expect(await value(series.id)).toBe("2026-10-19");

    await trash(monday.id);

    expect(await value(series.id)).toBe("2026-10-20");
  });

  it("brings the series back to the day of an occurrence that is restored", async () => {
    const series = await createStandup();
    const monday = await occurrence(series.id, "2026-10-19");
    await trash(monday.id);
    expect(await value(series.id)).toBe("2026-10-20");

    await restore(monday.id);

    expect(await value(series.id)).toBe("2026-10-19");
  });

  it("follows an occurrence that is moved to an earlier or a later day", async () => {
    const series = await createStandup();
    const monday = await occurrence(series.id, "2026-10-19");

    await patchEvent(monday.id, { date: "2026-10-18" });
    expect(await value(series.id)).toBe("2026-10-18");

    await patchEvent(monday.id, { date: "2026-10-23" });
    // Monday's rule date is taken by the moved item, so the next entry is Tuesday's virtual occurrence.
    expect(await value(series.id)).toBe("2026-10-20");
  });

  it("follows an occurrence whose end day alone changes", async () => {
    const series = await createStandup();
    const monday = await occurrence(series.id, "2026-10-19");
    await patchEvent(monday.id, { date: "2026-10-23" });
    expect(await value(series.id)).toBe("2026-10-20");

    await patchEvent(monday.id, { date: "2026-10-18", endDate: "2026-10-19" });

    expect(await value(series.id)).toBe("2026-10-18");
  });

  it("writes nothing to the series when the occurrence is not the one it is on", async () => {
    const series = await createStandup();
    const wednesday = await occurrence(series.id, "2026-10-21");
    const before = await row(series.id);

    await trash(wednesday.id);
    await restore(wednesday.id);
    await patchEvent(wednesday.id, { date: "2026-10-22" });

    expect(await row(series.id)).toEqual(before);
  });

  it("writes nothing to the series when an update of the occurrence names neither of its days", async () => {
    const series = await createStandup();
    const monday = await occurrence(series.id, "2026-10-19");
    const before = await row(series.id);

    await patchEvent(monday.id, { name: "Standup, moved online" });

    expect(await row(series.id)).toEqual(before);
  });

  it("leaves a series in the Trash as it is when one of its occurrences changes", async () => {
    const series = await createStandup();
    const monday = await occurrence(series.id, "2026-10-19");
    await trash(series.id);
    const before = await row(series.id);

    await trash(monday.id);

    expect(await row(series.id)).toEqual(before);
  });

  it("leaves an Event that is not an occurrence alone when it is trashed and restored", async () => {
    const dentist = await createEvent({ name: "Dentist", date: "2026-10-12" });
    const before = await row(dentist.id);

    await trash(dentist.id);
    await restore(dentist.id);

    expect(await value(dentist.id)).toBe("2026-10-12");
    expect((await row(dentist.id)).properties).toEqual(before.properties);
  });

  it("gives a series that is restored from the Trash the day of today's next occurrence", async () => {
    const series = await createStandup();
    expect(await value(series.id)).toBe("2026-10-19");
    await trash(series.id);
    vi.setSystemTime(new Date("2026-10-20T10:00:00Z"));
    // The daily refresh reads live Events only, so the value the series was trashed with is still Monday's.
    expect(await value(series.id)).toBe("2026-10-19");

    await restore(series.id);

    expect(await value(series.id)).toBe("2026-10-20");
  });
});
