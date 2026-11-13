import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { deleteRelationWithClient } from "../../chokePoint/relationOps.js";
import { ChokePointError } from "../../errors.js";
import { withTransaction } from "../../db/pool.js";
import { writeMailboxAddresses } from "../../mail/mailboxAddresses.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { setSelfPersonId } from "../../selfPerson.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { CALENDAR_SEND_EVENT_INVITATION_TASK } from "../eventInvitationJob.js";
import {
  createInviteEventPersonRouteHandler,
  createReplaceEventPeopleRouteHandler,
} from "../eventParticipantsRouteHandlers.js";

const USER = { writerKind: "user" } as const;
const USER_ID = randomUUID();

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

const envelopeSchema = z.object({ tenantId: z.string(), payload: z.record(z.string(), z.unknown()) });

/** The keys of the queued invitation jobs, from the queue's public view. */
async function queuedKeys(): Promise<string[]> {
  const { rows } = await admin.query<{ key: string | null }>(
    "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
    [CALENDAR_SEND_EVENT_INVITATION_TASK],
  );
  return rows.map((row) => row.key ?? "");
}

/** The envelopes (tenant and payload) of the queued invitation jobs, through the queue's test support. */
async function queuedEnvelopes() {
  return (await readJobPayloadsByIdentifier(admin, CALENDAR_SEND_EVENT_INVITATION_TASK)).map((raw) =>
    envelopeSchema.parse(raw),
  );
}

const participantBodySchema = z.object({
  people: z.array(
    z
      .object({
        personId: z.string(),
        role: z.enum(["organizer", "attendee"]),
        invitation: z.object({ status: z.string(), email: z.string(), mailboxId: z.string() }).nullable(),
      })
      .passthrough(),
  ),
});
const replaceBodySchema = participantBodySchema.extend({ invited: z.number(), linkedOnly: z.number() });

/** Fixture rows of the tenant in scope, all built through production writes. */
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
  const event = async (properties: Record<string, unknown> = {}) =>
    (
      await cp.createItem({
        databaseId: db("events"),
        properties: { name: "Meeting", date: "2026-11-16", ...properties },
      })
    ).id;
  const person = async (properties: Record<string, unknown>) =>
    (await cp.createItem({ databaseId: db("people"), properties })).id;
  const mailbox = () =>
    withTransaction(runtime, async (client) => {
      const mailboxesId = db("mailboxes");
      const item = await createItemWithClient(client, {
        databaseId: mailboxesId,
        properties: { name: "Mail", provider: "generic" },
      });
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: mailboxesId,
        mailboxItemId: item.id,
        address: "me@example.com",
      });
      return item.id;
    });
  /** A plain edge, the way the generic edge `PUT` of a user writes it. */
  const link = (eventId: string, personId: string, metadata?: Record<string, unknown>) =>
    cp.createRelation(
      { relationPropertyId: eventsPeople.id, callerItemId: eventId, targetItemId: personId, metadata },
      USER,
    );
  /** An edge with an invitation, written with the system writer kind as the invitation code writes it. */
  const invite = (eventId: string, personId: string, invitation: Record<string, unknown>) =>
    cp.createRelation({
      relationPropertyId: eventsPeople.id,
      callerItemId: eventId,
      targetItemId: personId,
      metadata: { invitation },
    });
  /** The stored edges of the Event by person id, with their metadata. */
  const edges = async (eventId: string) =>
    new Map(
      ((await cp.listItemRelations(eventId, eventsPeople.id)) ?? []).map((entry) => [
        entry.targetItemId,
        entry.metadata,
      ]),
    );
  const setSelf = (personId: string) => withTransaction(runtime, (client) => setSelfPersonId(client, personId));
  const icalUid = async (eventId: string) => {
    const { rows } = await runtime.query<{ uid: string }>(
      "SELECT properties ->> 'icalUid' AS uid FROM items WHERE id = $1",
      [eventId],
    );
    return rows[0]?.uid;
  };
  return { cp, db, eventsPeople, event, person, mailbox, link, invite, edges, setSelf, icalUid };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

const replace = (eventId: string, body: unknown) =>
  createReplaceEventPeopleRouteHandler(runtime)({
    params: { id: eventId },
    body,
    identity: { user: { id: USER_ID, locale: "en" } },
  });

const inviteOne = (eventId: string, personId: string, body: unknown) =>
  createInviteEventPersonRouteHandler(runtime)({
    params: { id: eventId, personId },
    body,
    identity: { user: { id: USER_ID, locale: "en" } },
  });

const wanted = (ids: string[], sendInvites: boolean, mailboxId?: string) => ({
  people: ids.map((personId) => ({ personId })),
  sendInvites,
  ...(mailboxId === undefined ? {} : { mailboxId }),
});

/** The error a call throws, so a test asserts its status, code and details together. */
async function failure(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    if (error instanceof ChokePointError) return { status: error.status, code: error.code, details: error.details };
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("PUT /api/events/:id/people and POST /api/events/:id/people/:personId/invite (issue #1790)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
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

  /** Runs `body` in the tenant with the fixture, a self person, a mailbox and an Event. */
  async function withMeeting<T>(
    body: (f: Fixture, ids: { meeting: string; me: string; mailbox: string }) => Promise<T>,
    options: { selfPerson?: boolean } = {},
  ): Promise<T> {
    return runInTenant(tenant, async () => {
      const f = await setup();
      const me = await f.person({ name: "Zdenek", emails: "zdenek@example.com" });
      if (options.selfPerson !== false) await f.setSelf(me);
      return body(f, { meeting: await f.event(), me, mailbox: await f.mailbox() });
    });
  }

  describe("replacing the people of an Event", () => {
    it("links two new people, one without an email, invites the one with an address and queues exactly one REQUEST", async () => {
      await withMeeting(async (f, { meeting, me, mailbox }) => {
        const petr = await f.person({ name: "Petr", emails: "Petr@Example.com, other@example.com" });
        const karel = await f.person({ name: "Karel" });

        const answer = await replace(meeting, wanted([petr, karel], true, mailbox));

        expect(answer.status).toBe(200);
        const body = replaceBodySchema.parse(JSON.parse(JSON.stringify(answer.body)));
        expect([body.invited, body.linkedOnly]).toEqual([1, 1]);
        expect(
          body.people.map((entry) => [entry.personId, entry.role, entry.invitation?.status ?? null]).sort(),
        ).toEqual(
          [
            [me, "organizer", null],
            [petr, "attendee", "pending"],
            [karel, "attendee", null],
          ].sort(),
        );
        const edges = await f.edges(meeting);
        expect(edges.get(petr)).toEqual({
          invitation: { status: "pending", email: "petr@example.com", mailboxId: mailbox },
        });
        expect(edges.get(karel)).toEqual({});
        expect(edges.get(me)).toEqual({ role: "organizer" });
        expect(edges.size).toBe(3);
        expect(await queuedKeys()).toEqual([`event-invitation:${meeting}:${petr}:REQUEST:0`]);
        expect(await queuedEnvelopes()).toMatchObject([
          {
            tenantId: tenant,
            payload: {
              method: "REQUEST",
              eventId: meeting,
              personId: petr,
              mailboxId: mailbox,
              attendeeEmail: "petr@example.com",
            },
          },
        ]);
      });
    });

    it("only links both people when sendInvites is false: no invitation is stored and no job is queued", async () => {
      await withMeeting(async (f, { meeting, me }) => {
        const petr = await f.person({ name: "Petr", emails: "petr@example.com" });
        const karel = await f.person({ name: "Karel" });

        const answer = await replace(meeting, wanted([petr, karel], false));

        const body = replaceBodySchema.parse(JSON.parse(JSON.stringify(answer.body)));
        expect([body.invited, body.linkedOnly]).toEqual([0, 2]);
        expect(body.people.map((entry) => entry.invitation)).toEqual([null, null]);
        expect(await f.edges(meeting)).toEqual(
          new Map([
            [petr, {}],
            [karel, {}],
          ]),
        );
        expect(await f.edges(meeting)).not.toHaveProperty(me);
        expect(await queuedKeys()).toEqual([]);
      });
    });

    it("needs no mailbox when nobody in the list has an address, and no organizer edge is created", async () => {
      await withMeeting(async (f, { meeting }) => {
        const karel = await f.person({ name: "Karel" });
        const answer = await replace(meeting, wanted([karel], true));
        const body = replaceBodySchema.parse(JSON.parse(JSON.stringify(answer.body)));
        expect([body.invited, body.linkedOnly]).toEqual([0, 1]);
        expect([...(await f.edges(meeting)).keys()]).toEqual([karel]);
        expect(await queuedKeys()).toEqual([]);
      });
    });

    it("removes an invited person and queues one CANCEL with the Event's UID in the same transaction", async () => {
      await withMeeting(async (f, { meeting, mailbox }) => {
        const petr = await f.person({ name: "Petr" });
        const karel = await f.person({ name: "Karel" });
        await f.invite(meeting, petr, { status: "accepted", email: "petr@example.com", mailboxId: mailbox });
        await f.link(meeting, karel);

        const answer = await replace(meeting, wanted([], false));

        const body = replaceBodySchema.parse(JSON.parse(JSON.stringify(answer.body)));
        expect(body.people).toEqual([]);
        expect(await f.edges(meeting)).toEqual(new Map());
        expect(await queuedKeys()).toEqual([`event-invitation:${meeting}:${petr}:CANCEL:0`]);
        expect(await queuedEnvelopes()).toMatchObject([
          {
            tenantId: tenant,
            payload: {
              method: "CANCEL",
              eventId: meeting,
              personId: petr,
              mailboxId: mailbox,
              attendeeEmail: "petr@example.com",
              snapshot: { uid: await f.icalUid(meeting), sequence: 0, title: "Meeting" },
            },
          },
        ]);
      });
    });

    it("keeps the people who stay: their edges and invitations are untouched and nobody is invited again", async () => {
      await withMeeting(async (f, { meeting, mailbox }) => {
        const petr = await f.person({ name: "Petr", emails: "petr@example.com" });
        const karel = await f.person({ name: "Karel", emails: "karel@example.com" });
        const jana = await f.person({ name: "Jana" });
        const invitation = {
          status: "accepted",
          email: "petr@example.com",
          mailboxId: mailbox,
          sentAt: "2026-11-10T08:00:00.000Z",
        };
        await f.invite(meeting, petr, invitation);
        await f.link(meeting, karel);
        await f.link(meeting, jana);

        const answer = await replace(meeting, wanted([petr, karel], true, mailbox));

        const body = replaceBodySchema.parse(JSON.parse(JSON.stringify(answer.body)));
        expect([body.invited, body.linkedOnly]).toEqual([0, 0]);
        expect(await f.edges(meeting)).toEqual(
          new Map([
            [petr, { invitation }],
            [karel, {}],
          ]),
        );
        expect(await queuedKeys()).toEqual([]);
      });
    });

    it("never removes the organizer edge, and creates it only once when an invitation is sent again", async () => {
      await withMeeting(async (f, { meeting, me, mailbox }) => {
        const petr = await f.person({ name: "Petr", emails: "petr@example.com" });
        const jana = await f.person({ name: "Jana", emails: "jana@example.com" });
        await f.link(meeting, me, { role: "organizer" });

        await replace(meeting, wanted([petr], true, mailbox));
        await replace(meeting, wanted([petr, jana], true, mailbox));
        expect((await f.edges(meeting)).get(me)).toEqual({ role: "organizer" });
        await replace(meeting, wanted([], true, mailbox));

        expect([...(await f.edges(meeting)).keys()]).toEqual([me]);
      });
    });

    it("counts a person named twice once", async () => {
      await withMeeting(async (f, { meeting }) => {
        const karel = await f.person({ name: "Karel" });
        const answer = await replace(meeting, wanted([karel, karel.toUpperCase()], false));
        const body = replaceBodySchema.parse(JSON.parse(JSON.stringify(answer.body)));
        expect([body.invited, body.linkedOnly, body.people.length]).toEqual([0, 1, 1]);
      });
    });

    it("removes an invitation-less person without any job and leaves the others' edges", async () => {
      await withMeeting(async (f, { meeting }) => {
        const karel = await f.person({ name: "Karel" });
        const jana = await f.person({ name: "Jana" });
        await f.link(meeting, karel);
        await f.link(meeting, jana);
        await replace(meeting, wanted([jana], false));
        expect([...(await f.edges(meeting)).keys()]).toEqual([jana]);
        expect(await queuedKeys()).toEqual([]);
      });
    });

    describe("the tenant's own person stored as an attendee edge", () => {
      // The generic edge write allows an attendee edge to the tenant's own person, so one can exist next to the
      // organizer edge's rules; the read endpoint lists it as a non-organizer participant.
      it("accepts the list that was just read: the edge stays untouched and nothing is queued", async () => {
        await withMeeting(async (f, { meeting, me, mailbox }) => {
          const karel = await f.person({ name: "Karel" });
          await f.link(meeting, me, { role: "attendee" });
          await f.link(meeting, karel);

          const answer = await replace(meeting, wanted([me, karel], true, mailbox));

          const body = replaceBodySchema.parse(JSON.parse(JSON.stringify(answer.body)));
          expect([answer.status, body.invited, body.linkedOnly]).toEqual([200, 0, 0]);
          expect(await f.edges(meeting)).toEqual(
            new Map([
              [me, { role: "attendee" }],
              [karel, {}],
            ]),
          );
          expect(await queuedKeys()).toEqual([]);
        });
      });

      it("unlinks the edge, without any job, when the list leaves the tenant's own person out", async () => {
        await withMeeting(async (f, { meeting, me }) => {
          const karel = await f.person({ name: "Karel" });
          await f.link(meeting, me);
          await f.link(meeting, karel);

          await replace(meeting, wanted([karel], false));

          expect([...(await f.edges(meeting)).keys()]).toEqual([karel]);
          expect(await queuedKeys()).toEqual([]);
        });
      });

      it("still refuses the tenant's own person when it is not stored", async () => {
        await withMeeting(async (f, { meeting, me }) => {
          const karel = await f.person({ name: "Karel" });
          await f.link(meeting, karel);
          expect(await failure(replace(meeting, wanted([karel, me], false)))).toEqual({
            status: 400,
            code: "validation_failed",
            details: { field: "people", reason: "organizerInPeople" },
          });
          expect([...(await f.edges(meeting)).keys()]).toEqual([karel]);
        });
      });

      it("makes the edge the organizer edge when an invitation is sent and the Event has no organizer edge", async () => {
        await withMeeting(async (f, { meeting, me, mailbox }) => {
          const petr = await f.person({ name: "Petr", emails: "petr@example.com" });
          await f.link(meeting, me);

          await replace(meeting, wanted([me, petr], true, mailbox));

          const edges = await f.edges(meeting);
          expect(edges.get(me)).toEqual({ role: "organizer" });
          expect([...edges.keys()].sort()).toEqual([me, petr].sort());
          expect(await queuedKeys()).toEqual([`event-invitation:${meeting}:${petr}:REQUEST:0`]);
        });
      });
    });

    describe("refusals", () => {
      it("answers 400 on mailboxId, writing nothing, when an invitation is to be sent and the mailbox is missing", async () => {
        await withMeeting(async (f, { meeting }) => {
          const petr = await f.person({ name: "Petr", emails: "petr@example.com" });
          expect(await failure(replace(meeting, wanted([petr], true)))).toEqual({
            status: 400,
            code: "validation_failed",
            details: { field: "mailboxId" },
          });
          expect(await f.edges(meeting)).toEqual(new Map());
          expect(await queuedKeys()).toEqual([]);
        });
      });

      it("answers the same 400 for an unknown mailbox, another tenant's mailbox and a mailbox in the trash", async () => {
        const foreignMailbox = await runInTenant(foreign, async () => (await setup()).mailbox());
        await withMeeting(async (f, { meeting, mailbox }) => {
          const petr = await f.person({ name: "Petr", emails: "petr@example.com" });
          const trashed = await f.mailbox();
          await f.cp.softDeleteItem(f.db("mailboxes"), trashed);
          for (const mailboxId of [randomUUID(), foreignMailbox, trashed]) {
            expect(await failure(replace(meeting, wanted([petr], true, mailboxId)))).toEqual({
              status: 400,
              code: "validation_failed",
              details: { field: "mailboxId" },
            });
          }
          expect(await f.edges(meeting)).toEqual(new Map());
          expect(await queuedKeys()).toEqual([]);
          // The live mailbox of the same request is accepted, so the refusals above are about the mailbox.
          expect((await replace(meeting, wanted([petr], true, mailbox))).status).toBe(200);
        });
      });

      it("answers 400 on sendInvites when an invitation is to be sent and the user is linked to no person, writing nothing", async () => {
        await withMeeting(
          async (f, { meeting, mailbox }) => {
            const petr = await f.person({ name: "Petr", emails: "petr@example.com" });
            const karel = await f.person({ name: "Karel" });
            expect(await failure(replace(meeting, wanted([karel, petr], true, mailbox)))).toEqual({
              status: 400,
              code: "validation_failed",
              details: { field: "sendInvites", reason: "noSelfPerson" },
            });
            expect(await f.edges(meeting)).toEqual(new Map());
            expect(await queuedKeys()).toEqual([]);
          },
          { selfPerson: false },
        );
      });

      it("answers 400 on people for the tenant's own person, and for the person of an organizer edge", async () => {
        await withMeeting(async (f, { meeting, me }) => {
          const other = await f.person({ name: "Other" });
          const refused = {
            status: 400,
            code: "validation_failed",
            details: { field: "people", reason: "organizerInPeople" },
          };
          expect(await failure(replace(meeting, wanted([me], false)))).toEqual(refused);
          expect(await f.edges(meeting)).toEqual(new Map());

          // `other` is the organizer when the edge is written; the user is linked to `me` again afterwards.
          await f.setSelf(other);
          await f.link(meeting, other, { role: "organizer" });
          await f.setSelf(me);
          expect(await failure(replace(meeting, wanted([other], false)))).toEqual(refused);
          expect(await f.edges(meeting)).toEqual(new Map([[other, { role: "organizer" }]]));
        });
      });

      it("answers 400 on people for an unknown person, another tenant's person and a person in the trash, writing nothing", async () => {
        const foreignPerson = await runInTenant(foreign, async () => (await setup()).person({ name: "Elsewhere" }));
        await withMeeting(async (f, { meeting }) => {
          const karel = await f.person({ name: "Karel" });
          const trashed = await f.person({ name: "Gone" });
          await f.cp.softDeleteItem(f.db("people"), trashed);
          for (const personId of [randomUUID(), foreignPerson, trashed]) {
            expect(await failure(replace(meeting, wanted([karel, personId], false)))).toEqual({
              status: 400,
              code: "validation_failed",
              details: { field: "people", reason: "unknownPerson" },
            });
          }
          expect(await f.edges(meeting)).toEqual(new Map());
        });
      });

      it("answers 404 for an unknown Event, another tenant's Event and an Event in the trash", async () => {
        const foreignEvent = await runInTenant(foreign, async () => (await setup()).event());
        await withMeeting(async (f, { meeting }) => {
          const karel = await f.person({ name: "Karel" });
          const trashed = await f.event();
          await f.cp.softDeleteItem(f.db("events"), trashed);
          for (const eventId of [randomUUID(), foreignEvent, trashed]) {
            expect(await failure(replace(eventId, wanted([karel], false)))).toMatchObject({
              status: 404,
              code: "not_found",
            });
          }
          expect(await f.edges(meeting)).toEqual(new Map());
          expect(await f.edges(trashed)).toEqual(new Map());
        });
      });

      it.each<[string, string, unknown, string]>([
        ["an id that is not a UUID", "not-a-uuid", wanted([], false), "id"],
        ["a body that is not an object", randomUUID(), "text", "body"],
        ["an unknown key", randomUUID(), { ...wanted([], false), note: "x" }, "note"],
        ["a missing sendInvites", randomUUID(), { people: [] }, "sendInvites"],
        ["a sendInvites that is not a boolean", randomUUID(), { people: [], sendInvites: "yes" }, "sendInvites"],
        ["a missing people list", randomUUID(), { sendInvites: false }, "people"],
        ["a person id that is not a UUID", randomUUID(), wanted(["nope"], false), "people"],
        [
          "a person entry with an extra key",
          randomUUID(),
          { people: [{ personId: randomUUID(), x: 1 }], sendInvites: false },
          "people",
        ],
        ["a mailboxId that is not a UUID", randomUUID(), { ...wanted([], false), mailboxId: "nope" }, "mailboxId"],
        [
          "more than 200 people",
          randomUUID(),
          wanted(
            Array.from({ length: 201 }, () => randomUUID()),
            false,
          ),
          "people",
        ],
      ])(
        "answers 400 validation_failed on the field for %s, before any lookup",
        async (_label, eventId, body, field) => {
          expect(await failure(replace(eventId, body))).toMatchObject({
            status: 400,
            code: "validation_failed",
            details: { field },
          });
        },
      );
    });

    describe("atomicity", () => {
      /** Makes the insert of an edge that names `personId` fail, as a database fault after earlier edge writes. */
      async function refuseEdgeTo(personId: string): Promise<() => Promise<void>> {
        await admin.query("CREATE TABLE refused_participants (person_id uuid NOT NULL)");
        await admin.query("GRANT SELECT ON refused_participants TO PUBLIC");
        await admin.query("INSERT INTO refused_participants (person_id) VALUES ($1)", [personId]);
        await admin.query(`
          CREATE FUNCTION refuse_participant_edge() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF EXISTS (SELECT 1 FROM refused_participants WHERE person_id IN (NEW.item_a, NEW.item_b)) THEN
              RAISE EXCEPTION 'participant edge refused';
            END IF;
            RETURN NEW;
          END $$`);
        await admin.query(
          "CREATE TRIGGER refuse_participant_edge BEFORE INSERT ON item_relations FOR EACH ROW EXECUTE FUNCTION refuse_participant_edge()",
        );
        return async () => {
          await admin.query("DROP TRIGGER refuse_participant_edge ON item_relations");
          await admin.query("DROP FUNCTION refuse_participant_edge()");
          await admin.query("DROP TABLE refused_participants");
        };
      }

      it("leaves neither edges nor jobs when a later edge write fails after the organizer edge and the first invitation", async () => {
        await withMeeting(async (f, { meeting, mailbox }) => {
          const petr = await f.person({ name: "Petr", emails: "petr@example.com" });
          const jana = await f.person({ name: "Jana", emails: "jana@example.com" });
          const undo = await refuseEdgeTo(jana);
          try {
            await expect(replace(meeting, wanted([petr, jana], true, mailbox))).rejects.toThrow(
              "participant edge refused",
            );
          } finally {
            await undo();
          }
          expect(await f.edges(meeting)).toEqual(new Map());
          expect(await queuedKeys()).toEqual([]);
        });
      });

      it("keeps a removed person's edge and queues no CANCEL when a later edge write fails", async () => {
        await withMeeting(async (f, { meeting, mailbox }) => {
          const petr = await f.person({ name: "Petr" });
          const jana = await f.person({ name: "Jana" });
          const invitation = { status: "pending", email: "petr@example.com", mailboxId: mailbox };
          await f.invite(meeting, petr, invitation);
          const undo = await refuseEdgeTo(jana);
          try {
            await expect(replace(meeting, wanted([jana], false))).rejects.toThrow("participant edge refused");
          } finally {
            await undo();
          }
          expect(await f.edges(meeting)).toEqual(new Map([[petr, { invitation }]]));
          expect(await queuedKeys()).toEqual([]);
        });
      });

      it("answers 409 version_conflict and queues no CANCEL when an invited participant's edge is removed by another transaction meanwhile", async () => {
        await withMeeting(async (f, { meeting, mailbox }) => {
          const petr = await f.person({ name: "Petr" });
          const invitation = { status: "pending", email: "petr@example.com", mailboxId: mailbox };
          await f.invite(meeting, petr, invitation);
          // Another transaction removes the edge and has not committed yet: the replacement still reads the edge,
          // then waits for the edge row and finds it gone.
          let release: () => void = () => undefined;
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          let remove: () => void = () => undefined;
          const removing = new Promise<void>((resolve) => {
            remove = resolve;
          });
          const holder = withTransaction(runtime, async (client) => {
            await deleteRelationWithClient(
              client,
              { relationPropertyId: f.eventsPeople.id, callerItemId: meeting, targetItemId: petr },
              undefined,
              USER,
            );
            remove();
            await released;
          });
          await removing;
          const racing = failure(replace(meeting, wanted([], false)));
          // The replacement is waiting for the row lock of the edge when the other transaction is the only one blocking it.
          await waitForLockWait();
          release();
          await holder;
          expect(await racing).toMatchObject({ status: 409, code: "version_conflict" });
          expect(await f.edges(meeting)).toEqual(new Map());
          expect(await queuedKeys()).toEqual([]);
        });
      });

      /** Polls until a backend of the test database waits for a lock, so the race is not decided by timing. */
      async function waitForLockWait(): Promise<void> {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const { rows } = await admin.query<{ waiting: number }>(
            "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
          );
          if ((rows[0]?.waiting ?? 0) > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("no backend waited for a lock");
      }
    });
  });

  describe("inviting one linked person", () => {
    it("stores a pending invitation on the edge, keeps its other metadata, queues one REQUEST and creates the organizer edge", async () => {
      await withMeeting(async (f, { meeting, me, mailbox }) => {
        const petr = await f.person({ name: "Petr", emails: "Petr@Example.com" });
        await f.link(meeting, petr, { role: "attendee" });

        const answer = await inviteOne(meeting, petr, { mailboxId: mailbox });

        expect(answer.status).toBe(200);
        const body = participantBodySchema.parse(JSON.parse(JSON.stringify(answer.body)));
        const invited = body.people.find((entry) => entry.personId === petr);
        expect(invited?.invitation).toEqual({ status: "pending", email: "petr@example.com", mailboxId: mailbox });
        const edges = await f.edges(meeting);
        expect(edges.get(petr)).toEqual({
          role: "attendee",
          invitation: { status: "pending", email: "petr@example.com", mailboxId: mailbox },
        });
        expect(edges.get(me)).toEqual({ role: "organizer" });
        expect(await queuedKeys()).toEqual([`event-invitation:${meeting}:${petr}:REQUEST:0`]);
      });
    });

    it("leaves an existing organizer edge as it is", async () => {
      await withMeeting(async (f, { meeting, me, mailbox }) => {
        const petr = await f.person({ name: "Petr", emails: "petr@example.com" });
        await f.link(meeting, me, { role: "organizer" });
        await f.link(meeting, petr);
        await inviteOne(meeting, petr, { mailboxId: mailbox });
        expect((await f.edges(meeting)).get(me)).toEqual({ role: "organizer" });
        expect(await queuedKeys()).toEqual([`event-invitation:${meeting}:${petr}:REQUEST:0`]);
      });
    });

    it("answers 409 conflict for a person who already has an invitation and queues nothing", async () => {
      await withMeeting(async (f, { meeting, mailbox }) => {
        const petr = await f.person({ name: "Petr", emails: "petr@example.com" });
        const invitation = { status: "declined", email: "petr@example.com", mailboxId: mailbox };
        await f.invite(meeting, petr, invitation);
        expect(await failure(inviteOne(meeting, petr, { mailboxId: mailbox }))).toMatchObject({
          status: 409,
          code: "conflict",
        });
        expect(await f.edges(meeting)).toEqual(new Map([[petr, { invitation }]]));
        expect(await queuedKeys()).toEqual([]);
      });
    });

    it("answers 400 on personId for a person without an email address and for the organizer", async () => {
      await withMeeting(async (f, { meeting, me, mailbox }) => {
        const karel = await f.person({ name: "Karel" });
        await f.link(meeting, karel);
        await f.link(meeting, me, { role: "organizer" });
        expect(await failure(inviteOne(meeting, karel, { mailboxId: mailbox }))).toEqual({
          status: 400,
          code: "validation_failed",
          details: { field: "personId", reason: "noEmailAddress" },
        });
        expect(await failure(inviteOne(meeting, me, { mailboxId: mailbox }))).toEqual({
          status: 400,
          code: "validation_failed",
          details: { field: "personId", reason: "organizerInvite" },
        });
        expect(await f.edges(meeting)).toEqual(
          new Map([
            [karel, {}],
            [me, { role: "organizer" }],
          ]),
        );
        expect(await queuedKeys()).toEqual([]);
      });
    });

    it("answers 400 on personId for the tenant's own person stored as an attendee edge, with and without an organizer edge, writing nothing", async () => {
      await withMeeting(async (f, { meeting, me, mailbox }) => {
        const refused = {
          status: 400,
          code: "validation_failed",
          details: { field: "personId", reason: "organizerInvite" },
        };
        // No organizer edge yet: the invitation must not turn the edge into an invited attendee edge.
        await f.link(meeting, me, { role: "attendee" });
        expect(await failure(inviteOne(meeting, me, { mailboxId: mailbox }))).toEqual(refused);
        expect(await f.edges(meeting)).toEqual(new Map([[me, { role: "attendee" }]]));
        expect(await queuedKeys()).toEqual([]);

        // An organizer edge to another person exists (written while the user was linked to them).
        const other = await f.person({ name: "Other", emails: "other@example.com" });
        await f.setSelf(other);
        await f.link(meeting, other, { role: "organizer" });
        await f.setSelf(me);
        expect(await failure(inviteOne(meeting, me, { mailboxId: mailbox }))).toEqual(refused);
        expect(await f.edges(meeting)).toEqual(
          new Map([
            [me, { role: "attendee" }],
            [other, { role: "organizer" }],
          ]),
        );
        expect(await queuedKeys()).toEqual([]);
      });
    });

    it("answers 404 for a person who is not linked to the Event, and writes nothing", async () => {
      await withMeeting(async (f, { meeting, mailbox }) => {
        const petr = await f.person({ name: "Petr", emails: "petr@example.com" });
        expect(await failure(inviteOne(meeting, petr, { mailboxId: mailbox }))).toMatchObject({
          status: 404,
          code: "not_found",
        });
        expect(await f.edges(meeting)).toEqual(new Map());
        expect(await queuedKeys()).toEqual([]);
      });
    });

    it("answers 404 for an unknown person, another tenant's person and a person in the trash", async () => {
      const foreignPerson = await runInTenant(foreign, async () =>
        (await setup()).person({ name: "Elsewhere", emails: "else@example.com" }),
      );
      await withMeeting(async (f, { meeting, mailbox }) => {
        const trashed = await f.person({ name: "Gone", emails: "gone@example.com" });
        await f.link(meeting, trashed);
        await f.cp.softDeleteItem(f.db("people"), trashed);
        for (const personId of [randomUUID(), foreignPerson, trashed]) {
          expect(await failure(inviteOne(meeting, personId, { mailboxId: mailbox }))).toMatchObject({
            status: 404,
            code: "not_found",
          });
        }
        expect(await queuedKeys()).toEqual([]);
      });
    });

    it("answers 404 for an unknown Event, another tenant's Event and an Event in the trash", async () => {
      const foreignEvent = await runInTenant(foreign, async () => (await setup()).event());
      await withMeeting(async (f, { mailbox }) => {
        const petr = await f.person({ name: "Petr", emails: "petr@example.com" });
        const trashed = await f.event();
        await f.link(trashed, petr);
        await f.cp.softDeleteItem(f.db("events"), trashed);
        for (const eventId of [randomUUID(), foreignEvent, trashed]) {
          expect(await failure(inviteOne(eventId, petr, { mailboxId: mailbox }))).toMatchObject({
            status: 404,
            code: "not_found",
          });
        }
        expect(await queuedKeys()).toEqual([]);
      });
    });

    it("answers 400 on mailboxId for an unknown mailbox, another tenant's mailbox and one in the trash, writing nothing", async () => {
      const foreignMailbox = await runInTenant(foreign, async () => (await setup()).mailbox());
      await withMeeting(async (f, { meeting }) => {
        const petr = await f.person({ name: "Petr", emails: "petr@example.com" });
        await f.link(meeting, petr);
        const trashed = await f.mailbox();
        await f.cp.softDeleteItem(f.db("mailboxes"), trashed);
        for (const mailboxId of [randomUUID(), foreignMailbox, trashed]) {
          expect(await failure(inviteOne(meeting, petr, { mailboxId }))).toEqual({
            status: 400,
            code: "validation_failed",
            details: { field: "mailboxId" },
          });
        }
        expect(await f.edges(meeting)).toEqual(new Map([[petr, {}]]));
        expect(await queuedKeys()).toEqual([]);
      });
    });

    it("answers 400 on sendInvites when the user is linked to no person, and keeps the edge without an invitation", async () => {
      await withMeeting(
        async (f, { meeting, mailbox }) => {
          const petr = await f.person({ name: "Petr", emails: "petr@example.com" });
          await f.link(meeting, petr);
          expect(await failure(inviteOne(meeting, petr, { mailboxId: mailbox }))).toEqual({
            status: 400,
            code: "validation_failed",
            details: { field: "sendInvites", reason: "noSelfPerson" },
          });
          expect(await f.edges(meeting)).toEqual(new Map([[petr, {}]]));
          expect(await queuedKeys()).toEqual([]);
        },
        { selfPerson: false },
      );
    });

    it.each<[string, string, string, unknown, string]>([
      ["an id that is not a UUID", "nope", randomUUID(), { mailboxId: randomUUID() }, "id"],
      ["a person id that is not a UUID", randomUUID(), "nope", { mailboxId: randomUUID() }, "personId"],
      ["a missing mailboxId", randomUUID(), randomUUID(), {}, "mailboxId"],
      ["a mailboxId that is not a UUID", randomUUID(), randomUUID(), { mailboxId: "nope" }, "mailboxId"],
      ["a body that is not an object", randomUUID(), randomUUID(), "text", "body"],
      ["an unknown key", randomUUID(), randomUUID(), { mailboxId: randomUUID(), note: "x" }, "note"],
    ])(
      "answers 400 validation_failed on the field for %s, before any lookup",
      async (_label, eventId, personId, body, field) => {
        expect(await failure(inviteOne(eventId, personId, body))).toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field },
        });
      },
    );
  });
});
