import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUser } from "../auth/usersStore.js";
import { withChosenCalendar } from "../calendar/defaultCalendarCreateHook.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { registerRelationEdgeWriteHook } from "../chokePoint/hooks.js";
import { createItemWithRelationsWithClient, type InitialItemRelation } from "../chokePoint/itemCreateWithRelations.js";
import { listItemRelationsWithClient } from "../chokePoint/relationReads.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

const USER: WriterIdentity = { writerKind: "user" };
const DESCRIPTION = "## Agenda\n- [ ] Confirm the budget";
/** An Event as the calendar creates it: no `type` among its values. */
const EVENT = {
  name: "Kickoff",
  date: "2026-11-20",
  timeFrom: "10:00",
  timeTo: "11:00",
  place: "Kancelář, Karlín",
  description: DESCRIPTION,
};

const calendarRow = z.object({ id: z.string(), properties: z.object({ name: z.string() }).passthrough() });

/** The writer kind of every Events.calendar edge write the choke point ran in this file, in order. */
const calendarEdgeWriters: string[] = [];
registerRelationEdgeWriteHook(async ({ edgeContext, writer }) => {
  if (edgeContext.property.key === "calendar") calendarEdgeWriters.push(writer.writerKind);
});

/** A tenant with one English-speaking user, so its seeded calendars are named `Personal`, `Work` and so on. */
async function seededTenant(): Promise<string> {
  const tenantId = await createTestTenant(admin);
  await createUser(admin, { tenantId, email: `${randomUUID()}@example.com`, passwordHash: "unused", locale: "en" });
  await runInTenant(tenantId, () => seedSystem(runtime));
  return tenantId;
}

/**
 * Every test runs as one tenant on the runtime-role pool, which row-level security confines to that
 * tenant; `foreign` is a second seeded tenant whose ids stand for another user's data.
 */
describe("an Event created with its calendar and relations in one write (issue #1777)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await seededTenant();
    foreign = await seededTenant();
    calendarEdgeWriters.length = 0;
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  /** The ids, the fixture rows and the reads of the tenant in scope; every write goes through the choke point. */
  async function setup() {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (moduleId: string) => {
      const row = databases.find((database) => database.ownerModuleId === moduleId);
      if (!row) throw new Error(`Missing ${moduleId}`);
      return row.id;
    };
    const eventProperties = await cp.listProperties(db("events"));
    const property = (key: string) => {
      const row = eventProperties.find((candidate) => candidate.key === key);
      if (!row) throw new Error(`Missing Events.${key}`);
      return row.id;
    };
    const calendars = z.array(calendarRow).parse((await cp.listItems(db(CALENDARS_MODULE_ID), { limit: 50 })).items);
    const calendar = (name: string) => {
      const row = calendars.find((candidate) => candidate.properties.name === name);
      if (!row) throw new Error(`Missing calendar ${name}`);
      return row.id;
    };
    const named = async (moduleId: string, name: string) =>
      (await cp.createItem({ databaseId: db(moduleId), properties: { name } }, undefined, undefined, USER)).id;
    const project = await named("projects", "Web for client");
    const people: [string, string, string] = [
      await named("people", "Alice Novak"),
      await named("people", "Bob Dvorak"),
      await named("people", "Cyril Kral"),
    ];

    const link = (key: string, ...targetItemIds: string[]): InitialItemRelation => ({
      kind: "resolved",
      relationPropertyId: property(key),
      targetItemIds,
    });
    /** `item.create` for an Event with `relations`, as a signed-in user sends it. */
    const create = (relations: InitialItemRelation[], input: { properties?: object; idempotencyKey?: string } = {}) =>
      cp.createItemWithRelations(
        {
          databaseId: db("events"),
          properties: { ...EVENT, ...input.properties },
          idempotencyKey: input.idempotencyKey,
          relations,
        },
        undefined,
        undefined,
        USER,
      );
    /** The live edges of a live item from its own side, as `[property key, target id]` pairs in the read's order. */
    const edgesOf = async (itemId: string) => {
      const entries = await cp.listItemRelations(itemId);
      if (!entries) throw new Error(`Item ${itemId} is not a live item of this tenant`);
      return entries.map((entry) => [entry.propertyKey, entry.targetItemId]);
    };
    /** The stored properties of an Event, read anew. */
    const storedProperties = async (eventId: string) => {
      const item = await cp.getItem(db("events"), eventId);
      if (!item) throw new Error(`Event ${eventId} is not stored`);
      return item.properties;
    };
    /** The five edges of the Event the acceptance criteria describe, in the order `edgesOf` reads them. */
    const fiveEdges = (calendarId: string) => [
      ["calendar", calendarId],
      ...[...people].sort().map((person) => ["people", person]),
      ["project", project],
    ];
    /** Every Event row and every relation edge of the tenant in scope, trashed rows and edges to them included. */
    const stored = async () => ({
      events: (
        await runtime.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 ORDER BY id", [db("events")])
      ).rows.map((row) => row.id),
      edges: (await runtime.query<{ id: string }>("SELECT id FROM item_relations ORDER BY id")).rows.map(
        (row) => row.id,
      ),
    });
    return { cp, db, property, calendar, project, people, link, create, edgesOf, storedProperties, fiveEdges, stored };
  }

  describe("with a chosen calendar, a project and three people", () => {
    it("stores the Event and exactly five edges, with the calendar Work and not Personal", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.stored();

        const event = await f.create([
          f.link("calendar", f.calendar("Work")),
          f.link("project", f.project),
          f.link("people", ...f.people),
        ]);

        expect(event.properties).toMatchObject(EVENT);
        expect(await f.edgesOf(event.id)).toEqual(f.fiveEdges(f.calendar("Work")));
        expect(await f.edgesOf(f.calendar("Work"))).toEqual([["events", event.id]]);
        expect(await f.edgesOf(f.calendar("Personal"))).toEqual([]);
        // Nothing else was written: one Event, and the tenant's edges are those it had and five more.
        const after = await f.stored();
        expect(after.events).toEqual([event.id]);
        expect(after.edges.filter((id) => !before.edges.includes(id))).toHaveLength(5);
        expect(before.edges.filter((id) => !after.edges.includes(id))).toEqual([]);
        // The create's own relation write stored the calendar edge, as the user's write; the hook wrote none.
        expect(calendarEdgeWriters).toEqual(["user"]);
      }));

    it("writes the Event and its five edges on the caller's client, so they roll back together", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.stored();
        const failure = new Error("a later step failed");
        let edgesInside: string[][] = [];

        await expect(
          withTransaction(runtime, async (client) => {
            const event = await createItemWithRelationsWithClient(
              client,
              {
                databaseId: f.db("events"),
                properties: EVENT,
                relations: [
                  f.link("calendar", f.calendar("Work")),
                  f.link("project", f.project),
                  f.link("people", ...f.people),
                ],
              },
              { writer: USER },
            );
            edgesInside = ((await listItemRelationsWithClient(client, event.id)) ?? []).map((entry) => [
              entry.propertyKey,
              entry.targetItemId,
            ]);
            throw failure;
          }),
        ).rejects.toBe(failure);

        // The five edges were there inside the transaction, so their absence afterwards is the rollback.
        expect(edgesInside).toEqual(f.fiveEdges(f.calendar("Work")));
        expect(await f.stored()).toEqual(before);
      }));

    it("links the default calendar once when the relations name it", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const event = await f.create([f.link("calendar", f.calendar("Personal")), f.link("project", f.project)]);
        expect(await f.edgesOf(event.id)).toEqual([
          ["calendar", f.calendar("Personal")],
          ["project", f.project],
        ]);
        expect(calendarEdgeWriters).toEqual(["user"]);
      }));

    it("does not check a calendar chosen with withChosenCalendar when the relations name the calendar", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        // `Birthdays` is a system calendar, which the hook refuses as a chosen calendar when it links one.
        const event = await withChosenCalendar(f.calendar("Birthdays"), () =>
          f.create([f.link("calendar", f.calendar("Work"))]),
        );
        expect(await f.edgesOf(event.id)).toEqual([["calendar", f.calendar("Work")]]);
        expect(await f.edgesOf(f.calendar("Birthdays"))).toEqual([]);
      }));

    it("judges the named calendar as a relation target, so a system calendar is linked as a user's edge write links it", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const event = await f.create([f.link("calendar", f.calendar("Birthdays"))]);
        expect(await f.edgesOf(event.id)).toEqual([["calendar", f.calendar("Birthdays")]]);

        // The same calendar through the relation write a user changes an existing Event's calendar with.
        const other = await f.create([f.link("calendar", f.calendar("Work"))], { properties: { name: "Review" } });
        await f.cp.setRelation(
          { relationPropertyId: f.property("calendar"), callerItemId: other.id, targetItemId: f.calendar("Birthdays") },
          USER,
        );
        expect(await f.edgesOf(other.id)).toEqual([["calendar", f.calendar("Birthdays")]]);
      }));

    it("does not read the default calendar, so a tenant without one still creates the Event in Work", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        // A tenant without a live default is a state of before issue gh-1803: deleting the default calendar now hands
        // the mark on, so only a raw write puts it in the Trash and leaves the tenant without one.
        const trashed = await withTransaction(runtime, (client) =>
          client.query("UPDATE items SET deleted_at = now() WHERE database_id = $1 AND id = $2", [
            f.db(CALENDARS_MODULE_ID),
            f.calendar("Personal"),
          ]),
        );
        expect(trashed.rowCount).toBe(1);
        const event = await f.create([f.link("calendar", f.calendar("Work"))]);
        expect(await f.edgesOf(event.id)).toEqual([["calendar", f.calendar("Work")]]);
      }));
  });

  describe("an edge that cannot be written", () => {
    it.each([
      ["calendar", "unknown"],
      ["calendar", "foreign"],
      ["calendar", "trashed"],
      ["project", "unknown"],
      ["project", "foreign"],
      ["project", "trashed"],
      ["people", "unknown"],
      ["people", "foreign"],
      ["people", "trashed"],
    ] as const)("creates nothing when the %s relation names an id that is %s", async (key, kind) => {
      const foreignIds = await runInTenant(foreign, async () => {
        const f = await setup();
        return { calendar: f.calendar("Work"), project: f.project, people: f.people[2] };
      });
      await runInTenant(tenant, async () => {
        const f = await setup();
        const own = { calendar: f.calendar("Work"), project: f.project, people: f.people[2] };
        const targetDatabase = { calendar: CALENDARS_MODULE_ID, project: "projects", people: "people" };
        let bad: string;
        if (kind === "unknown") bad = randomUUID();
        else if (kind === "foreign") bad = foreignIds[key];
        else {
          bad = own[key];
          await f.cp.softDeleteItem(f.db(targetDatabase[key]), bad);
        }
        // The refused relation comes last, so the edges before it were written and must roll back with the Event.
        const good = {
          calendar: f.link("calendar", f.calendar("Work")),
          project: f.link("project", f.project),
          people: f.link("people", f.people[0], f.people[1]),
        };
        const refused = key === "people" ? f.link("people", f.people[0], f.people[1], bad) : f.link(key, bad);
        const others = (["calendar", "project", "people"] as const).filter((other) => other !== key);
        const relations = [...others.map((other) => good[other]), refused];
        const before = await f.stored();

        const error: unknown = await f.create(relations).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

        // Another tenant's item reads exactly like an id that names nothing, and like an item in the trash.
        expect(error).toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "targetItemId" },
          message: `Relation endpoint ${bad} does not exist, is deleted, or is not in database ${f.db(targetDatabase[key])}`,
        });
        expect(await f.stored()).toEqual(before);
        expect(await f.edgesOf(f.calendar("Personal"))).toEqual([]);
      });
      await runInTenant(foreign, async () => {
        const f = await setup();
        expect((await f.stored()).events).toEqual([]);
        expect(await f.edgesOf(foreignIds.calendar)).toEqual([]);
      });
    });

    it.each([
      ["no calendar", 0],
      ["two calendars", 2],
    ] as const)("creates nothing when the calendar relation names %s", (_label, count) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.stored();
        await expect(
          f.create([f.link("calendar", ...[f.calendar("Work"), f.calendar("Family")].slice(0, count))]),
        ).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          message: "Single-valued relation requires one target",
        });
        expect(await f.stored()).toEqual(before);
        expect(calendarEdgeWriters).toEqual([]);
      }),
    );

    it("creates nothing when a relation names a property key the Events database does not have", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.stored();
        await expect(f.create([f.link("project", f.project), { kind: "unresolved" }])).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          message: "Unknown relation property",
        });
        expect(await f.stored()).toEqual(before);
      }));
  });

  describe("the Events date and time rules", () => {
    it.each([
      [
        "a timeTo that is no time",
        { timeTo: "25:00" },
        "timeTo",
        "Property 'timeTo' must be a wall-clock time HH:MM or 24:00",
      ],
      [
        "a date that does not exist",
        { date: "2026-02-30" },
        "date",
        "Property 'date' must be a calendar date YYYY-MM-DD",
      ],
    ] as const)("refuse %s and nothing is created", (_label, properties, field, message) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const before = await f.stored();
        await expect(
          f.create(
            [f.link("calendar", f.calendar("Work")), f.link("project", f.project), f.link("people", ...f.people)],
            { properties },
          ),
        ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field }, message });
        expect(await f.stored()).toEqual(before);
        expect(await f.edgesOf(f.calendar("Work"))).toEqual([]);
        expect(calendarEdgeWriters).toEqual([]);
      }),
    );
  });

  describe("the same idempotency key", () => {
    it("returns the same Event with its description and its five edges unchanged", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const idempotencyKey = randomUUID();
        const first = await f.create(
          [f.link("calendar", f.calendar("Work")), f.link("project", f.project), f.link("people", ...f.people)],
          { idempotencyKey },
        );
        const after = await f.stored();

        const replayed = await f.create([f.link("calendar", f.calendar("Family"))], {
          idempotencyKey,
          properties: { description: "Rewritten" },
        });

        expect(replayed).toEqual(first);
        expect(replayed.properties.description).toBe(DESCRIPTION);
        expect((await f.storedProperties(first.id)).description).toBe(DESCRIPTION);
        expect(await f.edgesOf(first.id)).toEqual(f.fiveEdges(f.calendar("Work")));
        expect(await f.stored()).toEqual(after);
        expect(calendarEdgeWriters).toEqual(["user"]);
      }));
  });

  describe("without a calendar relation", () => {
    it("links the default calendar to an Event created without relations", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const event = await f.cp.createItem(
          { databaseId: f.db("events"), properties: EVENT },
          undefined,
          undefined,
          USER,
        );
        expect(await f.edgesOf(event.id)).toEqual([["calendar", f.calendar("Personal")]]);
        expect(calendarEdgeWriters).toEqual(["system"]);
      }));

    it("links the default calendar to an Event created with an empty list of relations", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const event = await f.create([]);
        expect(await f.edgesOf(event.id)).toEqual([["calendar", f.calendar("Personal")]]);
        expect(calendarEdgeWriters).toEqual(["system"]);
      }));

    it("links the default calendar next to the project and the people the relations name", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const event = await f.create([f.link("project", f.project), f.link("people", ...f.people)]);
        expect(await f.edgesOf(event.id)).toEqual(f.fiveEdges(f.calendar("Personal")));
        expect(await f.edgesOf(f.calendar("Work"))).toEqual([]);
        // The hook linked the default calendar as the server's write; the create's relations named none.
        expect(calendarEdgeWriters).toEqual(["system"]);
      }));
  });

  describe("the Event type", () => {
    it.each([
      ["with relations", true],
      ["without relations", false],
    ] as const)("stays empty on an Event created %s and without a type", (_label, withRelations) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const event = withRelations
          ? await f.create([f.link("calendar", f.calendar("Work")), f.link("people", ...f.people)])
          : await f.cp.createItem({ databaseId: f.db("events"), properties: EVENT }, undefined, undefined, USER);
        expect(event.properties).not.toHaveProperty("type");
        expect(await f.storedProperties(event.id)).not.toHaveProperty("type");
      }),
    );
  });
});
