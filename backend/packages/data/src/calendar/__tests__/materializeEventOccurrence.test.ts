import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import type { WriterIdentity } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { ChokePointError } from "../../errors.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { setSelfPersonId } from "../../selfPerson.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createEventInCalendar } from "../defaultCalendarCreateHook.js";
import { createMaterializeEventOccurrenceRouteHandler } from "../eventOccurrenceRouteHandlers.js";
import { materializeEventOccurrence } from "../materializeEventOccurrence.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let userId: string;

const USER: WriterIdentity = { writerKind: "user" };

const WEEKDAYS = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] };

/** A Standup that repeats Monday to Friday from Monday 12 October 2026, 9:00-9:30. */
const STANDUP = {
  name: "Standup",
  type: "standup",
  date: "2026-10-12",
  timeFrom: "09:00",
  timeTo: "09:30",
  place: "Room 1",
  description: "Daily sync",
  recurrence: WEEKDAYS,
};

const calendarRow = z.object({ id: z.string(), properties: z.object({ name: z.string() }).passthrough() });

/** A tenant with one English-speaking user, so its seeded calendars are named `Personal`, `Work` and so on. */
async function seededTenant(): Promise<{ tenantId: string; userId: string }> {
  const tenantId = await createTestTenant(admin);
  const user = await createUser(admin, {
    tenantId,
    email: `${randomUUID()}@example.com`,
    passwordHash: "unused",
    locale: "en",
  });
  await runInTenant(tenantId, () => seedSystem(runtime));
  return { tenantId, userId: user.id };
}

/** Resolves once a backend of this database waits for an advisory lock, read through `pg_stat_activity`. */
async function waitForAdvisoryLockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const { rows } = await admin.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("No request waited for an advisory lock");
}

describe("materialize an event occurrence (issue gh-1843)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    const seeded = await seededTenant();
    tenant = seeded.tenantId;
    userId = seeded.userId;
    foreign = (await seededTenant()).tenantId;
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  /** The ids and writes of the tenant in scope; every write of a test goes through the choke point. */
  async function setup() {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const row = databases.find((d) => d.ownerModuleId === key);
      if (!row) throw new Error(`Missing ${key}`);
      return row.id;
    };
    const property = async (databaseKey: string, key: string) => {
      const found = (await cp.listProperties(db(databaseKey))).find((p) => p.key === key);
      if (!found) throw new Error(`Missing ${databaseKey}.${key}`);
      return found;
    };
    const calendars = z.array(calendarRow).parse((await cp.listItems(db(CALENDARS_MODULE_ID), { limit: 50 })).items);
    const calendar = (name: string) => {
      const row = calendars.find((candidate) => candidate.properties.name === name);
      if (!row) throw new Error(`Missing calendar ${name}`);
      return row.id;
    };
    const create = async (databaseKey: string, properties: Record<string, unknown>) =>
      (await cp.createItem({ databaseId: db(databaseKey), properties }, userId, userId, USER)).id;
    const link = async (databaseKey: string, key: string, itemId: string, targetId: string, metadata?: object) =>
      cp.createRelation(
        {
          relationPropertyId: (await property(databaseKey, key)).id,
          callerItemId: itemId,
          targetItemId: targetId,
          metadata: metadata === undefined ? undefined : { ...metadata },
        },
        USER,
      );
    /** An Event in the calendar named `calendarName`, the way a create in a chosen calendar makes one. */
    const eventIn = (calendarName: string, properties: Record<string, unknown>) =>
      withTransaction(runtime, (client) =>
        createEventInCalendar(client, { properties }, calendar(calendarName), { writer: USER }),
      ).then((item) => item.id);
    const edgeMetadata = async (itemId: string, key: string) =>
      ((await cp.listItemRelations(itemId)) ?? []).filter((entry) => entry.propertyKey === key);
    const edgesOf = async (itemId: string) =>
      ((await cp.listItemRelations(itemId)) ?? []).map((entry) => `${entry.propertyKey}:${entry.targetItemId}`).sort();
    const idsIn = async (databaseKey: string) =>
      (await cp.listItems(db(databaseKey), { limit: 100 })).items.map((item) => item.id).sort();
    const read = async (databaseKey: string, itemId: string) => cp.getItem(db(databaseKey), itemId);
    return { cp, db, property, calendar, create, link, eventIn, edgeMetadata, edgesOf, idsIn, read };
  }

  const materialize = (seriesId: string, date: string, identityId: string = userId) =>
    createMaterializeEventOccurrenceRouteHandler(runtime)({
      params: { seriesId, date },
      identity: { user: { id: identityId } },
    });

  const refusal = (seriesId: string, date: string) => materialize(seriesId, date).catch((error: unknown) => error);

  it("creates one item for the 14 October occurrence of a weekday Standup, with the series' details, and answers 201", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.eventIn("Work", STANDUP);
      const project = await f.create("projects", { name: "Platform" });
      const [ann, bob] = [await f.create("people", { name: "Ann" }), await f.create("people", { name: "Bob" })];
      await withTransaction(runtime, (client) => setSelfPersonId(client, ann));
      await f.link("events", "project", series, project);
      await f.link("events", "people", series, ann, { role: "organizer" });
      await f.link("events", "people", series, bob);
      const before = await f.idsIn("events");

      const result = await materialize(series, "2026-10-14");

      expect(result.status).toBe(201);
      expect(result.item.properties).toMatchObject({
        name: "Standup",
        type: "standup",
        date: "2026-10-14",
        timeFrom: "09:00",
        timeTo: "09:30",
        place: "Room 1",
        description: "Daily sync",
        seriesId: series,
        occurrenceDate: "2026-10-14",
      });
      // No rule of its own, and an iCalendar identity of its own.
      expect(result.item.properties).not.toHaveProperty("recurrence");
      expect(result.item.properties.icalUid).not.toBe((await f.read("events", series))?.properties.icalUid);
      expect(result.item.deletedAt).toBeNull();
      // The series' calendar, project and people (with the organizer role), and nothing else.
      expect(await f.edgesOf(result.item.id)).toEqual(
        [`calendar:${f.calendar("Work")}`, `project:${project}`, `people:${ann}`, `people:${bob}`].sort(),
      );
      expect(
        (await f.edgeMetadata(result.item.id, "people")).map((entry) => [entry.targetItemId, entry.metadata]).sort(),
      ).toEqual(
        [
          [ann, { role: "organizer" }],
          [bob, {}],
        ].sort(),
      );
      // Further occurrences stay virtual: the only new item is this one, and the series is as it was.
      expect(await f.idsIn("events")).toEqual([...before, result.item.id].sort());
      expect((await f.read("events", series))?.properties).toMatchObject({ date: "2026-10-12", recurrence: WEEKDAYS });
    }));

  it("keeps the length of a two-day series: the occurrence's endDate moves with its date", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.eventIn("Work", {
        name: "Offsite",
        date: "2026-10-12",
        endDate: "2026-10-13",
        recurrence: WEEKDAYS,
      });

      const result = await materialize(series, "2026-10-14");

      expect(result.item.properties).toMatchObject({ date: "2026-10-14", endDate: "2026-10-15" });
      expect(result.item.properties).not.toHaveProperty("timeFrom");
    }));

  it("gives an occurrence of a series without a calendar edge the default calendar", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.eventIn("Work", STANDUP);
      await f.cp.deleteRelation({
        relationPropertyId: (await f.property("events", "calendar")).id,
        callerItemId: series,
        targetItemId: f.calendar("Work"),
      });
      expect(await f.edgeMetadata(series, "calendar")).toEqual([]);

      const result = await materialize(series, "2026-10-14");

      expect((await f.edgeMetadata(result.item.id, "calendar")).map((entry) => entry.targetItemId)).toEqual([
        f.calendar("Personal"),
      ]);
    }));

  it("links the participants of the occurrence without their invitations", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.eventIn("Work", STANDUP);
      const invited = await f.create("people", { name: "Invited" });
      // The invitation is written the way the invitation code writes it, with the system writer.
      await f.cp.createRelation({
        relationPropertyId: (await f.property("events", "people")).id,
        callerItemId: series,
        targetItemId: invited,
        metadata: { invitation: { status: "accepted", email: "invited@example.com", mailboxId: randomUUID() } },
      });
      expect((await f.edgeMetadata(series, "people"))[0]?.metadata).toHaveProperty("invitation");

      const result = await materialize(series, "2026-10-14");

      expect(
        (await f.edgeMetadata(result.item.id, "people")).map((entry) => [entry.targetItemId, entry.metadata]),
      ).toEqual([[invited, {}]]);
    }));

  it("answers a second call with 200 and the same item, and creates nothing", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.eventIn("Work", STANDUP);
      const first = await materialize(series, "2026-10-14");
      const afterFirst = await f.idsIn("events");

      const second = await materialize(series, "2026-10-14");

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.item).toEqual(first.item);
      expect(await f.idsIn("events")).toEqual(afterFirst);
    }));

  it("finds the stored item for a series id spelled in upper case, and stores the lower case spelling", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.eventIn("Work", STANDUP);

      const first = await materialize(series.toUpperCase(), "2026-10-14");
      const second = await materialize(series, "2026-10-14");

      expect(first.status).toBe(201);
      expect(first.item.properties.seriesId).toBe(series);
      expect(second.status).toBe(200);
      expect(second.item.id).toBe(first.item.id);
    }));

  it("creates one item for two concurrent calls", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.eventIn("Work", STANDUP);
      const before = await f.idsIn("events");

      const [one, two] = await Promise.all([materialize(series, "2026-10-14"), materialize(series, "2026-10-14")]);

      expect([one.status, two.status].sort()).toEqual([200, 201]);
      expect(two.item.id).toBe(one.item.id);
      expect((await f.idsIn("events")).length).toBe(before.length + 1);
    }));

  it("makes a call that waits for the occurrence's lock return the item the first call created", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.eventIn("Work", STANDUP);
      const before = await f.idsIn("events");

      // The first call has created its item and holds its transaction open. The second one waits for the advisory
      // lock of the occurrence and, once it has it, finds that item.
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let created: () => void = () => {};
      const itemCreated = new Promise<void>((resolve) => {
        created = resolve;
      });
      const firstCall = withTransaction(runtime, async (client) => {
        const result = await materializeEventOccurrence(client, {
          seriesId: series,
          occurrenceDate: "2026-10-14",
          options: { writer: USER, actingUserId: userId },
        });
        created();
        await released;
        return result;
      });
      await Promise.race([itemCreated, firstCall]);
      const secondCall = materialize(series, "2026-10-14");
      await waitForAdvisoryLockWaiter();
      release();
      const [first, second] = [await firstCall, await secondCall];

      expect(first.created).toBe(true);
      expect(second.status).toBe(200);
      expect(second.item.id).toBe(first.item.id);
      expect((await f.idsIn("events")).length).toBe(before.length + 1);
    }));

  it("writes as the system writer when the caller names no writer", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.eventIn("Work", STANDUP);
      const ann = await f.create("people", { name: "Ann" });
      await f.link("events", "people", series, ann);

      const result = await withTransaction(runtime, (client) =>
        materializeEventOccurrence(client, { seriesId: series, occurrenceDate: "2026-10-14", options: {} }),
      );

      expect(result.created).toBe(true);
      expect(result.item.properties.occurrenceDate).toBe("2026-10-14");
      expect(await f.edgesOf(result.item.id)).toContain(`people:${ann}`);
    }));

  it("moves only the materialized occurrence when it is patched, and refuses a patch of its series identity", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.eventIn("Work", STANDUP);
      const seriesBefore = await f.read("events", series);
      const { item } = await materialize(series, "2026-10-14");

      const moved = await f.cp.updateItem(
        {
          databaseId: f.db("events"),
          itemId: item.id,
          propertiesPatch: { timeFrom: "09:15", timeTo: "09:45" },
          ifVersion: item.updatedAt,
        },
        userId,
        userId,
        USER,
      );

      expect(moved.properties).toMatchObject({
        timeFrom: "09:15",
        timeTo: "09:45",
        date: "2026-10-14",
        seriesId: series,
        occurrenceDate: "2026-10-14",
      });
      expect(await f.read("events", series)).toEqual(seriesBefore);
      // A call for the moved occurrence returns it as it is stored, and a call for another date creates a fresh copy
      // of the series with the series' time.
      expect((await materialize(series, "2026-10-14")).item.properties.timeFrom).toBe("09:15");
      expect((await materialize(series, "2026-10-15")).item.properties.timeFrom).toBe("09:00");
      for (const key of ["seriesId", "occurrenceDate"]) {
        const refused = await f.cp
          .updateItem(
            { databaseId: f.db("events"), itemId: item.id, propertiesPatch: { [key]: "2026-10-15" } },
            userId,
            userId,
            USER,
          )
          .catch((error: unknown) => error);
        expect(refused, key).toBeInstanceOf(ChokePointError);
        expect(refused, key).toMatchObject({ status: 403, code: "owner_violation", details: { field: key } });
      }
    }));

  it("returns a trashed occurrence item as it is stored, does not recreate it and returns it live once restored", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.eventIn("Work", STANDUP);
      const { item } = await materialize(series, "2026-10-14");
      await f.cp.softDeleteItem(f.db("events"), item.id);
      const afterCancel = await f.idsIn("events");

      const again = await materialize(series, "2026-10-14");

      expect(again.status).toBe(200);
      expect(again.item.id).toBe(item.id);
      expect(again.item.deletedAt).not.toBeNull();
      expect(await f.idsIn("events")).toEqual(afterCancel);
      const stored = await admin.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM items WHERE properties->>'seriesId' = $1 AND properties->>'occurrenceDate' = '2026-10-14'",
        [series],
      );
      expect(stored.rows[0]?.count).toBe(1);

      await f.cp.restoreItem(f.db("events"), item.id, userId, USER);
      const restored = await materialize(series, "2026-10-14");
      expect(restored.status).toBe(200);
      expect(restored.item.id).toBe(item.id);
      expect(restored.item.deletedAt).toBeNull();
    }));

  it("returns the stored occurrence of a series that was trashed afterwards", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.eventIn("Work", STANDUP);
      const { item } = await materialize(series, "2026-10-14");
      await f.cp.softDeleteItem(f.db("events"), series);

      const again = await materialize(series, "2026-10-14");

      expect(again.status).toBe(200);
      expect(again.item.id).toBe(item.id);
    }));

  it.each([
    ["a Saturday the weekday rule does not give", "2026-10-17"],
    ["a day before the series starts", "2026-10-09"],
    ["a Sunday before the series' first Monday", "2026-10-11"],
  ])("refuses %s with 400 on date and creates nothing", (_label, date) =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.eventIn("Work", STANDUP);
      const before = await f.idsIn("events");

      const answer = await refusal(series, date);

      expect(answer).toBeInstanceOf(ChokePointError);
      expect(answer).toMatchObject({ status: 400, code: "validation_failed", details: { field: "date" } });
      expect(await f.idsIn("events")).toEqual(before);
    }),
  );

  it.each([
    ["a date that does not exist", randomUUID(), "2026-02-30", "date"],
    ["a date that is not a date", randomUUID(), "next-monday", "date"],
    ["a series id that is not a UUID", "not-a-uuid", "2026-10-14", "seriesId"],
  ])("refuses %s with 400 on the field and creates nothing", (_label, seriesId, date, field) =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const before = await f.idsIn("events");

      const answer = await refusal(seriesId, date);

      expect(answer).toBeInstanceOf(ChokePointError);
      expect(answer).toMatchObject({ status: 400, code: "validation_failed", details: { field } });
      expect(await f.idsIn("events")).toEqual(before);
    }),
  );

  it("answers 404 in a tenant that has no Events database", async () => {
    const bare = await createTestTenant(admin);
    await runInTenant(bare, async () => {
      const answer = await refusal(randomUUID(), "2026-10-14");
      expect(answer).toBeInstanceOf(ChokePointError);
      expect(answer).toMatchObject({ status: 404, code: "not_found" });
    });
  });

  it("answers an unknown id, a trashed series, another tenant's series, a plain Event, an occurrence item, an unreadable rule, an unreadable date and an item of another database with the same 404", async () => {
    const foreignSeries = await runInTenant(foreign, async () => (await setup()).eventIn("Work", STANDUP));
    await runInTenant(tenant, async () => {
      const f = await setup();
      const trashed = await f.eventIn("Work", STANDUP);
      await f.cp.softDeleteItem(f.db("events"), trashed);
      const plain = await f.eventIn("Work", { name: "One-off", date: "2026-10-14" });
      const series = await f.eventIn("Work", STANDUP);
      const occurrence = (await materialize(series, "2026-10-14")).item;
      // A user may patch a rule onto an occurrence item (the property is user-owned); it still is not a series.
      await f.cp.updateItem(
        { databaseId: f.db("events"), itemId: occurrence.id, propertiesPatch: { recurrence: WEEKDAYS } },
        userId,
        userId,
        USER,
      );
      const unreadable = await f.eventIn("Work", STANDUP);
      // The Events hooks refuse a value that is not a rule, so a stored one is written with SQL, as an old row would be.
      await admin.query(
        `UPDATE items SET properties = properties || '{"recurrence": {"kind": "sometimes"}}' WHERE id = $1`,
        [unreadable],
      );
      const undated = await f.eventIn("Work", STANDUP);
      // The Events hooks refuse a date that is not a date, so a stored one is written with SQL, as an old row would be.
      await admin.query(`UPDATE items SET properties = properties || '{"date": "next monday"}' WHERE id = $1`, [
        undated,
      ]);
      const task = await f.create("tasks", { name: "Not an event", date: "2026-10-14" });
      const before = await f.idsIn("events");

      for (const id of [randomUUID(), trashed, foreignSeries, plain, occurrence.id, unreadable, undated, task]) {
        const answer = await refusal(id, "2026-10-15");
        expect(answer, id).toBeInstanceOf(ChokePointError);
        expect(answer, id).toMatchObject({ status: 404, code: "not_found" });
        // The message names the requested id and nothing else, so a foreign id reads like a random one.
        expect(answer instanceof Error ? answer.message.replace(id, "<id>") : null, id).toBe("Series <id> not found");
      }
      expect(await f.idsIn("events")).toEqual(before);
    });
    // Read through the superuser pool: this asserts that a row is absent, not tenant isolation.
    const { rows } = await admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM items WHERE properties->>'seriesId' = $1",
      [foreignSeries],
    );
    expect(rows[0]?.count).toBe(0);
  });
});
