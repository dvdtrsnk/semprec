import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { ChokePointError } from "../../errors.js";
import { withTransaction } from "../../db/pool.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { readCalendarCancellationImpact } from "../calendarCancellationImpact.js";
import { createCalendarCancellationImpactRouteHandler } from "../cancellationImpactRouteHandler.js";
import { createEventInCalendar } from "../defaultCalendarCreateHook.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

const USER = { writerKind: "user" } as const;
const MAILBOX_ID = randomUUID();

const impactSchema = z
  .object({ eventCount: z.number(), recipientCount: z.number(), cancellationCount: z.number() })
  .strict();

/** Parses the handler body at the boundary, as JSON carries it, so every assertion reads a checked shape. */
function impactOf(result: { status: number; body: unknown }) {
  expect(result.status).toBe(200);
  return impactSchema.parse(JSON.parse(JSON.stringify(result.body)));
}

/** What a refused request tells the caller: its status, code, message and details. */
async function refusalOf(request: Promise<unknown>) {
  const thrown = await request.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(thrown instanceof ChokePointError)) throw new Error("The request was not refused with a choke point error");
  return { status: thrown.status, code: thrown.code, message: thrown.message, details: thrown.details };
}

/** The tables a read could write to, as one digest each, so a change of any row or a row added or removed shows. */
async function stateDigest(): Promise<Record<string, string>> {
  const tables = [
    "items",
    "item_relations",
    "item_search_index",
    "notifications",
    "view_items",
    "idempotency_keys",
    "agent_run_events",
    "heartbeat_occurrences",
  ];
  const digest: Record<string, string> = {};
  for (const table of tables) {
    // The table name comes from the fixed list above; a table name cannot be a bind parameter.
    const { rows } = await admin.query<{ digest: string }>(
      `SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS digest FROM ${table} t`,
    );
    digest[table] = rows[0]?.digest ?? "";
  }
  return digest;
}

describe("GET /api/calendar/calendars/:id/cancellation-impact (issue gh-2003)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify cancellation impact role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) {
      await createUser(admin, {
        tenantId: id,
        email: `${randomUUID()}@example.com`,
        passwordHash: "unused",
        locale: "en",
      });
      await runInTenant(id, () => seedSystem(runtime));
    }
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  /** The writes a fixture is built from, in the tenant in scope, all through the choke point. */
  async function setup() {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const database = (moduleId: string) => {
      const row = databases.find((candidate) => candidate.ownerModuleId === moduleId);
      if (!row) throw new Error(`Missing the ${moduleId} database`);
      return row.id;
    };
    const calendarsId = database(CALENDARS_MODULE_ID);
    const eventsId = database("events");
    const peopleId = database("people");
    const eventsPeople = (await cp.listProperties(eventsId)).find((property) => property.key === "people");
    if (!eventsPeople) throw new Error("Missing Events.people");
    const calendar = async (name: string) =>
      (await cp.createItem({ databaseId: calendarsId, properties: { name } }, undefined, undefined, USER)).id;
    const event = async (name: string, calendarId: string) => {
      const created = await withTransaction(runtime, (client) =>
        createEventInCalendar(client, { properties: { name, date: "2026-11-16" } }, calendarId, { writer: USER }),
      );
      return created.id;
    };
    const person = async (name: string) =>
      (await cp.createItem({ databaseId: peopleId, properties: { name } }, undefined, undefined, USER)).id;
    /** A participant edge written by the user: no invitation. */
    const attend = (eventId: string, personId: string, metadata?: Record<string, unknown>) =>
      cp.createRelation(
        { relationPropertyId: eventsPeople.id, callerItemId: eventId, targetItemId: personId, metadata },
        USER,
      );
    /** A participant edge with an invitation, written with the system writer kind as the invitation code writes it. */
    const invite = (eventId: string, personId: string, email: string) =>
      cp.createRelation({
        relationPropertyId: eventsPeople.id,
        callerItemId: eventId,
        targetItemId: personId,
        metadata: { invitation: { status: "pending", email, mailboxId: MAILBOX_ID } },
      });
    const trashEvent = (eventId: string) => cp.softDeleteItem(eventsId, eventId, undefined, USER);
    const trashCalendar = (calendarId: string) => cp.softDeleteItem(calendarsId, calendarId, undefined, USER);
    const trashPerson = (personId: string) => cp.softDeleteItem(peopleId, personId, undefined, USER);
    /**
     * Gives a calendar another `kind`. An Event is created in an own calendar only, and the key is written by the
     * calendar module alone, so the fixture fills the calendar first and stores the kind directly afterwards.
     */
    const setKind = async (calendarId: string, kind: string) => {
      const result = await admin.query(
        "UPDATE items SET properties = properties || $3::jsonb WHERE tenant_id = $1 AND id = $2",
        [tenant, calendarId, JSON.stringify({ kind })],
      );
      expect(result.rowCount).toBe(1);
    };
    return { event, calendar, person, attend, invite, trashEvent, trashCalendar, trashPerson, setKind };
  }

  /** Calls the handler as the adapter does: inside the tenant's scope. */
  const route = (tenantId: string, id: string) =>
    runInTenant(tenantId, () => createCalendarCancellationImpactRouteHandler(runtime)({ params: { id } }));

  it("answers the Events, cancellations and distinct invited people of a calendar with three Events", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const calendar = await f.calendar("Clients");
      const [first, second] = [await f.event("First", calendar), await f.event("Second", calendar)];
      await f.event("Third", calendar);
      const [petr, jana] = [await f.person("Petr Novák"), await f.person("Jana Kovářová")];
      await f.invite(first, petr, "petr.novak@example.com");
      await f.invite(second, petr, "petr.novak@example.com");
      await f.invite(second, jana, "jana.kovarova@example.com");

      expect(impactOf(await route(tenant, calendar))).toEqual({
        eventCount: 3,
        cancellationCount: 3,
        recipientCount: 2,
      });
    });
  });

  it("counts an address written in another letter case as the same invited person", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const calendar = await f.calendar("Clients");
      const [first, second] = [await f.event("First", calendar), await f.event("Second", calendar)];
      const [petr, other] = [await f.person("Petr Novák"), await f.person("Petr's other card")];
      await f.invite(first, petr, "Petr.Novak@Example.com");
      await f.invite(second, other, "petr.novak@example.COM");

      expect(impactOf(await route(tenant, calendar))).toEqual({
        eventCount: 2,
        cancellationCount: 2,
        recipientCount: 1,
      });
    });
  });

  it("counts one person invited with two different addresses as two invited people", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const calendar = await f.calendar("Clients");
      const [first, second] = [await f.event("First", calendar), await f.event("Second", calendar)];
      const petr = await f.person("Petr Novák");
      await f.invite(first, petr, "petr.novak@example.com");
      await f.invite(second, petr, "petr@work.example.com");

      expect(impactOf(await route(tenant, calendar))).toEqual({
        eventCount: 2,
        cancellationCount: 2,
        recipientCount: 2,
      });
    });
  });

  it("does not count a participant edge without an invitation or with an invitation of an unknown shape", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const calendar = await f.calendar("Clients");
      const meeting = await f.event("Meeting", calendar);
      const [invited, plain, withRole, unreadable] = [
        await f.person("Invited"),
        await f.person("Plain"),
        await f.person("Role only"),
        await f.person("Unreadable"),
      ];
      await f.invite(meeting, invited, "invited@example.com");
      await f.attend(meeting, plain);
      await f.attend(meeting, withRole, { role: "attendee" });
      await f.attend(meeting, unreadable);
      // A stored invitation of a shape the participant rules do not define cannot be written through the choke
      // point (it refuses it), so the fixture stores it directly, as an edge written before the rules existed.
      await admin.query(
        `UPDATE item_relations SET metadata = jsonb_build_object('invitation', jsonb_build_object('status', 'bogus'))
          WHERE tenant_id = $1 AND (item_a = $2 OR item_b = $2) AND (item_a = $3 OR item_b = $3)`,
        [tenant, meeting, unreadable],
      );

      expect(impactOf(await route(tenant, calendar))).toEqual({
        eventCount: 1,
        cancellationCount: 1,
        recipientCount: 1,
      });
    });
  });

  it("does not count an Event in the Trash or its invitations, and counts the edge of a person in the Trash", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const calendar = await f.calendar("Clients");
      const [live, trashed] = [await f.event("Live", calendar), await f.event("Trashed", calendar)];
      const [petr, jana] = [await f.person("Petr Novák"), await f.person("Jana Kovářová")];
      await f.invite(live, petr, "petr.novak@example.com");
      await f.invite(trashed, jana, "jana.kovarova@example.com");
      await f.trashEvent(trashed);

      expect(impactOf(await route(tenant, calendar))).toEqual({
        eventCount: 1,
        cancellationCount: 1,
        recipientCount: 1,
      });

      // The deletion enqueues one cancellation for every edge of the Event that carries an invitation, so an
      // invited person who is in the Trash is still one.
      await f.trashPerson(petr);
      expect(impactOf(await route(tenant, calendar))).toEqual({
        eventCount: 1,
        cancellationCount: 1,
        recipientCount: 1,
      });
    });
  });

  it("counts only the Events of the asked calendar", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const [asked, other] = [await f.calendar("Asked"), await f.calendar("Other")];
      const petr = await f.person("Petr Novák");
      await f.invite(await f.event("In asked", asked), petr, "petr.novak@example.com");
      await f.invite(await f.event("In other", other), petr, "petr.novak@example.com");
      await f.invite(await f.event("Second in other", other), petr, "petr.novak@example.com");

      expect(impactOf(await route(tenant, asked))).toEqual({ eventCount: 1, cancellationCount: 1, recipientCount: 1 });
      expect(impactOf(await route(tenant, other))).toEqual({ eventCount: 2, cancellationCount: 2, recipientCount: 1 });
    });
  });

  it("answers zeros for a calendar with no Events, and for Events with no participants", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const empty = await f.calendar("Empty");
      expect(impactOf(await route(tenant, empty))).toEqual({ eventCount: 0, cancellationCount: 0, recipientCount: 0 });

      const bare = await f.calendar("Bare");
      await f.event("Alone", bare);
      expect(impactOf(await route(tenant, bare))).toEqual({ eventCount: 1, cancellationCount: 0, recipientCount: 0 });
    });
  });

  it("answers the numbers of a system and of a subscription calendar, which cannot be deleted", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const petr = await f.person("Petr Novák");
      for (const kind of ["system", "subscription"]) {
        const calendar = await f.calendar(`A ${kind} calendar`);
        await f.invite(await f.event(`In ${kind}`, calendar), petr, "petr.novak@example.com");
        await f.setKind(calendar, kind);
        expect(impactOf(await route(tenant, calendar))).toEqual({
          eventCount: 1,
          cancellationCount: 1,
          recipientCount: 1,
        });
      }
    });
  });

  it("answers an unknown, a trashed, a foreign and a non-calendar id with the same 404, and a malformed id with 400", async () => {
    const own = await runInTenant(tenant, async () => {
      const f = await setup();
      const trashed = await f.calendar("To trash");
      await f.trashCalendar(trashed);
      const live = await f.calendar("Live");
      const event = await f.event("An Event", live);
      return { trashed, event };
    });
    const foreignCalendar = await runInTenant(foreign, async () => {
      const f = await setup();
      const calendar = await f.calendar("Foreign");
      await f.invite(await f.event("Foreign event", calendar), await f.person("Foreign person"), "x@example.com");
      return calendar;
    });
    // The foreign calendar answers in its own tenant, so the 404 below is a refusal and not an empty fixture.
    expect(impactOf(await route(foreign, foreignCalendar))).toEqual({
      eventCount: 1,
      cancellationCount: 1,
      recipientCount: 1,
    });

    const unknown = await refusalOf(route(tenant, randomUUID()));
    expect(unknown).toMatchObject({ status: 404, code: "not_found" });
    expect(await refusalOf(route(tenant, own.trashed))).toEqual(unknown);
    expect(await refusalOf(route(tenant, foreignCalendar))).toEqual(unknown);
    expect(await refusalOf(route(tenant, own.event))).toEqual(unknown);

    expect(await refusalOf(route(tenant, "not-a-uuid"))).toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { field: "id" },
    });
  });

  it("writes nothing", async () => {
    const calendar = await runInTenant(tenant, async () => {
      const f = await setup();
      const created = await f.calendar("Clients");
      const meeting = await f.event("Meeting", created);
      await f.invite(meeting, await f.person("Petr Novák"), "petr.novak@example.com");
      return created;
    });
    const before = await stateDigest();

    impactOf(await route(tenant, calendar));
    await refusalOf(route(tenant, randomUUID()));

    expect(await stateDigest()).toEqual(before);
  });

  it("reads with the same three statements however many Events and invitations the calendar has", async () => {
    const statementsFor = async (calendar: string): Promise<number> =>
      runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          let statements = 0;
          const query = client.query.bind(client);
          const counting = new Proxy(client, {
            get(target, property) {
              if (property !== "query") return Reflect.get(target, property);
              return (...args: unknown[]) => {
                statements += 1;
                return Reflect.apply(query, target, args);
              };
            },
          });
          await readCalendarCancellationImpact(counting, calendar);
          return statements;
        }),
      );
    const small = await runInTenant(tenant, async () => {
      const f = await setup();
      const calendar = await f.calendar("Small");
      await f.event("Only", calendar);
      return calendar;
    });
    const large = await runInTenant(tenant, async () => {
      const f = await setup();
      const calendar = await f.calendar("Large");
      const people = [await f.person("One"), await f.person("Two")];
      for (let index = 0; index < 5; index += 1) {
        const meeting = await f.event(`Event ${index}`, calendar);
        for (const [position, personId] of people.entries()) {
          await f.invite(meeting, personId, `person${position}@example.com`);
        }
      }
      return calendar;
    });

    expect(await statementsFor(small)).toBe(3);
    expect(await statementsFor(large)).toBe(3);
    expect(impactOf(await route(tenant, large))).toEqual({ eventCount: 5, cancellationCount: 10, recipientCount: 2 });
  });
});
