import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { registerRelationEdgeWriteHook } from "../../chokePoint/hooks.js";
import type { WriterIdentity } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { ChokePointError } from "../../errors.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { setSelfPersonId } from "../../selfPerson.js";
import { createTaskHostEventPutRouteHandler } from "../../tasks/taskHostEventRouteHandlers.js";
import { createTaskRecurrenceSetRouteHandler } from "../../tasks/taskRecurrenceRoutes.js";
import { getTaskRecurrenceBySeriesId } from "../../tasks/taskRecurrenceStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { writePageTextBlocks } from "../../testSupport/pageFixtures.js";
import { createEventInCalendar } from "../defaultCalendarCreateHook.js";
import { duplicateCalendarItem } from "../duplicateCalendarItem.js";
import { createDuplicateCalendarItemRouteHandler } from "../duplicateCalendarItemRouteHandler.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let userId: string;

const USER: WriterIdentity = { writerKind: "user" };
const MAILBOX_ID = randomUUID();

/** The edge target the hook below refuses; `null` while no test wants an edge write to fail. */
let failEdgeWriteTo: string | null = null;
registerRelationEdgeWriteHook(async ({ targetItemId }) => {
  if (failEdgeWriteTo !== null && targetItemId === failEdgeWriteTo) throw new Error("edge write refused on purpose");
});

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

/** Resolves once a backend of this database waits for a transaction to finish, read through `pg_stat_activity`. */
async function waitForTransactionWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const { rows } = await admin.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'transactionid'`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("No write waited for another transaction");
}

describe("duplicate a calendar item (issue gh-1796)", () => {
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
    failEdgeWriteTo = null;
  });

  afterEach(() => {
    failEdgeWriteTo = null;
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
    /** Every live edge of the item as `key:targetId`, sorted. */
    const edgesOf = async (itemId: string) =>
      ((await cp.listItemRelations(itemId)) ?? []).map((entry) => `${entry.propertyKey}:${entry.targetItemId}`).sort();
    const edgeMetadata = async (itemId: string, key: string) =>
      ((await cp.listItemRelations(itemId)) ?? []).filter((entry) => entry.propertyKey === key);
    const idsIn = async (databaseKey: string) =>
      (await cp.listItems(db(databaseKey), { limit: 100 })).items.map((item) => item.id).sort();
    const read = async (databaseKey: string, itemId: string) => cp.getItem(db(databaseKey), itemId);
    return { cp, db, property, calendar, create, link, eventIn, edgesOf, edgeMetadata, idsIn, read };
  }

  const duplicate = (itemId: string, body: unknown, key?: string, identityId: string = userId) =>
    createDuplicateCalendarItemRouteHandler(runtime)({
      req: { headers: key === undefined ? {} : { "idempotency-key": key } },
      params: { id: itemId },
      body,
      identity: { user: { id: identityId } },
    });

  const MEETING = {
    name: "Meeting with client",
    type: "meeting",
    date: "2026-10-16",
    timeFrom: "09:00",
    timeTo: "10:00",
    place: "Office",
    description: "Agenda",
    url: "https://example.com/room",
    alertMinutes: 0,
    travelMinutes: 30,
  };

  it("copies the whitelisted properties and edges of an Event to a new date and time, and none of the excluded ones", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const meeting = await f.eventIn("Work", MEETING);
      const project = await f.create("projects", { name: "Client project" });
      const [ann, bob, cyril] = [
        await f.create("people", { name: "Ann" }),
        await f.create("people", { name: "Bob" }),
        await f.create("people", { name: "Cyril" }),
      ];
      const transcript = await f.create("transcripts", {});
      const actionItemTask = await f.create("tasks", { name: "Follow up", date: "2026-10-17" });
      const hostedTask = await f.create("tasks", { name: "Prepare", date: "2026-10-16" });
      await f.link("events", "project", meeting, project);
      for (const person of [ann, bob, cyril]) await f.link("events", "people", meeting, person);
      await f.link("events", "transcript", meeting, transcript);
      await f.link("events", "actionItems", meeting, actionItemTask);
      await createTaskHostEventPutRouteHandler(runtime)({
        params: { id: hostedTask, eventId: meeting },
        body: {},
        identity: { user: { id: userId } },
      });
      await writePageTextBlocks(runtime, meeting, ["Notes of the meeting"]);

      const result = await duplicate(meeting, { date: "2026-10-19", timeFrom: "10:00", timeTo: "11:30" });

      expect(result.status).toBe(201);
      expect(result.item.id).not.toBe(meeting);
      expect(result.item.properties).toEqual({
        name: "Meeting with client",
        type: "meeting",
        date: "2026-10-19",
        timeFrom: "10:00",
        timeTo: "11:30",
        time: "10:00–11:30",
        place: "Office",
        description: "Agenda",
        url: "https://example.com/room",
        alertMinutes: 0,
        travelMinutes: 30,
        icalUid: expect.any(String),
        icalSequence: expect.any(Number),
        // The copy is not recurring, so its next occurrence is its own day (issue gh-1905).
        nextOccurrenceDate: "2026-10-19",
      });
      expect(result.item.properties.icalUid).not.toBe((await f.read("events", meeting))?.properties.icalUid);
      // Project, three people and the source's own calendar, which the create linked: no transcript, action item or hosted task.
      expect(await f.edgesOf(result.item.id)).toEqual(
        [
          `project:${project}`,
          `people:${ann}`,
          `people:${bob}`,
          `people:${cyril}`,
          `calendar:${f.calendar("Work")}`,
        ].sort(),
      );
      // The source keeps everything it had, and nothing moved from it to the copy.
      expect(await f.edgesOf(meeting)).toEqual(
        [
          `project:${project}`,
          `people:${ann}`,
          `people:${bob}`,
          `people:${cyril}`,
          `calendar:${f.calendar("Work")}`,
          `transcript:${transcript}`,
          `actionItems:${actionItemTask}`,
          `hostedTasks:${hostedTask}`,
        ].sort(),
      );
      // Read through the superuser pool: this asserts that a row is absent, not tenant isolation.
      const pages = await admin.query<{ item_id: string }>(
        `SELECT item_id FROM docs WHERE item_id = ANY($1::uuid[]) ORDER BY item_id`,
        [[meeting, result.item.id]],
      );
      expect(pages.rows).toEqual([{ item_id: meeting }]);
    }));

  it("answers a repeated Idempotency-Key with the copy of the first request and copies nothing again", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const meeting = await f.eventIn("Work", MEETING);
      const ann = await f.create("people", { name: "Ann" });
      await f.link("events", "people", meeting, ann);
      const before = await f.idsIn("events");

      const first = await duplicate(meeting, { date: "2026-10-19", timeFrom: "10:00" }, "copy-1");
      // A copied edge removed after the first request must not come back with the second one: it copies nothing.
      await f.cp.deleteRelation({
        relationPropertyId: (await f.property("events", "people")).id,
        callerItemId: first.item.id,
        targetItemId: ann,
      });
      const second = await duplicate(meeting, { date: "2026-10-20", timeFrom: "11:00" }, "copy-1");

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.item.id).toBe(first.item.id);
      expect(second.item.properties.date).toBe("2026-10-19");
      expect((await f.idsIn("events")).length).toBe(before.length + 1);
      expect(await f.edgeMetadata(first.item.id, "people")).toEqual([]);
    }));

  it("creates a new copy for a key whose earlier copy is in the Trash", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const meeting = await f.eventIn("Work", MEETING);
      const first = await duplicate(meeting, { date: "2026-10-19" }, "copy-trashed");
      await f.cp.softDeleteItem(f.db("events"), first.item.id);

      const second = await duplicate(meeting, { date: "2026-10-20" }, "copy-trashed");

      expect(second.item.id).not.toBe(first.item.id);
      expect(second.item.properties.date).toBe("2026-10-20");
    }));

  it.each([
    ["the same source", true],
    ["another source", false],
  ])("copies nothing again for a request with the same key that waits for a first one, on %s", (_label, sameSource) =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const firstSource = await f.eventIn("Work", { ...MEETING, name: "First source" });
      const secondSource = await f.eventIn("Work", { ...MEETING, name: "Second source" });
      const [ann, bob] = [await f.create("people", { name: "Ann" }), await f.create("people", { name: "Bob" })];
      await f.link("events", "people", firstSource, ann);
      await f.link("events", "people", secondSource, bob);
      const before = await f.idsIn("events");

      // The first request has inserted its copy and holds its transaction open. A second request for the same
      // source waits for the source's row lock; one for another source waits at the insert that meets the key.
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let inserted: () => void = () => {};
      const copyInserted = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      const firstRequest = withTransaction(runtime, async (client) => {
        const copy = await duplicateCalendarItem(client, {
          itemId: firstSource,
          date: "2026-10-19",
          idempotencyKey: "copy-race",
          actor: { userId },
        });
        inserted();
        await released;
        return copy;
      });
      await Promise.race([copyInserted, firstRequest]);
      const secondRequest = duplicate(sameSource ? firstSource : secondSource, { date: "2026-10-20" }, "copy-race");
      await waitForTransactionWaiter();
      release();
      const [firstCopy, secondCopy] = [await firstRequest, await secondRequest];

      expect(secondCopy.item.id).toBe(firstCopy.id);
      expect(secondCopy.item.properties.name).toBe("First source");
      expect((await f.idsIn("events")).length).toBe(before.length + 1);
      expect((await f.edgeMetadata(firstCopy.id, "people")).map((entry) => entry.targetItemId)).toEqual([ann]);
    }),
  );

  it("refuses a timeTo of 24:15 with 400 on timeTo and creates nothing", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const meeting = await f.eventIn("Work", MEETING);
      const before = await f.idsIn("events");

      const refused = await duplicate(
        meeting,
        { date: "2026-10-19", timeFrom: "10:00", timeTo: "24:15" },
        "bad-times",
      ).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(ChokePointError);
      expect(refused).toMatchObject({ status: 400, code: "validation_failed", details: { field: "timeTo" } });
      expect(await f.idsIn("events")).toEqual(before);
      // The key was not kept by the refused request: the same key still creates a copy with valid times.
      const retried = await duplicate(meeting, { date: "2026-10-19", timeFrom: "10:00", timeTo: "11:00" }, "bad-times");
      expect(retried.item.properties.timeTo).toBe("11:00");
      expect((await f.idsIn("events")).length).toBe(before.length + 1);
    }));

  it("moves a two-day all-day Event with its date: 31 Oct to 1 Nov, with no time", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const trip = await f.eventIn("Work", { name: "Trip", date: "2026-10-29", endDate: "2026-10-30" });

      const result = await duplicate(trip, { date: "2026-10-31" });

      expect(result.item.properties).toMatchObject({ date: "2026-10-31", endDate: "2026-11-01" });
      expect(result.item.properties.timeFrom).toBeUndefined();
      expect(result.item.properties.timeTo).toBeUndefined();
      expect(result.item.properties.time ?? null).toBeNull();
    }));

  it("takes the endDate of the request over the shifted one, and none when the source has no endDate", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const trip = await f.eventIn("Work", { name: "Trip", date: "2026-10-29", endDate: "2026-10-30" });
      const single = await f.eventIn("Work", { name: "Single day", date: "2026-10-29" });

      const explicit = await duplicate(trip, { date: "2026-10-31", endDate: "2026-11-05" });
      const none = await duplicate(single, { date: "2026-10-31" });

      expect(explicit.item.properties.endDate).toBe("2026-11-05");
      expect(none.item.properties.endDate).toBeUndefined();
    }));

  it("gives a copy no endDate when the source stores a date that is not a calendar date", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const trip = await f.eventIn("Work", { name: "Legacy trip", date: "2026-10-29", endDate: "2026-10-30" });
      // The Events rules refuse a date with a time, so a row stored before them is made with raw SQL, as the migrations did.
      await admin.query(
        `UPDATE items SET properties = jsonb_set(properties, '{date}', '"2026-10-29T08:00:00Z"') WHERE id = $1`,
        [trip],
      );

      const result = await duplicate(trip, { date: "2026-10-31" });

      expect(result.item.properties.date).toBe("2026-10-31");
      expect(result.item.properties.endDate).toBeUndefined();
    }));

  it("keeps the source's calendar, and the default calendar for a source that has no calendar edge", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const inWork = await f.eventIn("Work", MEETING);
      const unlinked = await f.eventIn("Work", { ...MEETING, name: "Unlinked" });
      await f.cp.deleteRelation({
        relationPropertyId: (await f.property("events", "calendar")).id,
        callerItemId: unlinked,
        targetItemId: f.calendar("Work"),
      });
      expect(await f.edgeMetadata(unlinked, "calendar")).toEqual([]);

      const fromWork = await duplicate(inWork, { date: "2026-10-19" });
      const fromUnlinked = await duplicate(unlinked, { date: "2026-10-19" });

      expect((await f.edgeMetadata(fromWork.item.id, "calendar")).map((entry) => entry.targetItemId)).toEqual([
        f.calendar("Work"),
      ]);
      expect((await f.edgeMetadata(fromUnlinked.item.id, "calendar")).map((entry) => entry.targetItemId)).toEqual([
        f.calendar("Personal"),
      ]);
    }));

  it("copies the company edges of an Event that has no project, and not those of an Event that has one", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const company = await f.create("companies", { name: "Acme" });
      const project = await f.create("projects", { name: "Acme project" });
      const withoutProject = await f.eventIn("Work", { ...MEETING, name: "No project" });
      const withProject = await f.eventIn("Work", { ...MEETING, name: "With project" });
      await f.link("events", "company", withoutProject, company);
      await f.link("events", "company", withProject, company);
      await f.link("events", "project", withProject, project);

      const copyWithout = await duplicate(withoutProject, { date: "2026-10-19" });
      const copyWith = await duplicate(withProject, { date: "2026-10-19" });

      expect((await f.edgeMetadata(copyWithout.item.id, "company")).map((entry) => entry.targetItemId)).toEqual([
        company,
      ]);
      expect(await f.edgeMetadata(copyWith.item.id, "company")).toEqual([]);
      expect((await f.edgeMetadata(copyWith.item.id, "project")).map((entry) => entry.targetItemId)).toEqual([project]);
    }));

  it("skips a relation the database does not have and an edge to a person in the Trash", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      // A tenant whose Events and Tasks databases lack the whitelisted `area` and `files` relations, as an install
      // before their cutover migrations is. The schema lock refuses the API, so it is lifted with raw SQL first.
      // Deleting a relation property also deletes its inverse, on the Areas and Files databases.
      await admin.query(`UPDATE databases SET schema_locked = false WHERE system`);
      await f.cp.deleteProperty((await f.property("events", "area")).id);
      await f.cp.deleteProperty((await f.property("events", "files")).id);
      await f.cp.deleteProperty((await f.property("tasks", "files")).id);
      const meeting = await f.eventIn("Work", MEETING);
      const task = await f.create("tasks", { name: "Plain", date: "2026-10-16" });
      const [live, gone] = [await f.create("people", { name: "Live" }), await f.create("people", { name: "Gone" })];
      await f.link("events", "people", meeting, live);
      await f.link("events", "people", meeting, gone);
      await f.link("tasks", "people", task, live);
      await f.cp.softDeleteItem(f.db("people"), gone);

      const eventCopy = await duplicate(meeting, { date: "2026-10-19" });
      const taskCopy = await duplicate(task, { date: "2026-10-19" });

      expect((await f.edgeMetadata(eventCopy.item.id, "people")).map((entry) => entry.targetItemId)).toEqual([live]);
      expect((await f.edgeMetadata(taskCopy.item.id, "people")).map((entry) => entry.targetItemId)).toEqual([live]);
    }));

  it("copies the area and file edges of an Event", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const meeting = await f.eventIn("Work", MEETING);
      const area = await f.create("areas", { name: "Clients" });
      const file = await f.create("files", { name: "agenda.pdf" });
      await f.link("events", "area", meeting, area);
      await f.link("events", "files", meeting, file);

      const result = await duplicate(meeting, { date: "2026-10-19" });

      expect(await f.edgesOf(result.item.id)).toEqual(
        [`area:${area}`, `files:${file}`, `calendar:${f.calendar("Work")}`].sort(),
      );
    }));

  it("links the participants of an Event copy without their invitations and keeps the organizer role", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const meeting = await f.eventIn("Work", MEETING);
      const [me, invited, plain] = [
        await f.create("people", { name: "Me" }),
        await f.create("people", { name: "Invited" }),
        await f.create("people", { name: "Plain" }),
      ];
      await withTransaction(runtime, (client) => setSelfPersonId(client, me));
      await f.link("events", "people", meeting, me, { role: "organizer" });
      await f.link("events", "people", meeting, plain);
      // The invitation is written the way the invitation code writes it, with the system writer.
      await f.cp.createRelation({
        relationPropertyId: (await f.property("events", "people")).id,
        callerItemId: meeting,
        targetItemId: invited,
        metadata: { invitation: { status: "accepted", email: "invited@example.com", mailboxId: MAILBOX_ID } },
      });
      const source = await f.edgeMetadata(meeting, "people");
      expect(source.find((entry) => entry.targetItemId === invited)?.metadata).toHaveProperty("invitation");

      const result = await duplicate(meeting, { date: "2026-10-19" });

      const copied = await f.edgeMetadata(result.item.id, "people");
      expect(copied.map((entry) => [entry.targetItemId, entry.metadata]).sort()).toEqual(
        [
          [me, { role: "organizer" }],
          [invited, {}],
          [plain, {}],
        ].sort(),
      );
    }));

  it("copies a done Task as notDone without completion data, with its people and files", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const task = await f.create("tasks", {
        name: "Send the report",
        date: "2026-10-16",
        timeFrom: "09:00",
        timeTo: "09:30",
        flagged: true,
        description: "With the figures",
        notifications: true,
      });
      const [ann, bob] = [await f.create("people", { name: "Ann" }), await f.create("people", { name: "Bob" })];
      const file = await f.create("files", { name: "report.pdf" });
      const project = await f.create("projects", { name: "Reporting" });
      const event = await f.eventIn("Work", MEETING);
      await f.link("tasks", "people", task, ann);
      await f.link("tasks", "people", task, bob);
      await f.link("tasks", "files", task, file);
      await f.link("tasks", "project", task, project);
      await createTaskHostEventPutRouteHandler(runtime)({
        params: { id: task, eventId: event },
        body: {},
        identity: { user: { id: userId } },
      });
      await f.cp.updateItem(
        { databaseId: f.db("tasks"), itemId: task, propertiesPatch: { status: "done" } },
        userId,
        userId,
        USER,
      );
      const done = await f.read("tasks", task);
      expect(done?.properties.status).toBe("done");
      expect(done?.properties.completedOn).toEqual(expect.any(String));

      const result = await duplicate(task, { date: "2026-10-20" });

      expect(result.status).toBe(201);
      expect(result.item.id).not.toBe(task);
      expect(result.item.properties).toMatchObject({
        name: "Send the report",
        date: "2026-10-20",
        timeFrom: "09:00",
        timeTo: "09:30",
        flagged: true,
        description: "With the figures",
        notifications: true,
        status: "notDone",
      });
      for (const key of ["completedOn", "completedAt", "seriesId", "occurrenceDate"]) {
        expect(result.item.properties[key] ?? null, key).toBeNull();
      }
      expect(await f.edgesOf(result.item.id)).toEqual(
        [`people:${ann}`, `people:${bob}`, `files:${file}`, `project:${project}`].sort(),
      );
    }));

  it("takes the times of the request for a Task copy when it names one, and the source's otherwise", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const task = await f.create("tasks", { name: "Timed", date: "2026-10-16", timeFrom: "09:00", timeTo: "09:30" });

      const keeps = await duplicate(task, { date: "2026-10-20" });
      const replaces = await duplicate(task, { date: "2026-10-20", timeFrom: "13:00", timeTo: "14:00" });
      const startOnly = await duplicate(task, { date: "2026-10-20", timeFrom: "08:00" });

      expect(keeps.item.properties).toMatchObject({ timeFrom: "09:00", timeTo: "09:30" });
      expect(replaces.item.properties).toMatchObject({ timeFrom: "13:00", timeTo: "14:00" });
      expect(startOnly.item.properties.timeFrom).toBe("08:00");
      expect(startOnly.item.properties.timeTo ?? null).toBeNull();
    }));

  it("refuses an endDate for a Task with 400 on endDate and creates nothing", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const task = await f.create("tasks", { name: "Plain", date: "2026-10-16" });
      const before = await f.idsIn("tasks");

      const refused = await duplicate(task, { date: "2026-10-20", endDate: "2026-10-21" }).catch(
        (error: unknown) => error,
      );

      expect(refused).toMatchObject({ status: 400, code: "validation_failed", details: { field: "endDate" } });
      expect(await f.idsIn("tasks")).toEqual(before);
    }));

  it("refuses an invalid Task time with 400 and creates nothing", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const task = await f.create("tasks", { name: "Plain", date: "2026-10-16" });
      const before = await f.idsIn("tasks");

      const refused = await duplicate(task, { date: "2026-10-20", timeFrom: "10:00", timeTo: "24:15" }).catch(
        (error: unknown) => error,
      );

      expect(refused).toMatchObject({ status: 400, code: "validation_failed", details: { field: "timeTo" } });
      expect(await f.idsIn("tasks")).toEqual(before);
    }));

  it("starts a new series for the copy of a recurring Task, with the same rule and the copy's date as its anchor", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const task = await f.create("tasks", { name: "Water the plants", date: "2026-10-19" });
      await createTaskRecurrenceSetRouteHandler(runtime)({
        params: { id: task },
        body: { preset: "weekly" },
        identity: { user: { id: userId } },
      });
      const source = await f.read("tasks", task);
      const sourceSeries = z.string().parse(source?.properties.seriesId);

      const result = await duplicate(task, { date: "2026-10-22" });

      const copySeries = z.string().parse(result.item.properties.seriesId);
      expect(copySeries).not.toBe(sourceSeries);
      expect(result.item.properties.occurrenceDate).toBe("2026-10-22");
      expect(result.item.properties.recurrence).toEqual(source?.properties.recurrence);
      expect(result.item.properties.recurrence).toMatchObject({ preset: "weekly", mode: "fixed" });
      const stored = await withTransaction(runtime, async (client) => ({
        source: await getTaskRecurrenceBySeriesId(client, sourceSeries),
        copy: await getTaskRecurrenceBySeriesId(client, copySeries),
      }));
      expect(stored.copy).toMatchObject({
        itemId: result.item.id,
        active: true,
        anchorDate: "2026-10-22",
        mode: stored.source?.mode,
        rule: stored.source?.rule,
      });
      expect(stored.copy?.template).toMatchObject({ name: "Water the plants" });
      // The source keeps its own series, unchanged.
      expect(stored.source).toMatchObject({ itemId: task, active: true, anchorDate: "2026-10-19" });
      expect((await f.read("tasks", task))?.properties.seriesId).toBe(sourceSeries);
    }));

  it("gives the copy of a Task whose series is turned off no series", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const task = await f.create("tasks", { name: "Was recurring", date: "2026-10-19" });
      await createTaskRecurrenceSetRouteHandler(runtime)({
        params: { id: task },
        body: { preset: "daily" },
        identity: { user: { id: userId } },
      });
      const seriesId = z.string().parse((await f.read("tasks", task))?.properties.seriesId);
      // A series turned off keeps its row inactive, and the occurrences it made keep their `seriesId` as history.
      await admin.query(`UPDATE task_recurrence SET active = false WHERE series_id = $1::uuid`, [seriesId]);

      const result = await duplicate(task, { date: "2026-10-22" });

      expect(result.item.properties.seriesId ?? null).toBeNull();
      expect(result.item.properties.recurrence ?? null).toBeNull();
    }));

  it("does not copy the host events of a Task, nor the Task's completion in an Event", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const task = await f.create("tasks", { name: "Hosted", date: "2026-10-16" });
      const event = await f.eventIn("Work", MEETING);
      await createTaskHostEventPutRouteHandler(runtime)({
        params: { id: task, eventId: event },
        body: {},
        identity: { user: { id: userId } },
      });
      expect(await f.edgesOf(task)).toEqual([`hostEvents:${event}`]);

      const result = await duplicate(task, { date: "2026-10-20" });

      expect(await f.edgesOf(result.item.id)).toEqual([]);
    }));

  it("leaves no new item when an edge cannot be copied", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const meeting = await f.eventIn("Work", MEETING);
      const [ann, bob] = [await f.create("people", { name: "Ann" }), await f.create("people", { name: "Bob" })];
      await f.link("events", "people", meeting, ann);
      await f.link("events", "people", meeting, bob);
      const before = await f.idsIn("events");
      failEdgeWriteTo = bob;

      await expect(duplicate(meeting, { date: "2026-10-19" }, "copy-fails")).rejects.toThrow(
        "edge write refused on purpose",
      );

      expect(await f.idsIn("events")).toEqual(before);
      // The key was not kept either: once the failure is gone, the same key makes one complete copy.
      failEdgeWriteTo = null;
      const retried = await duplicate(meeting, { date: "2026-10-19" }, "copy-fails");
      expect((await f.idsIn("events")).length).toBe(before.length + 1);
      expect((await f.edgeMetadata(retried.item.id, "people")).map((entry) => entry.targetItemId).sort()).toEqual(
        [ann, bob].sort(),
      );
    }));

  it("answers an unknown id, a trashed item, another tenant's item and an item of another database with the same 404", async () => {
    const foreignWorld = await runInTenant(foreign, async () => {
      const other = await setup();
      return { eventId: await other.eventIn("Work", MEETING), eventIds: await other.idsIn("events") };
    });
    await runInTenant(tenant, async () => {
      const f = await setup();
      const trashed = await f.eventIn("Work", MEETING);
      await f.cp.softDeleteItem(f.db("events"), trashed);
      const project = await f.create("projects", { name: "Not a calendar item" });
      const before = await f.idsIn("events");

      for (const id of [randomUUID(), trashed, project, foreignWorld.eventId]) {
        const answer = await duplicate(id, { date: "2026-10-19" }).catch((error: unknown) => error);
        expect(answer, id).toBeInstanceOf(ChokePointError);
        expect(answer, id).toMatchObject({ status: 404, code: "not_found" });
        // The message names the requested id and nothing else, so a foreign id reads like a random one.
        expect(answer instanceof Error ? answer.message.replace(id, "<id>") : null, id).toBe(
          "Calendar item <id> not found",
        );
      }

      expect(await f.idsIn("events")).toEqual(before);
    });
    const foreignAfter = await runInTenant(foreign, async () => (await setup()).idsIn("events"));
    expect(foreignAfter).toEqual(foreignWorld.eventIds);
  });

  describe("request validation", () => {
    it.each([
      ["an id that is not a UUID", "not-a-uuid", { date: "2026-10-19" }, undefined, "id"],
      ["a body that is not an object", randomUUID(), "2026-10-19", undefined, "body"],
      ["a body without a date", randomUUID(), {}, undefined, "date"],
      ["a timeFrom that is not a string", randomUUID(), { date: "2026-10-19", timeFrom: 10 }, undefined, "timeFrom"],
      ["a key the body does not take", randomUUID(), { date: "2026-10-19", status: "done" }, undefined, "status"],
      [
        "an Idempotency-Key of more than 255 characters",
        randomUUID(),
        { date: "2026-10-19" },
        "k".repeat(256),
        "Idempotency-Key",
      ],
    ])("refuses %s with 400 on the field before any write", (_label, id, body, key, field) =>
      runInTenant(tenant, async () => {
        const refused = await duplicate(id, body, key).catch((error: unknown) => error);

        expect(refused).toMatchObject({ status: 400, code: "validation_failed", details: { field } });
      }),
    );

    it("refuses an Idempotency-Key header sent more than once", () =>
      runInTenant(tenant, async () => {
        const refused = await createDuplicateCalendarItemRouteHandler(runtime)({
          req: { headers: { "idempotency-key": ["one", "two"] } },
          params: { id: randomUUID() },
          body: { date: "2026-10-19" },
          identity: { user: { id: userId } },
        }).catch((error: unknown) => error);

        expect(refused).toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "Idempotency-Key" },
        });
      }));

    it("takes an empty Idempotency-Key as none", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const meeting = await f.eventIn("Work", MEETING);

        const first = await duplicate(meeting, { date: "2026-10-19" }, "");
        const second = await duplicate(meeting, { date: "2026-10-19" }, "");

        expect(second.item.id).not.toBe(first.item.id);
      }));
  });
});
