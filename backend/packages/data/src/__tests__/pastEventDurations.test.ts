import "../domainWriteHooks.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { readPastEventDurations } from "../inbox/pastEventDurations.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;

interface Fixture {
  tenantId: string;
  peopleDatabaseId: string;
  eventsDatabaseId: string;
  participantsPropertyId: string;
}

/** One seeded tenant: every write below goes through the choke point on the runtime role pool. */
async function seedTenant(): Promise<Fixture> {
  const tenantId = await createTestTenant(admin);
  return runInTenant(tenantId, async () => {
    await seedSystem(runtime);
    const ids = await runtime.query<{ id: string; owner_module_id: string }>(
      "SELECT id, owner_module_id FROM databases WHERE owner_module_id = ANY($1::text[])",
      [["people", "events"]],
    );
    const idOf = (moduleId: string) => {
      const row = ids.rows.find((entry) => entry.owner_module_id === moduleId);
      if (!row) throw new Error(`Missing ${moduleId}`);
      return row.id;
    };
    const eventsDatabaseId = idOf("events");
    const property = await runtime.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'people'",
      [eventsDatabaseId],
    );
    if (!property.rows[0]) throw new Error("Missing Events.people");
    return {
      tenantId,
      peopleDatabaseId: idOf("people"),
      eventsDatabaseId,
      participantsPropertyId: property.rows[0].id,
    };
  });
}

const writer = () => createChokePoint(runtime);

async function createPerson(fixture: Fixture, name: string): Promise<string> {
  return runInTenant(
    fixture.tenantId,
    async () => (await writer().createItem({ databaseId: fixture.peopleDatabaseId, properties: { name } })).id,
  );
}

/** An Event with the given properties, linked to each of `personIds` through `Events.people`. */
async function createEvent(
  fixture: Fixture,
  personIds: string[],
  properties: Record<string, unknown>,
): Promise<string> {
  return runInTenant(fixture.tenantId, async () => {
    const event = await writer().createItem({
      databaseId: fixture.eventsDatabaseId,
      properties: { name: "Meeting", ...properties },
    });
    for (const personId of personIds) {
      await writer().createRelation({
        relationPropertyId: fixture.participantsPropertyId,
        callerItemId: event.id,
        targetItemId: personId,
      });
    }
    return event.id;
  });
}

const read = (fixture: Fixture, personIds: string[]) =>
  runInTenant(fixture.tenantId, () => withTransaction(runtime, (client) => readPastEventDurations(client, personIds)));

describe("readPastEventDurations (issue gh-1993)", () => {
  beforeEach(async () => {
    admin ??= getTestPool();
    runtime ??= await createRuntimeRolePool(admin, "semprec_data");
    await resetDatabase(admin);
  });
  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it("computes the length in minutes from timeFrom and timeTo and reports the day, newest first", async () => {
    const fixture = await seedTenant();
    const petr = await createPerson(fixture, "Petr");
    const older = await createEvent(fixture, [petr], { date: "2026-08-10", timeFrom: "09:00", timeTo: "09:45" });
    const newer = await createEvent(fixture, [petr], { date: "2026-08-20", timeFrom: "14:00", timeTo: "15:30" });
    const newest = await createEvent(fixture, [petr], { date: "2026-08-25", timeFrom: "08:15", timeTo: "08:30" });

    expect(await read(fixture, [petr])).toEqual({
      [petr]: [
        { eventId: newest, minutes: 15, startDate: "2026-08-25" },
        { eventId: newer, minutes: 90, startDate: "2026-08-20" },
        { eventId: older, minutes: 45, startDate: "2026-08-10" },
      ],
    });
  });

  it("counts an Event that ends at 24:00", async () => {
    const fixture = await seedTenant();
    const petr = await createPerson(fixture, "Petr");
    const late = await createEvent(fixture, [petr], { date: "2026-08-10", timeFrom: "23:00", timeTo: "24:00" });

    expect(await read(fixture, [petr])).toEqual({ [petr]: [{ eventId: late, minutes: 60, startDate: "2026-08-10" }] });
  });

  it("orders Events of one day by their start, the later start first", async () => {
    const fixture = await seedTenant();
    const petr = await createPerson(fixture, "Petr");
    const morning = await createEvent(fixture, [petr], { date: "2026-08-10", timeFrom: "08:00", timeTo: "08:20" });
    const evening = await createEvent(fixture, [petr], { date: "2026-08-10", timeFrom: "18:00", timeTo: "19:00" });

    const events = (await read(fixture, [petr]))[petr];

    expect(events?.map((event) => event.eventId)).toEqual([evening, morning]);
  });

  it("skips an Event with an endDate, one without timeTo, one without times and one in the Trash", async () => {
    const fixture = await seedTenant();
    const petr = await createPerson(fixture, "Petr");
    const counted = await createEvent(fixture, [petr], { date: "2026-08-10", timeFrom: "09:00", timeTo: "10:00" });
    await createEvent(fixture, [petr], {
      date: "2026-08-11",
      endDate: "2026-08-12",
      timeFrom: "09:00",
      timeTo: "10:00",
    });
    // A write that names timeFrom only gets a timeTo one hour later, so the missing end is set directly.
    const withoutEnd = await createEvent(fixture, [petr], { date: "2026-08-13", timeFrom: "09:00" });
    await admin.query("UPDATE items SET properties = properties - 'timeTo' WHERE id = $1", [withoutEnd]);
    await createEvent(fixture, [petr], { date: "2026-08-14" });
    const trashed = await createEvent(fixture, [petr], { date: "2026-08-15", timeFrom: "09:00", timeTo: "10:00" });
    await runInTenant(fixture.tenantId, () => writer().softDeleteItem(fixture.eventsDatabaseId, trashed));

    expect(await read(fixture, [petr])).toEqual({
      [petr]: [{ eventId: counted, minutes: 60, startDate: "2026-08-10" }],
    });
  });

  it("skips an Event whose length is zero or negative or whose times are unreadable", async () => {
    const fixture = await seedTenant();
    const petr = await createPerson(fixture, "Petr");
    const counted = await createEvent(fixture, [petr], { date: "2026-08-10", timeFrom: "09:00", timeTo: "10:00" });
    const zero = await createEvent(fixture, [petr], { date: "2026-08-11", timeFrom: "09:00", timeTo: "10:00" });
    const negative = await createEvent(fixture, [petr], { date: "2026-08-12", timeFrom: "09:00", timeTo: "10:00" });
    const unreadable = await createEvent(fixture, [petr], { date: "2026-08-13", timeFrom: "09:00", timeTo: "10:00" });
    const wrongType = await createEvent(fixture, [petr], { date: "2026-08-14", timeFrom: "09:00", timeTo: "10:00" });
    // The Events validation refuses these states on every write, so the stored values are set directly.
    for (const [id, patch] of [
      [zero, { timeTo: "09:00" }],
      [negative, { timeTo: "08:00" }],
      [unreadable, { timeTo: "9:5" }],
      [wrongType, { timeTo: 1000 }],
    ] as const) {
      await admin.query("UPDATE items SET properties = properties || $2::jsonb WHERE id = $1", [
        id,
        JSON.stringify(patch),
      ]);
    }

    expect(await read(fixture, [petr])).toEqual({
      [petr]: [{ eventId: counted, minutes: 60, startDate: "2026-08-10" }],
    });
  });

  it("lists at most five Events per person, the newest five", async () => {
    const fixture = await seedTenant();
    const petr = await createPerson(fixture, "Petr");
    const ids: string[] = [];
    for (let day = 1; day <= 7; day++) {
      ids.push(
        await createEvent(fixture, [petr], {
          date: `2026-08-${String(day).padStart(2, "0")}`,
          timeFrom: "09:00",
          timeTo: "10:00",
        }),
      );
    }

    const events = (await read(fixture, [petr]))[petr];

    expect(events?.map((event) => event.eventId)).toEqual([ids[6], ids[5], ids[4], ids[3], ids[2]]);
  });

  it("answers every person with one query, lists a shared Event for each and leaves out a person without one", async () => {
    const fixture = await seedTenant();
    const petr = await createPerson(fixture, "Petr");
    const eva = await createPerson(fixture, "Eva");
    const alone = await createPerson(fixture, "Alone");
    const shared = await createEvent(fixture, [petr, eva], { date: "2026-08-10", timeFrom: "09:00", timeTo: "09:30" });
    const evasOnly = await createEvent(fixture, [eva], { date: "2026-08-11", timeFrom: "10:00", timeTo: "11:00" });
    let queries = 0;
    const counted = (client: PoolClient): PoolClient =>
      new Proxy(client, {
        get(target, property, receiver) {
          if (property === "query") {
            return (...args: unknown[]) => {
              queries++;
              return Reflect.apply(target.query.bind(target), undefined, args);
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

    const result = await runInTenant(fixture.tenantId, () =>
      withTransaction(runtime, async (client) => {
        queries = 0;
        return readPastEventDurations(counted(client), [petr, eva, alone]);
      }),
    );

    expect(queries).toBe(1);
    expect(result).toEqual({
      [petr]: [{ eventId: shared, minutes: 30, startDate: "2026-08-10" }],
      [eva]: [
        { eventId: evasOnly, minutes: 60, startDate: "2026-08-11" },
        { eventId: shared, minutes: 30, startDate: "2026-08-10" },
      ],
    });
  });

  it("reads nothing for an empty list of people", async () => {
    const fixture = await seedTenant();
    let queries = 0;
    const result = await runInTenant(fixture.tenantId, () =>
      withTransaction(runtime, async (client) => {
        const counted = new Proxy(client, {
          get(target, property, receiver) {
            if (property === "query") {
              return () => {
                queries++;
                return Promise.resolve();
              };
            }
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return readPastEventDurations(counted, []);
      }),
    );

    expect(result).toEqual({});
    expect(queries).toBe(0);
  });

  it("ignores an Event of a person who was not asked for", async () => {
    const fixture = await seedTenant();
    const petr = await createPerson(fixture, "Petr");
    const eva = await createPerson(fixture, "Eva");
    await createEvent(fixture, [eva], { date: "2026-08-10", timeFrom: "09:00", timeTo: "10:00" });

    expect(await read(fixture, [petr])).toEqual({});
  });

  it("reads only the caller's tenant: the Events of another tenant's person are not returned", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const mine = await createPerson(a, "Petr");
    const theirs = await createPerson(b, "Petr");
    const myEvent = await createEvent(a, [mine], { date: "2026-08-10", timeFrom: "09:00", timeTo: "10:00" });
    await createEvent(b, [theirs], { date: "2026-08-10", timeFrom: "09:00", timeTo: "12:00" });

    expect(await read(a, [mine, theirs])).toEqual({
      [mine]: [{ eventId: myEvent, minutes: 60, startDate: "2026-08-10" }],
    });
  });
});
