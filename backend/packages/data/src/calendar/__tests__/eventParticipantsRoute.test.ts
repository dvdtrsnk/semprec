import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { setSelfPersonId } from "../../selfPerson.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createListEventPeopleRouteHandler } from "../eventParticipantsRouteHandlers.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

const USER = { writerKind: "user" } as const;
const MAILBOX_ID = randomUUID();

const peopleBodySchema = z
  .object({
    people: z.array(
      z
        .object({
          personId: z.string(),
          name: z.string().nullable(),
          relationship: z.string().nullable(),
          emails: z.array(z.string()),
          role: z.enum(["organizer", "attendee"]),
          invitation: z
            .object({
              status: z.string(),
              email: z.string(),
              mailboxId: z.string(),
              sentAt: z.string().optional(),
              respondedAt: z.string().optional(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
  })
  .strict();

/** Parses the handler body at the boundary, so every assertion reads a checked shape. */
function peopleOf(result: { status: number; body: unknown }) {
  expect(result.status).toBe(200);
  return peopleBodySchema.parse(JSON.parse(JSON.stringify(result.body))).people;
}

describe("GET /api/events/:id/people (issue #1757)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify event people role", () =>
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
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime));
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  /** The writes a fixture is built from, in the tenant in scope, all through the choke point. */
  async function setup() {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const row = databases.find((d) => d.ownerModuleId === key);
      if (!row) throw new Error(`Missing ${key}`);
      return row.id;
    };
    const eventsPeople = (await cp.listProperties(db("events"))).find((p) => p.key === "people");
    if (!eventsPeople) throw new Error("Missing Events.people");
    const event = async (name: string) =>
      (await cp.createItem({ databaseId: db("events"), properties: { name, date: "2026-11-16" } })).id;
    const person = async (properties: Record<string, unknown>) =>
      (await cp.createItem({ databaseId: db("people"), properties })).id;
    /** A participant edge written by the user, the way the generic edge `PUT` writes it. */
    const link = (eventId: string, personId: string, metadata?: Record<string, unknown>) =>
      cp.createRelation(
        { relationPropertyId: eventsPeople.id, callerItemId: eventId, targetItemId: personId, metadata },
        USER,
      );
    /** A participant edge with an invitation, written with the system writer kind as the invitation code writes it. */
    const invite = (eventId: string, personId: string, invitation: Record<string, unknown>) =>
      cp.createRelation({
        relationPropertyId: eventsPeople.id,
        callerItemId: eventId,
        targetItemId: personId,
        metadata: { invitation },
      });
    const setSelf = (personId: string) => withTransaction(runtime, (client) => setSelfPersonId(client, personId));
    return { cp, db, event, person, link, invite, setSelf };
  }

  const people = (id: string, locale = "cs") =>
    createListEventPeopleRouteHandler(runtime)({ params: { id }, identity: { user: { locale } } });

  it("lists the organizer, an accepted, a tentative and a not-invited participant of one Event", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const meeting = await f.event("Schuzka s klientem");
      const me = await f.person({ name: "Zdenek", emails: "zdenek@example.com" });
      const petr = await f.person({
        name: "Petr",
        relationship: "client",
        emails: "Petr@Example.com, petr@work.example\n petr@example.com ",
      });
      const jana = await f.person({ name: "Jana", relationship: "colleague" });
      const karel = await f.person({ name: "Karel" });
      await f.setSelf(me);
      await f.link(meeting, me, { role: "organizer" });
      const accepted = {
        status: "accepted",
        email: "petr@example.com",
        mailboxId: MAILBOX_ID,
        sentAt: "2026-11-10T08:00:00Z",
        respondedAt: "2026-11-10T09:30:00Z",
      };
      const tentative = { status: "tentative", email: "jana@example.com", mailboxId: MAILBOX_ID };
      await f.invite(meeting, petr, accepted);
      await f.invite(meeting, jana, tentative);
      await f.link(meeting, karel);

      expect(peopleOf(await people(meeting))).toEqual([
        {
          personId: me,
          name: "Zdenek",
          relationship: null,
          emails: ["zdenek@example.com"],
          role: "organizer",
          invitation: null,
        },
        {
          personId: jana,
          name: "Jana",
          relationship: "colleague",
          emails: [],
          role: "attendee",
          invitation: tentative,
        },
        { personId: karel, name: "Karel", relationship: null, emails: [], role: "attendee", invitation: null },
        {
          personId: petr,
          name: "Petr",
          relationship: "client",
          emails: ["petr@example.com", "petr@work.example"],
          role: "attendee",
          invitation: accepted,
        },
      ]);
    });
  });

  it("returns an edge with empty metadata as an attendee without an invitation, and no people for an Event without edges", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const meeting = await f.event("Planning");
      const empty = await f.event("Nobody invited");
      const karel = await f.person({ name: "Karel" });
      await f.link(meeting, karel, {});

      expect(peopleOf(await people(meeting))).toEqual([
        { personId: karel, name: "Karel", relationship: null, emails: [], role: "attendee", invitation: null },
      ]);
      expect(peopleOf(await people(empty))).toEqual([]);
    });
  });

  it("leaves out a person in the trash and the participants of other Events", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const meeting = await f.event("Planning");
      const other = await f.event("Retrospective");
      const karel = await f.person({ name: "Karel" });
      const trashed = await f.person({ name: "Gone" });
      const elsewhere = await f.person({ name: "Elsewhere" });
      await f.link(meeting, karel);
      await f.link(meeting, trashed);
      await f.link(other, elsewhere);
      await f.cp.softDeleteItem(f.db("people"), trashed);

      expect(peopleOf(await people(meeting)).map((entry) => entry.personId)).toEqual([karel]);
      expect(peopleOf(await people(other)).map((entry) => entry.personId)).toEqual([elsewhere]);
    });
  });

  it("orders the participants after the organizer by name in the caller's locale, a nameless person first and equal names by id", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const meeting = await f.event("Planning");
      const me = await f.person({ name: "Adam" });
      await f.setSelf(me);
      const names = ["Dana", "Čeněk", "Cyril", "Zora", "Čeněk"];
      const ids = new Map<string, string[]>();
      for (const name of names) ids.set(name, [...(ids.get(name) ?? []), await f.person({ name })]);
      // The fixture writes with the system writer kind, which may create a person without a name.
      const nameless = await f.person({});
      for (const personIds of ids.values()) for (const id of personIds) await f.link(meeting, id);
      await f.link(meeting, nameless);
      // Written last, so the organizer is first by its role and not by the order of the edges.
      await f.link(meeting, me, { role: "organizer" });

      for (const [locale, collation] of [
        ["cs", "cs"],
        ["en", "en"],
        ["de", "en"],
      ] as const) {
        const collator = new Intl.Collator(collation);
        const expected = [...new Set(names)]
          .sort((left, right) => collator.compare(left, right))
          .flatMap((name) => [...(ids.get(name) ?? [])].sort());
        const listed = peopleOf(await people(meeting, locale));
        expect(listed.map((entry) => entry.personId)).toEqual([me, nameless, ...expected]);
        expect(listed[1]?.name).toBeNull();
      }
    });
  });

  it("answers 404 for an unknown id, a trashed Event and an item of another database", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const meeting = await f.event("Planning");
      const karel = await f.person({ name: "Karel" });
      await f.link(meeting, karel);
      expect(peopleOf(await people(meeting))).toHaveLength(1);

      await f.cp.softDeleteItem(f.db("events"), meeting);
      for (const id of [randomUUID(), meeting, karel]) {
        await expect(people(id)).rejects.toMatchObject({ status: 404, code: "not_found", message: "Event not found" });
      }
    });
  });

  it("answers another tenant's Event exactly like an unknown id, through the runtime role", async () => {
    const own = await runInTenant(tenant, async () => {
      const f = await setup();
      const meeting = await f.event("Planning");
      const karel = await f.person({ name: "Karel" });
      await f.link(meeting, karel);
      return { meeting, karel };
    });
    const theirs = await runInTenant(foreign, async () => {
      const f = await setup();
      const meeting = await f.event("Their meeting");
      const person = await f.person({ name: "Theirs" });
      await f.link(meeting, person);
      return { meeting, person };
    });

    await runInTenant(tenant, async () => {
      const refusal = async (id: string) => {
        const error: unknown = await people(id).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        return z
          .object({ status: z.number(), code: z.string(), message: z.string(), details: z.unknown() })
          .parse(error);
      };
      const foreignAnswer = await refusal(theirs.meeting);
      expect(foreignAnswer).toEqual(await refusal(randomUUID()));
      expect(foreignAnswer.status).toBe(404);
      expect(peopleOf(await people(own.meeting)).map((entry) => entry.personId)).toEqual([own.karel]);
    });
    // The foreign tenant reads its own Event, so the 404 above is a refusal and not an empty fixture.
    await runInTenant(foreign, async () => {
      expect(peopleOf(await people(theirs.meeting)).map((entry) => entry.personId)).toEqual([theirs.person]);
    });
  });

  it("answers 404 in a tenant that has no Events database", async () => {
    const unseeded = await createTestTenant(admin);
    await runInTenant(unseeded, async () => {
      await expect(people(randomUUID())).rejects.toMatchObject({ status: 404, code: "not_found" });
    });
  });

  it("refuses an id that is not a UUID with validation_failed on id", async () => {
    await runInTenant(tenant, async () => {
      await expect(people("not-a-uuid")).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field: "id" },
      });
    });
  });
});
