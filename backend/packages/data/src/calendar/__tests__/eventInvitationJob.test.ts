import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { simpleParser } from "mailparser";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runOnce } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { getItemById } from "../../chokePoint/itemsStore.js";
import { itemDeleteWithClient } from "../../chokePoint/itemTrash.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { SYSTEM_WRITER, type WriterIdentity } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import {
  MailRecipientRejectedError,
  MailSendAuthFailedError,
  MailTransportUnavailableError,
} from "../../mail/providerTypes.js";
import { writeMailboxAddresses } from "../../mail/mailboxAddresses.js";
import { createMailTransportFactory, type MailTransport } from "../../mail/mailTransport.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { mergeModuleTaskListForAffinity } from "../../moduleTasks.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../../systemSettings.js";
import { recordingTransport, transportFor } from "../../testSupport/mailSendFakes.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { ValidationError } from "../../errors.js";
import {
  CALENDAR_SEND_EVENT_INVITATION_TASK,
  enqueueEventInvitation,
  eventInvitationSnapshot,
  handleCalendarSendEventInvitation,
  setEventInvitationDelivery,
  type EnqueueEventInvitationInput,
  type EventInvitationSnapshot,
} from "../eventInvitationJob.js";
import { logger } from "../logger.js";

const TASK = CALENDAR_SEND_EVENT_INVITATION_TASK;
const USER = { writerKind: "user" } as const;
const ATTENDEE = "petr@example.com";

let adminPool: Pool;
let dataPool: Pool;

const jobSchema = z.object({
  key: z.string().nullable(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  runsLater: z.boolean(),
});

/** The queued jobs of the task, from the queue's public view, oldest first. */
async function queuedJobs() {
  const { rows } = await adminPool.query<Record<string, unknown>>(
    `SELECT key, attempts, last_error AS "lastError", (run_at > now()) AS "runsLater"
     FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY id`,
    [TASK],
  );
  return rows.map((row) => jobSchema.parse(row));
}

const envelopeSchema = z.object({ tenantId: z.string(), payload: z.record(z.string(), z.unknown()) });

async function queuedPayloads() {
  return (await readJobPayloadsByIdentifier(adminPool, TASK)).map((raw) => envelopeSchema.parse(raw));
}

async function newTenant(locale: string | null = "en"): Promise<string> {
  const tenantId = await createTestTenant(adminPool);
  if (locale !== null) {
    await createUser(adminPool, { tenantId, email: `${randomUUID()}@example.com`, passwordHash: "unused", locale });
  }
  await runInTenant(tenantId, () => seedSystem(dataPool));
  return tenantId;
}

/** The rows of one tenant's calendar, built in its scope on the runtime-role pool through production writes. */
function world(tenantId: string) {
  const cp = createChokePoint(dataPool);
  const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(tenantId, fn);

  async function databaseId(moduleId: string): Promise<string> {
    const database = await inTenant(() =>
      withTransaction(dataPool, (client) => databasesStore.getDatabaseByModuleId(client, moduleId)),
    );
    if (!database) throw new Error(`No ${moduleId} database`);
    return database.id;
  }

  async function create(moduleId: string, properties: Record<string, unknown>): Promise<string> {
    const id = await databaseId(moduleId);
    return (await inTenant(() => cp.createItem({ databaseId: id, properties }, undefined, undefined, USER))).id;
  }

  /** A mailbox whose first address is `address`. */
  async function mailbox(address: string | null = "me@example.com", provider = "generic"): Promise<string> {
    const mailboxesId = await databaseId("mailboxes");
    return inTenant(() =>
      withTransaction(dataPool, async (client) => {
        const item = await createItemWithClient(client, {
          databaseId: mailboxesId,
          properties: { name: "Mail", provider },
        });
        if (address !== null) {
          await writeMailboxAddresses(client, { mailboxesDatabaseId: mailboxesId, mailboxItemId: item.id, address });
        }
        return item.id;
      }),
    );
  }

  const person = (name: string) => create("people", { name });
  const event = (properties: Record<string, unknown> = {}) =>
    create("events", { name: "Client meeting", date: "2026-11-16", timeFrom: "09:00", timeTo: "10:00", ...properties });

  async function peopleProperty(): Promise<string> {
    const eventsId = await databaseId("events");
    const found = (await inTenant(() => cp.listProperties(eventsId))).find((property) => property.key === "people");
    if (!found) throw new Error("Missing Events.people");
    return found.id;
  }

  /** Stores an invitation on the Event's edge to the person, as the invitation code does: with the system writer. */
  async function invite(
    eventId: string,
    personId: string,
    mailboxId: string,
    invitation: Record<string, unknown> = {},
  ): Promise<void> {
    const relationPropertyId = await peopleProperty();
    await inTenant(() =>
      cp.createRelation(
        {
          relationPropertyId,
          callerItemId: eventId,
          targetItemId: personId,
          metadata: { invitation: { status: "pending", email: ATTENDEE, mailboxId, ...invitation } },
        },
        SYSTEM_WRITER,
      ),
    );
  }

  /** A participant without an invitation. */
  async function addPlain(eventId: string, personId: string): Promise<void> {
    const relationPropertyId = await peopleProperty();
    await inTenant(() =>
      cp.createRelation({ relationPropertyId, callerItemId: eventId, targetItemId: personId }, USER),
    );
  }

  async function removeEdge(eventId: string, personId: string): Promise<void> {
    const relationPropertyId = await peopleProperty();
    await inTenant(() =>
      cp.deleteRelation({ relationPropertyId, callerItemId: eventId, targetItemId: personId }, USER),
    );
  }

  /** The metadata of the Event's stored edge to the person, or `null` when there is none. */
  async function edge(eventId: string, personId: string): Promise<Record<string, unknown> | null> {
    const relationPropertyId = await peopleProperty();
    const edges = (await inTenant(() => cp.listItemRelations(eventId, relationPropertyId))) ?? [];
    return edges.find((entry) => entry.targetItemId === personId)?.metadata ?? null;
  }

  async function update(moduleId: string, itemId: string, propertiesPatch: Record<string, unknown>): Promise<void> {
    const id = await databaseId(moduleId);
    await inTenant(() => cp.updateItem({ databaseId: id, itemId, propertiesPatch }, undefined, undefined, USER));
  }

  async function trash(moduleId: string, itemId: string, writer: WriterIdentity = USER): Promise<void> {
    const id = await databaseId(moduleId);
    await inTenant(() => cp.softDeleteItem(id, itemId, undefined, writer));
  }

  async function restore(moduleId: string, itemId: string): Promise<void> {
    const id = await databaseId(moduleId);
    await inTenant(() => cp.restoreItem(id, itemId, undefined, USER));
  }

  async function setZone(timezone: string): Promise<void> {
    await inTenant(async () => {
      const settingsDatabaseId = await withTransaction(dataPool, (client) => getSystemSettingsDatabaseId(client));
      const itemId = await withTransaction(dataPool, (client) => getSystemSettingsItemId(client));
      await cp.updateItem({ databaseId: settingsDatabaseId, itemId, propertiesPatch: { timezone } });
    });
  }

  /** The stored Event, for the UID and the sequence. */
  async function storedEvent(eventId: string): Promise<{ icalUid: string; icalSequence: number }> {
    const id = await databaseId("events");
    const item = await inTenant(() =>
      withTransaction(dataPool, async (client) => {
        const { rows } = await client.query<{ properties: Record<string, unknown> }>(
          "SELECT properties FROM items WHERE database_id = $1 AND id = $2",
          [id, eventId],
        );
        return rows[0]?.properties;
      }),
    );
    return z.object({ icalUid: z.string(), icalSequence: z.number() }).parse(item);
  }

  /** Queues a message in a transaction of the tenant, as a hook or a route would. */
  const enqueue = (input: EnqueueEventInvitationInput) =>
    inTenant(() => withTransaction(dataPool, (client) => enqueueEventInvitation(client, input)));

  /** Runs the queued jobs of the task once, through the module registry's task list as the API runtime hosts it. */
  async function runQueued(): Promise<void> {
    const taskList = await mergeModuleTaskListForAffinity({}, await loadFullModuleRegistry(), "api");
    await runOnce({ pgPool: adminPool }, { [TASK]: taskList[TASK]! });
  }

  /** Runs one payload through the task handler in the tenant's scope, as a retry of the job would. */
  const handle = (payload: unknown) => inTenant(() => handleCalendarSendEventInvitation(payload));

  return {
    tenantId,
    cp,
    inTenant,
    create,
    mailbox,
    person,
    event,
    invite,
    addPlain,
    removeEdge,
    edge,
    update,
    trash,
    restore,
    setZone,
    storedEvent,
    enqueue,
    runQueued,
    handle,
  };
}

type World = ReturnType<typeof world>;

/** What a sent message says: its envelope, headers, the plain-text part and the lines of its calendar part. */
async function readMessage(raw: Buffer) {
  const parsed = await simpleParser(raw);
  const calendar = parsed.attachments.find((attachment) => attachment.contentType === "text/calendar");
  if (!calendar) throw new Error("The message has no text/calendar part");
  const method = /^Content-Type: text\/calendar; method=(\w+)/im.exec(raw.toString("utf8"))?.[1];
  return {
    from: parsed.from?.value.map((entry) => entry.address),
    to: parsed.to && !Array.isArray(parsed.to) ? parsed.to.value.map((entry) => entry.address) : [],
    subject: parsed.subject,
    text: parsed.text?.trim(),
    method,
    lines: calendar.content.toString("utf8").replace(/\r\n /g, "").split("\r\n"),
  };
}

/** A REQUEST payload as the hooks queue it. */
function plainRequest(ids: { eventId: string; personId: string; mailboxId: string }, email = ATTENDEE) {
  return { method: "REQUEST" as const, ...ids, attendeeEmail: email };
}

describe("event invitation messages (issue #1774)", () => {
  let transport: ReturnType<typeof recordingTransport>;

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    transport = recordingTransport();
    setEventInvitationDelivery({ pool: dataPool, transports: transportFor(transport) });
  });

  afterEach(() => {
    setEventInvitationDelivery(null);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  describe("queueing a message", () => {
    it("queues a REQUEST keyed by event, person, method and sequence, with the payload the task declares", async () => {
      const w = world(await newTenant());
      const ids = { eventId: randomUUID(), personId: randomUUID(), mailboxId: randomUUID() };
      await w.enqueue({ method: "REQUEST", ...ids, attendeeEmail: ATTENDEE, sequence: 3 });

      expect((await queuedJobs()).map((job) => job.key)).toEqual([
        `event-invitation:${ids.eventId}:${ids.personId}:REQUEST:3`,
      ]);
      expect(await queuedPayloads()).toEqual([
        { tenantId: w.tenantId, payload: { method: "REQUEST", ...ids, attendeeEmail: ATTENDEE } },
      ]);
    });

    it("queues a CANCEL with its snapshot, keyed by the snapshot's sequence", async () => {
      const w = world(await newTenant());
      const ids = { eventId: randomUUID(), personId: randomUUID(), mailboxId: randomUUID() };
      const snapshot: EventInvitationSnapshot = {
        uid: "u@semprec",
        sequence: 4,
        title: "Gone",
        start: "2026-11-16",
        end: "2026-11-17",
        place: null,
        allDay: true,
      };
      await w.enqueue({ method: "CANCEL", ...ids, attendeeEmail: ATTENDEE, snapshot });

      expect((await queuedJobs()).map((job) => job.key)).toEqual([
        `event-invitation:${ids.eventId}:${ids.personId}:CANCEL:4`,
      ]);
      expect((await queuedPayloads())[0]?.payload).toEqual({
        method: "CANCEL",
        ...ids,
        attendeeEmail: ATTENDEE,
        snapshot,
      });
    });

    it("collapses a repeat of the same message onto one job and keeps another sequence as its own job", async () => {
      const w = world(await newTenant());
      const ids = { eventId: randomUUID(), personId: randomUUID(), mailboxId: randomUUID() };
      const request = { method: "REQUEST" as const, ...ids, attendeeEmail: ATTENDEE };
      await w.enqueue({ ...request, sequence: 1 });
      await w.enqueue({ ...request, sequence: 1 });
      expect(await queuedJobs()).toHaveLength(1);
      await w.enqueue({ ...request, sequence: 2 });
      expect(await queuedJobs()).toHaveLength(2);
    });

    it("queues nothing when the transaction that queued it rolls back", async () => {
      const w = world(await newTenant());
      const ids = { eventId: randomUUID(), personId: randomUUID(), mailboxId: randomUUID() };
      await expect(
        w.inTenant(() =>
          withTransaction(dataPool, async (client) => {
            await enqueueEventInvitation(client, { method: "REQUEST", ...ids, attendeeEmail: ATTENDEE, sequence: 0 });
            throw new Error("the change failed");
          }),
        ),
      ).rejects.toThrow("the change failed");
      expect(await queuedJobs()).toEqual([]);
    });

    it.each<[string, Partial<{ attendeeEmail: string; mailboxId: string; sequence: number }>]>([
      ["an empty address", { attendeeEmail: "" }],
      ["a mailbox id that is not a UUID", { mailboxId: "mailbox" }],
    ])("refuses %s before it queues anything", async (_label, override) => {
      const w = world(await newTenant());
      const ids = { eventId: randomUUID(), personId: randomUUID(), mailboxId: randomUUID() };
      await expect(
        w.enqueue({ method: "REQUEST", ...ids, attendeeEmail: ATTENDEE, sequence: 0, ...override }),
      ).rejects.toThrow();
      expect(await queuedJobs()).toEqual([]);
    });

    it.each([-1, 1.5])("refuses the REQUEST sequence %s as validation_failed on sequence", async (sequence) => {
      const w = world(await newTenant());
      const ids = { eventId: randomUUID(), personId: randomUUID(), mailboxId: randomUUID() };
      await expect(w.enqueue({ method: "REQUEST", ...ids, attendeeEmail: ATTENDEE, sequence })).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field: "sequence" },
      });
      expect(await queuedJobs()).toEqual([]);
    });
  });

  describe("the Event hooks", () => {
    /** An Event with a sent invitation to Petr, an unsent one to Jana, a declined one to Karel and a plain participant. */
    async function eventWithInvitations() {
      const w = world(await newTenant());
      const mailboxId = await w.mailbox();
      const eventId = await w.event({ place: "Prague office" });
      const petr = await w.person("Petr");
      const jana = await w.person("Jana");
      const karel = await w.person("Karel");
      const lucie = await w.person("Lucie");
      await w.invite(eventId, petr, mailboxId, {
        sentAt: "2026-11-10T10:00:00Z",
        status: "accepted",
        respondedAt: "2026-11-10T11:00:00Z",
      });
      await w.invite(eventId, jana, mailboxId, { email: "jana@example.com" });
      await w.invite(eventId, karel, mailboxId, {
        email: "karel@example.com",
        sentAt: "2026-11-10T10:00:00Z",
        status: "declined",
      });
      await w.addPlain(eventId, lucie);
      return { w, mailboxId, eventId, petr, jana, karel, lucie };
    }

    it("queues an updated REQUEST with the higher sequence for each sent invitation that is not declined when the start moves, and leaves the reply statuses alone", async () => {
      const f = await eventWithInvitations();
      const before = { petr: await f.w.edge(f.eventId, f.petr), karel: await f.w.edge(f.eventId, f.karel) };
      const { icalSequence } = await f.w.storedEvent(f.eventId);

      await f.w.update("events", f.eventId, { timeFrom: "11:00", timeTo: "12:00" });

      const after = await f.w.storedEvent(f.eventId);
      expect(after.icalSequence).toBe(icalSequence + 1);
      expect(await queuedPayloads()).toEqual([
        {
          tenantId: f.w.tenantId,
          payload: {
            method: "REQUEST",
            eventId: f.eventId,
            personId: f.petr,
            mailboxId: f.mailboxId,
            attendeeEmail: ATTENDEE,
          },
        },
      ]);
      expect((await queuedJobs()).map((job) => job.key)).toEqual([
        `event-invitation:${f.eventId}:${f.petr}:REQUEST:${after.icalSequence}`,
      ]);
      expect(await f.w.edge(f.eventId, f.petr)).toEqual(before.petr);
      expect(await f.w.edge(f.eventId, f.karel)).toEqual(before.karel);
    });

    it("queues an updated REQUEST when the place changes", async () => {
      const f = await eventWithInvitations();
      await f.w.update("events", f.eventId, { place: "Brno office" });
      expect((await queuedPayloads()).map((job) => job.payload.personId)).toEqual([f.petr]);
    });

    it("queues nothing when the Event is only renamed", async () => {
      const f = await eventWithInvitations();
      const { icalSequence } = await f.w.storedEvent(f.eventId);
      await f.w.update("events", f.eventId, { name: "Renamed meeting" });
      expect((await f.w.storedEvent(f.eventId)).icalSequence).toBe(icalSequence);
      expect(await queuedJobs()).toEqual([]);
    });

    it("queues nothing when the update that moved the Event rolls back", async () => {
      const f = await eventWithInvitations();
      const eventsId = await databaseIdOf(f.w, "events");
      await expect(
        f.w.inTenant(() =>
          withTransaction(dataPool, async (client) => {
            await updateItemWithClient(
              client,
              { databaseId: eventsId, itemId: f.eventId, propertiesPatch: { date: "2026-11-17" } },
              { writer: USER },
            );
            expect(await jobsInTransaction(client)).toBe(1);
            throw new Error("the change failed");
          }),
        ),
      ).rejects.toThrow("the change failed");
      expect(await queuedJobs()).toEqual([]);
    });

    it("queues nothing for the update of an item of another database", async () => {
      const f = await eventWithInvitations();
      await f.w.update("people", f.petr, { name: "Petr Novák" });
      expect(await queuedJobs()).toEqual([]);
    });

    it("queues a CANCEL with a snapshot for every participant who has an invitation when the Event is trashed, whether it was sent or not", async () => {
      const f = await eventWithInvitations();
      const stored = await f.w.storedEvent(f.eventId);
      await f.w.trash("events", f.eventId);

      const jobs = await queuedPayloads();
      expect(jobs.map((job) => job.payload.personId).sort()).toEqual([f.petr, f.jana, f.karel].sort());
      for (const job of jobs) {
        expect(job.payload).toMatchObject({
          method: "CANCEL",
          eventId: f.eventId,
          mailboxId: f.mailboxId,
          snapshot: {
            uid: stored.icalUid,
            sequence: stored.icalSequence,
            title: "Client meeting",
            place: "Prague office",
            allDay: false,
            start: "2026-11-16T08:00:00.000Z",
            end: "2026-11-16T09:00:00.000Z",
          },
        });
      }
      expect((await queuedJobs()).map((job) => job.key).sort()).toEqual(
        [f.petr, f.jana, f.karel]
          .map((id) => `event-invitation:${f.eventId}:${id}:CANCEL:${stored.icalSequence}`)
          .sort(),
      );
    });

    it("queues nothing when an Event without invitations is trashed, nor when an item of another database is", async () => {
      const w = world(await newTenant());
      const eventId = await w.event();
      await w.addPlain(eventId, await w.person("Lucie"));
      await w.trash("events", eventId);
      await w.trash("people", await w.person("Petr"));
      expect(await queuedJobs()).toEqual([]);
    });

    it("queues nothing when the trash of the Event rolls back", async () => {
      const f = await eventWithInvitations();
      const eventsId = await databaseIdOf(f.w, "events");
      await expect(
        f.w.inTenant(() =>
          withTransaction(dataPool, async (client) => {
            await itemDeleteWithClient(client, eventsId, f.eventId, {
              queueAffinity: createActionQueueAffinity(),
              writer: USER,
            });
            expect(await jobsInTransaction(client)).toBe(3);
            throw new Error("the change failed");
          }),
        ),
      ).rejects.toThrow("the change failed");
      expect(await queuedJobs()).toEqual([]);
    });

    it("sends nothing when the trashed Event is restored", async () => {
      const f = await eventWithInvitations();
      await f.w.trash("events", f.eventId);
      await f.w.runQueued();
      expect(await queuedJobs()).toEqual([]);
      const sentBefore = transport.sent.length;

      await f.w.restore("events", f.eventId);

      expect(await queuedJobs()).toEqual([]);
      expect(transport.sent.length).toBe(sentBefore);
    });

    it("queues the job in the tenant that made the change and none for another tenant's Event", async () => {
      const a = await eventWithInvitations();
      const b = await eventWithInvitations();
      await a.w.update("events", a.eventId, { date: "2026-11-20" });
      const jobs = await queuedPayloads();
      expect(jobs.map((job) => [job.tenantId, job.payload.eventId])).toEqual([[a.w.tenantId, a.eventId]]);
      expect(b.eventId).not.toBe(a.eventId);
    });
  });

  describe("sending a REQUEST", () => {
    async function invitedEvent(properties: Record<string, unknown> = {}, invitation: Record<string, unknown> = {}) {
      const w = world(await newTenant());
      const mailboxId = await w.mailbox("me@example.com");
      const eventId = await w.event(properties);
      const personId = await w.person("Petr");
      await w.invite(eventId, personId, mailboxId, invitation);
      return { w, mailboxId, eventId, personId, ids: { eventId, personId, mailboxId } };
    }

    it("sends one message from the chosen mailbox to the person with the Event's UID, sequence and times, and only then sets sentAt", async () => {
      const f = await invitedEvent({ place: "Prague office" });
      await f.w.enqueue({ ...plainRequest(f.ids), sequence: 0 });
      const { icalUid } = await f.w.storedEvent(f.eventId);
      expect((await f.w.edge(f.eventId, f.personId))?.invitation).not.toHaveProperty("sentAt");

      await f.w.runQueued();

      expect(await queuedJobs()).toEqual([]);
      expect(transport.sent).toHaveLength(1);
      const sent = transport.sent[0]!;
      expect(sent.envelope).toEqual({ from: "me@example.com", recipients: [ATTENDEE] });
      const message = await readMessage(sent.raw);
      expect(message).toMatchObject({
        from: ["me@example.com"],
        to: [ATTENDEE],
        subject: "Invitation: Client meeting",
        method: "REQUEST",
      });
      expect(message.text).toContain("Client meeting");
      expect(message.lines).toEqual(
        expect.arrayContaining([
          "METHOD:REQUEST",
          `UID:${icalUid}`,
          "SEQUENCE:0",
          "DTSTART:20261116T080000Z",
          "DTEND:20261116T090000Z",
          "SUMMARY:Client meeting",
          "LOCATION:Prague office",
          "ORGANIZER:mailto:me@example.com",
          `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${ATTENDEE}`,
        ]),
      );
      const invitation = z
        .object({
          invitation: z.object({
            status: z.string(),
            email: z.string(),
            mailboxId: z.string(),
            sentAt: z.iso.datetime(),
          }),
        })
        .parse(await f.w.edge(f.eventId, f.personId)).invitation;
      expect(invitation).toMatchObject({ status: "pending", email: ATTENDEE, mailboxId: f.mailboxId });
    });

    it("writes sentAt only after the transport accepted the message", async () => {
      const f = await invitedEvent();
      const seen: Array<unknown> = [];
      transport = recordingTransport({
        async send() {
          seen.push((await f.w.edge(f.eventId, f.personId))?.invitation);
          return {};
        },
      });
      setEventInvitationDelivery({ pool: dataPool, transports: transportFor(transport) });

      await f.w.handle(plainRequest(f.ids));

      expect(seen).toEqual([{ status: "pending", email: ATTENDEE, mailboxId: f.mailboxId }]);
      expect((await f.w.edge(f.eventId, f.personId))?.invitation).toHaveProperty("sentAt");
    });

    it("converts the wall-clock times of the tenant zone to UTC", async () => {
      const f = await invitedEvent();
      await f.w.setZone("America/New_York");
      await f.w.handle(plainRequest(f.ids));
      const message = await readMessage(transport.sent[0]!.raw);
      expect(message.lines).toEqual(expect.arrayContaining(["DTSTART:20261116T140000Z", "DTEND:20261116T150000Z"]));
    });

    it("writes an all-day Event with DATE values and an exclusive end, a multi-day one through its last day", async () => {
      const single = await invitedEvent({ timeFrom: null, timeTo: null });
      await single.w.handle(plainRequest(single.ids));
      const multi = await invitedEvent({ timeFrom: null, timeTo: null, endDate: "2026-11-18" });
      await multi.w.handle(plainRequest(multi.ids));

      const [first, second] = await Promise.all(transport.sent.map((sent) => readMessage(sent.raw)));
      expect(first?.lines).toEqual(
        expect.arrayContaining(["DTSTART;VALUE=DATE:20261116", "DTEND;VALUE=DATE:20261117"]),
      );
      expect(second?.lines).toEqual(
        expect.arrayContaining(["DTSTART;VALUE=DATE:20261116", "DTEND;VALUE=DATE:20261119"]),
      );
    });

    it("sends the sequence the Event has now, keeps the recorded reply and sets a new sentAt", async () => {
      const f = await invitedEvent(
        {},
        { status: "accepted", respondedAt: "2026-11-10T11:00:00Z", sentAt: "2026-11-10T10:00:00Z" },
      );
      await f.w.update("events", f.eventId, { timeFrom: "11:00", timeTo: "12:00" });
      const { icalSequence } = await f.w.storedEvent(f.eventId);
      expect(icalSequence).toBeGreaterThan(0);

      await f.w.runQueued();

      const message = await readMessage(transport.sent[0]!.raw);
      expect(message.lines).toEqual(expect.arrayContaining([`SEQUENCE:${icalSequence}`, "DTSTART:20261116T100000Z"]));
      const invitation = z
        .object({ invitation: z.record(z.string(), z.unknown()) })
        .parse(await f.w.edge(f.eventId, f.personId)).invitation;
      expect(invitation).toMatchObject({ status: "accepted", respondedAt: "2026-11-10T11:00:00Z" });
      expect(invitation.sentAt).not.toBe("2026-11-10T10:00:00Z");
    });

    it("writes the subject and the body in the language of the tenant's user, and Czech when it has no user", async () => {
      const czech = await invitedEvent();
      const czechTenant = world(await newTenant("cs"));
      const czechMailbox = await czechTenant.mailbox();
      const czechEvent = await czechTenant.event();
      const czechPerson = await czechTenant.person("Petr");
      await czechTenant.invite(czechEvent, czechPerson, czechMailbox);
      const noUserTenant = world(await newTenant(null));
      const noUserMailbox = await noUserTenant.mailbox();
      const noUserEvent = await noUserTenant.event();
      const noUserPerson = await noUserTenant.person("Petr");
      await noUserTenant.invite(noUserEvent, noUserPerson, noUserMailbox);

      await czech.w.handle(plainRequest(czech.ids));
      await czechTenant.handle(plainRequest({ eventId: czechEvent, personId: czechPerson, mailboxId: czechMailbox }));
      await noUserTenant.handle(
        plainRequest({ eventId: noUserEvent, personId: noUserPerson, mailboxId: noUserMailbox }),
      );

      const subjects = (await Promise.all(transport.sent.map((sent) => readMessage(sent.raw)))).map((m) => m.subject);
      expect(subjects).toEqual(["Invitation: Client meeting", "Pozvánka: Client meeting", "Pozvánka: Client meeting"]);
    });

    it("keeps a title with a line break on one line in the subject", async () => {
      const f = await invitedEvent({ name: "Line one\nline two" });
      await f.w.handle(plainRequest(f.ids));
      expect((await readMessage(transport.sent[0]!.raw)).subject).toBe("Invitation: Line one line two");
    });

    it("picks the transport of a Gmail mailbox by its provider's default mode when it has never synced", async () => {
      const w = world(await newTenant());
      const mailboxId = await w.mailbox("me@gmail.example", "gmail");
      const eventId = await w.event();
      const personId = await w.person("Petr");
      await w.invite(eventId, personId, mailboxId);
      const modes: Array<[string, string]> = [];
      setEventInvitationDelivery({
        pool: dataPool,
        transports: {
          async forMailbox(id, mode) {
            modes.push([id, mode]);
            return transport;
          },
        },
      });
      await w.handle(plainRequest({ eventId, personId, mailboxId }));
      expect(modes).toEqual([[mailboxId, "gmail_api"]]);
    });

    describe("failures", () => {
      it("rethrows a transient transport failure so the queue retries, leaving the invitation pending without sentAt and the job queued", async () => {
        const f = await invitedEvent();
        setEventInvitationDelivery({
          pool: dataPool,
          transports: transportFor({ send: () => Promise.reject(new Error("connection reset")) }),
        });
        await f.w.enqueue({ ...plainRequest(f.ids), sequence: 0 });

        await f.w.runQueued();

        expect(await f.w.edge(f.eventId, f.personId)).toEqual({
          invitation: { status: "pending", email: ATTENDEE, mailboxId: f.mailboxId },
        });
        const [job] = await queuedJobs();
        expect(job).toMatchObject({ attempts: 1, runsLater: true });
        expect(job?.lastError).toContain("connection reset");

        // The retry finds a working transport: the same payload sends once and marks the invitation.
        setEventInvitationDelivery({ pool: dataPool, transports: transportFor(transport) });
        await f.w.handle(plainRequest(f.ids));
        expect(transport.sent).toHaveLength(1);
        expect((await f.w.edge(f.eventId, f.personId))?.invitation).toHaveProperty("sentAt");
      });

      it("rethrows a failure of the transport factory that is neither a validation failure nor an unavailable transport", async () => {
        const f = await invitedEvent();
        setEventInvitationDelivery({
          pool: dataPool,
          transports: { forMailbox: () => Promise.reject(new Error("connection terminated")) },
        });
        await expect(f.w.handle(plainRequest(f.ids))).rejects.toThrow("connection terminated");
        expect((await f.w.edge(f.eventId, f.personId))?.invitation).not.toHaveProperty("sentAt");
      });

      it("ends with the noTransport reason, without a retry, for a Gmail mailbox in a root with no OAuth client", async () => {
        const w = world(await newTenant());
        const mailboxId = await w.mailbox("me@example.com", "gmail");
        const eventId = await w.event();
        const personId = await w.person("Petr");
        await w.invite(eventId, personId, mailboxId);
        // The production factory with the option set the API queue runtime passes when no OAuth client is configured.
        setEventInvitationDelivery({ pool: dataPool, transports: createMailTransportFactory(dataPool) });
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        await w.enqueue({ ...plainRequest({ eventId, personId, mailboxId }), sequence: 0 });

        await w.runQueued();

        expect(await queuedJobs()).toEqual([]);
        expect(warn.mock.calls.map(([fields]) => fields)).toEqual([
          { reason: "noTransport", method: "REQUEST", eventId, personId, mailboxId },
        ]);
        expect((await w.edge(eventId, personId))?.invitation).not.toHaveProperty("sentAt");
      });

      it("ends a CANCEL with the noTransport reason for a Microsoft Graph mailbox in a root with no OAuth client", async () => {
        const w = world(await newTenant());
        const mailboxId = await w.mailbox("me@example.com", "outlook");
        const snapshot: EventInvitationSnapshot = {
          uid: "u@semprec",
          sequence: 2,
          title: "Meeting",
          start: "2026-11-16T08:00:00.000Z",
          end: "2026-11-16T09:00:00.000Z",
          place: null,
          allDay: false,
        };
        setEventInvitationDelivery({ pool: dataPool, transports: createMailTransportFactory(dataPool) });
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        const ids = { eventId: randomUUID(), personId: randomUUID(), mailboxId };

        await w.handle({ method: "CANCEL", ...ids, attendeeEmail: ATTENDEE, snapshot });

        expect(warn.mock.calls.map(([fields]) => fields)).toEqual([
          { reason: "noTransport", method: "CANCEL", ...ids },
        ]);
      });

      it("rethrows a refused login, which the user can repair", async () => {
        const f = await invitedEvent();
        setEventInvitationDelivery({
          pool: dataPool,
          transports: transportFor({ send: () => Promise.reject(new MailSendAuthFailedError()) }),
        });
        await expect(f.w.handle(plainRequest(f.ids))).rejects.toBeInstanceOf(MailSendAuthFailedError);
      });

      it.each<[string, () => MailTransport | Error, string]>([
        ["a mailbox with no SMTP settings", () => new ValidationError("no smtp", { field: "smtp" }), "noTransport"],
        [
          "a transport the factory cannot build",
          () => new MailTransportUnavailableError("No Gmail OAuth client is configured"),
          "noTransport",
        ],
        [
          "a recipient the server refused",
          () => ({ send: () => Promise.reject(new MailRecipientRejectedError()) }),
          "recipientRejected",
        ],
      ])("ends with a reason code and no retry for %s", async (_label, make, reason) => {
        const f = await invitedEvent();
        const made = make();
        setEventInvitationDelivery({
          pool: dataPool,
          transports: made instanceof Error ? { forMailbox: () => Promise.reject(made) } : transportFor(made),
        });
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

        await f.w.handle(plainRequest(f.ids));

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toEqual({
          reason,
          method: "REQUEST",
          eventId: f.eventId,
          personId: f.personId,
          mailboxId: f.mailboxId,
        });
        expect((await f.w.edge(f.eventId, f.personId))?.invitation).not.toHaveProperty("sentAt");
      });

      it("ends without sending when the Event is trashed, and when it does not exist", async () => {
        const f = await invitedEvent();
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        await f.w.trash("events", f.eventId);
        await f.w.handle(plainRequest(f.ids));
        await f.w.handle(plainRequest({ ...f.ids, eventId: randomUUID() }));

        expect(transport.sent).toEqual([]);
        expect(warn.mock.calls.map(([fields]) => (fields as { reason: string }).reason)).toEqual([
          "eventTrashed",
          "eventMissing",
        ]);
      });

      it("ends without sending when the mailbox does not exist, is trashed or has no address", async () => {
        const f = await invitedEvent();
        const bare = await f.w.mailbox(null);
        const gone = await f.w.mailbox("gone@example.com");
        await f.w.trash("mailboxes", gone, SYSTEM_WRITER);
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

        await f.w.handle(plainRequest({ ...f.ids, mailboxId: randomUUID() }));
        await f.w.handle(plainRequest({ ...f.ids, mailboxId: gone }));
        await f.w.handle(plainRequest({ ...f.ids, mailboxId: bare }));

        expect(transport.sent).toEqual([]);
        expect(warn.mock.calls.map(([fields]) => (fields as { reason: string }).reason)).toEqual([
          "mailboxMissing",
          "mailboxMissing",
          "noMailboxAddress",
        ]);
      });

      it("ends without sending a message the builders refuse, and an Event that has no UID", async () => {
        const f = await invitedEvent();
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        await f.w.handle(plainRequest(f.ids, "not-an-address"));
        // A state the API cannot produce: an Event stored before the iCalendar identity existed has no UID.
        await adminPool.query("UPDATE items SET properties = properties - 'icalUid' WHERE id = $1", [f.eventId]);
        await f.w.handle(plainRequest(f.ids));

        expect(transport.sent).toEqual([]);
        expect(warn.mock.calls.map(([fields]) => (fields as { reason: string }).reason)).toEqual([
          "invalidMessage",
          "invalidMessage",
        ]);
      });

      /**
       * Makes the first `refusals` writes of a `sentAt` fail in the database, the way a lock timeout or a dropped
       * connection would. A sequence is not rolled back with the failing transaction, so it counts the attempts.
       */
      async function refuseSentAt(refusals: number): Promise<() => Promise<void>> {
        await adminPool.query("CREATE SEQUENCE refuse_sent_at_seq");
        await adminPool.query("GRANT USAGE ON SEQUENCE refuse_sent_at_seq TO PUBLIC");
        await adminPool.query(`
          CREATE FUNCTION refuse_sent_at() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.metadata -> 'invitation' ? 'sentAt' AND nextval('refuse_sent_at_seq') <= ${refusals} THEN
              RAISE EXCEPTION 'sentAt refused';
            END IF;
            RETURN NEW;
          END $$`);
        await adminPool.query(
          "CREATE TRIGGER refuse_sent_at BEFORE UPDATE ON item_relations FOR EACH ROW EXECUTE FUNCTION refuse_sent_at()",
        );
        return async () => {
          await adminPool.query("DROP TRIGGER refuse_sent_at ON item_relations");
          await adminPool.query("DROP FUNCTION refuse_sent_at()");
          await adminPool.query("DROP SEQUENCE refuse_sent_at_seq");
        };
      }

      it("fails the job when sentAt cannot be recorded after the message left, so the queue retries it, and logs the error name and ids only", async () => {
        const f = await invitedEvent();
        setEventInvitationDelivery({
          pool: dataPool,
          transports: transportFor(transport),
          sentAtRetryDelaysMs: [0, 0],
        });
        const error = vi.spyOn(logger, "error").mockImplementation(() => {});
        const undo = await refuseSentAt(1000);
        try {
          await expect(f.w.handle(plainRequest(f.ids))).rejects.toThrow("sentAt refused");
        } finally {
          await undo();
        }

        // Three attempts, each logged; the message left once in this run.
        expect(transport.sent).toHaveLength(1);
        expect(error.mock.calls.map(([fields]) => fields)).toEqual(
          [1, 2, 3].map((attempt) => ({
            errorName: expect.any(String),
            eventId: f.eventId,
            personId: f.personId,
            mailboxId: f.mailboxId,
            attempt,
            willRetry: attempt < 3,
          })),
        );
        expect((await f.w.edge(f.eventId, f.personId))?.invitation).not.toHaveProperty("sentAt");

        // The queue's retry sends again with the same UID and SEQUENCE and records sentAt.
        await f.w.handle(plainRequest(f.ids));
        expect(transport.sent).toHaveLength(2);
        const [first, second] = await Promise.all(transport.sent.map((sent) => readMessage(sent.raw)));
        expect(first?.lines.filter((line) => /^(UID|SEQUENCE):/.test(line))).toEqual(
          second?.lines.filter((line) => /^(UID|SEQUENCE):/.test(line)),
        );
        expect((await f.w.edge(f.eventId, f.personId))?.invitation).toHaveProperty("sentAt");
      });

      it("records sentAt on a later attempt when the first write fails, and the job succeeds with one message", async () => {
        const f = await invitedEvent();
        setEventInvitationDelivery({
          pool: dataPool,
          transports: transportFor(transport),
          sentAtRetryDelaysMs: [0, 0],
        });
        const error = vi.spyOn(logger, "error").mockImplementation(() => {});
        const undo = await refuseSentAt(1);
        try {
          await f.w.handle(plainRequest(f.ids));
        } finally {
          await undo();
        }

        expect(transport.sent).toHaveLength(1);
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, willRetry: true });
        expect((await f.w.edge(f.eventId, f.personId))?.invitation).toHaveProperty("sentAt");
      });

      it("ends the job with one message and a logged reason when the Person is trashed while the message was on its way, because retrying cannot change the refusal", async () => {
        const f = await invitedEvent();
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        const error = vi.spyOn(logger, "error").mockImplementation(() => {});
        const info = vi.spyOn(logger, "info").mockImplementation(() => {});
        let sends = 0;
        transport = recordingTransport({
          async send() {
            sends += 1;
            await f.w.trash("people", f.personId);
            return {};
          },
        });
        setEventInvitationDelivery({
          pool: dataPool,
          transports: transportFor(transport),
          sentAtRetryDelaysMs: [0, 0],
        });

        await expect(f.w.handle(plainRequest(f.ids))).resolves.toBeUndefined();

        // One message, no retry of the write, and the reason in the log: the queue would only send it again.
        expect(sends).toBe(1);
        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toEqual({
          errorName: expect.stringMatching(/^(Validation|NotFound)Error$/),
          reason: "sentAtRefused",
          eventId: f.eventId,
          personId: f.personId,
          mailboxId: f.mailboxId,
        });
        expect(info).toHaveBeenCalledTimes(1);
        // The edge of a trashed Person is not listed; once the Person is back it shows that nothing was marked.
        await f.w.restore("people", f.personId);
        expect((await f.w.edge(f.eventId, f.personId))?.invitation).not.toHaveProperty("sentAt");
      });

      describe("an Event changed while the message was on its way", () => {
        /** Sends through a transport that runs `during` while the message is in flight. */
        function sendingWhile(during: () => Promise<void>) {
          const recorder = recordingTransport();
          let ran = false;
          transport = {
            sent: recorder.sent,
            async send(message) {
              if (!ran) {
                ran = true;
                await during();
              }
              return recorder.send(message);
            },
          };
          setEventInvitationDelivery({ pool: dataPool, transports: transportFor(transport) });
        }

        it("queues the updated REQUEST for a person who had no sentAt when the Event moved, with the sequence it has now", async () => {
          const f = await invitedEvent();
          const sent = (await f.w.storedEvent(f.eventId)).icalSequence;
          sendingWhile(() => f.w.update("events", f.eventId, { timeFrom: "11:00", timeTo: "12:00" }));

          await f.w.handle(plainRequest(f.ids));

          const now = (await f.w.storedEvent(f.eventId)).icalSequence;
          expect(now).toBeGreaterThan(sent);
          // The update hook saw no sentAt and queued nothing; the write of sentAt queues the update in its place.
          expect((await queuedJobs()).map((job) => job.key)).toEqual([
            `event-invitation:${f.eventId}:${f.personId}:REQUEST:${now}`,
          ]);
          expect((await f.w.edge(f.eventId, f.personId))?.invitation).toHaveProperty("sentAt");

          // The queued job sends the new time.
          await f.w.runQueued();
          expect(transport.sent).toHaveLength(2);
          const second = await readMessage(transport.sent[1]!.raw);
          expect(second.lines).toEqual(expect.arrayContaining([`SEQUENCE:${now}`, "DTSTART:20261116T100000Z"]));
          expect(await queuedJobs()).toEqual([]);
        });

        it("queues nothing more when the invitation was declined, when the Event only changed its name, and when it was trashed", async () => {
          const declined = await invitedEvent({}, { status: "declined" });
          sendingWhile(() => declined.w.update("events", declined.eventId, { place: "Brno" }));
          await declined.w.handle(plainRequest(declined.ids));

          const renamed = await invitedEvent();
          sendingWhile(() => renamed.w.update("events", renamed.eventId, { name: "Other" }));
          await renamed.w.handle(plainRequest(renamed.ids));

          const trashed = await invitedEvent();
          sendingWhile(() => trashed.w.trash("events", trashed.eventId));
          await trashed.w.handle(plainRequest(trashed.ids));

          const jobs = (await queuedJobs()).map((job) => job.key);
          // Only the CANCEL the delete hook queued for the trashed Event.
          expect(jobs).toEqual([expect.stringContaining(`${trashed.eventId}:${trashed.personId}:CANCEL:`)]);
        });

        it("does not queue a second update when the edge already had sentAt, because the update hook queued it", async () => {
          const f = await invitedEvent({}, { sentAt: "2026-11-10T10:00:00Z" });
          sendingWhile(() => f.w.update("events", f.eventId, { timeFrom: "11:00", timeTo: "12:00" }));

          await f.w.handle(plainRequest(f.ids));

          const now = (await f.w.storedEvent(f.eventId)).icalSequence;
          expect((await queuedJobs()).map((job) => job.key)).toEqual([
            `event-invitation:${f.eventId}:${f.personId}:REQUEST:${now}`,
          ]);
        });
      });

      it("sends once and writes nothing when the edge was removed while the message was on its way", async () => {
        const f = await invitedEvent();
        const info = vi.spyOn(logger, "info").mockImplementation(() => {});
        transport = recordingTransport({
          async send() {
            await f.w.removeEdge(f.eventId, f.personId);
            return {};
          },
        });
        setEventInvitationDelivery({ pool: dataPool, transports: transportFor(transport) });

        await f.w.handle(plainRequest(f.ids));

        expect(transport.sent).toEqual([]);
        expect(info).toHaveBeenCalledTimes(1);
        expect(await f.w.edge(f.eventId, f.personId)).toBeNull();
      });

      it("refuses to run without bound dependencies, so the queue retries the job", async () => {
        const f = await invitedEvent();
        setEventInvitationDelivery(null);
        await expect(f.w.handle(plainRequest(f.ids))).rejects.toThrow(
          "No event invitation delivery is configured for this composition root",
        );
      });

      it("refuses a payload the task does not declare", async () => {
        const f = await invitedEvent();
        await expect(f.w.handle({ ...plainRequest(f.ids), extra: true })).rejects.toThrow();
        await expect(f.w.handle({ ...plainRequest(f.ids), method: "REPLY" })).rejects.toThrow();
        await expect(f.w.handle({ ...plainRequest(f.ids), method: "CANCEL" })).rejects.toThrow();
        expect(transport.sent).toEqual([]);
      });
    });

    it("answers another tenant's Event like an unknown one: nothing is sent", async () => {
      const a = await invitedEvent();
      const b = world(await newTenant());
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      await b.handle(plainRequest(a.ids));

      expect(transport.sent).toEqual([]);
      expect(warn.mock.calls.map(([fields]) => (fields as { reason: string }).reason)).toEqual(["eventMissing"]);
      expect((await a.w.edge(a.eventId, a.personId))?.invitation).not.toHaveProperty("sentAt");
    });
  });

  describe("sending a CANCEL", () => {
    it("sends METHOD:CANCEL with the same UID and the next sequence for each person when the Event is trashed, and writes nothing to the edges", async () => {
      const w = world(await newTenant());
      const mailboxId = await w.mailbox();
      const eventId = await w.event({ place: "Prague office" });
      const petr = await w.person("Petr");
      const jana = await w.person("Jana");
      await w.invite(eventId, petr, mailboxId, { sentAt: "2026-11-10T10:00:00Z" });
      await w.invite(eventId, jana, mailboxId, { email: "jana@example.com" });
      await w.update("events", eventId, { place: "Brno office" });
      await w.runQueued();
      transport.sent.length = 0;
      const stored = await w.storedEvent(eventId);
      const edgesBefore = await storedEdges(eventId);
      expect(edgesBefore).toHaveLength(2);

      await w.trash("events", eventId);
      await w.runQueued();

      expect(await queuedJobs()).toEqual([]);
      const messages = await Promise.all(transport.sent.map((sent) => readMessage(sent.raw)));
      expect(messages.flatMap((message) => message.to).sort()).toEqual(["jana@example.com", ATTENDEE]);
      for (const message of messages) {
        expect(message).toMatchObject({
          from: ["me@example.com"],
          subject: "Cancelled: Client meeting",
          method: "CANCEL",
        });
        expect(message.lines).toEqual(
          expect.arrayContaining([
            "METHOD:CANCEL",
            `UID:${stored.icalUid}`,
            `SEQUENCE:${stored.icalSequence + 1}`,
            "STATUS:CANCELLED",
            "LOCATION:Brno office",
            "DTSTART:20261116T080000Z",
          ]),
        );
      }
      expect(await storedEdges(eventId)).toEqual(edgesBefore);
    });

    it("still runs after the edge and the Event are gone, from the snapshot alone", async () => {
      const w = world(await newTenant());
      const mailboxId = await w.mailbox();
      const ids = { eventId: randomUUID(), personId: randomUUID(), mailboxId };
      const snapshot: EventInvitationSnapshot = {
        uid: "gone@semprec",
        sequence: 2,
        title: 'Gone, "really"',
        start: "2026-11-16",
        end: "2026-11-17",
        place: null,
        allDay: true,
      };
      await w.enqueue({ method: "CANCEL", ...ids, attendeeEmail: ATTENDEE, snapshot });

      await w.runQueued();

      expect(transport.sent).toHaveLength(1);
      const message = await readMessage(transport.sent[0]!.raw);
      expect(message.lines).toEqual(
        expect.arrayContaining([
          "METHOD:CANCEL",
          "UID:gone@semprec",
          "SEQUENCE:3",
          "DTSTART;VALUE=DATE:20261116",
          "DTEND;VALUE=DATE:20261117",
          'SUMMARY:Gone\\, "really"',
          "STATUS:CANCELLED",
        ]),
      );
      expect(message.lines.some((line) => line.startsWith("LOCATION"))).toBe(false);
    });

    it("sends a cancellation for a person removed from the Event while the Event is alive, after the edge is deleted", async () => {
      const w = world(await newTenant());
      const mailboxId = await w.mailbox();
      const eventId = await w.event();
      const personId = await w.person("Petr");
      await w.invite(eventId, personId, mailboxId);
      const stored = await w.storedEvent(eventId);
      const snapshot = await w.inTenant(async () => {
        const eventsId = await withTransaction(dataPool, async (client) => {
          const database = await databasesStore.getDatabaseByModuleId(client, "events");
          return database?.id ?? "";
        });
        return withTransaction(dataPool, async (client) => {
          const item = await getItemById(client, eventsId, eventId);
          return eventInvitationSnapshot(item!, "Europe/Prague");
        });
      });
      await w.removeEdge(eventId, personId);
      await w.enqueue({ method: "CANCEL", eventId, personId, mailboxId, attendeeEmail: ATTENDEE, snapshot });

      await w.runQueued();

      expect((await readMessage(transport.sent[0]!.raw)).lines).toEqual(
        expect.arrayContaining([
          `UID:${stored.icalUid}`,
          `SEQUENCE:${stored.icalSequence + 1}`,
          "DTSTART:20261116T080000Z",
        ]),
      );
      expect(await w.edge(eventId, personId)).toBeNull();
    });

    it("ends without sending when its mailbox is gone, and rethrows a transient failure so the queue retries", async () => {
      const w = world(await newTenant());
      const mailboxId = await w.mailbox();
      const base = {
        method: "CANCEL" as const,
        eventId: randomUUID(),
        personId: randomUUID(),
        attendeeEmail: ATTENDEE,
        snapshot: {
          uid: "u@semprec",
          sequence: 0,
          title: "T",
          start: "2026-11-16",
          end: "2026-11-17",
          place: null,
          allDay: true,
        },
      };
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      await w.handle({ ...base, mailboxId: randomUUID() });
      expect(transport.sent).toEqual([]);
      expect(warn.mock.calls.map(([fields]) => (fields as { reason: string }).reason)).toEqual(["mailboxMissing"]);

      setEventInvitationDelivery({
        pool: dataPool,
        transports: transportFor({ send: () => Promise.reject(new Error("timeout")) }),
      });
      await expect(w.handle({ ...base, mailboxId })).rejects.toThrow("timeout");
    });
  });

  describe("the Event's message data", () => {
    const base = {
      id: randomUUID(),
      databaseId: randomUUID(),
      createdAt: "",
      updatedAt: "",
      deletedAt: null,
      computed: {},
    };
    const eventRow = (properties: Record<string, unknown>) =>
      ({
        ...base,
        properties: { icalUid: "u@semprec", icalSequence: 1, name: "T", date: "2026-11-16", ...properties },
      }) as never;

    it("ends a timed Event that has no end time at the midnight that ends its last day", () => {
      // The Events rules give a timed Event an end time, so this is a stored state the API cannot produce.
      const snapshot = eventInvitationSnapshot(
        eventRow({ date: "2026-11-16", endDate: "2026-11-17", timeFrom: "09:00", timeTo: null }),
        "Europe/Prague",
      );
      expect(snapshot).toMatchObject({
        allDay: false,
        start: "2026-11-16T08:00:00.000Z",
        end: "2026-11-17T23:00:00.000Z",
      });
    });

    it("reads an unset or non-numeric sequence as 0", () => {
      expect(eventInvitationSnapshot(eventRow({ icalSequence: undefined }), "Europe/Prague").sequence).toBe(0);
      expect(eventInvitationSnapshot(eventRow({ icalSequence: "2" }), "Europe/Prague").sequence).toBe(0);
    });

    it.each<[string, Record<string, unknown>, string]>([
      ["no UID", { icalUid: null }, "icalUid"],
      ["no date", { date: null }, "date"],
      ["a date that is not a calendar date", { date: "16.11.2026" }, "date"],
      ["an all-day end date that does not exist", { endDate: "2026-02-31" }, "endDate"],
      ["a start time that is not a wall-clock time", { timeFrom: "9am" }, "time"],
      ["a date that does not exist on a timed Event", { date: "2026-02-31", timeFrom: "09:00" }, "date"],
    ])("refuses an Event with %s as validation_failed", (_label, properties, field) => {
      expect(() => eventInvitationSnapshot(eventRow(properties), "Europe/Prague")).toThrowError(
        expect.objectContaining({ status: 400, code: "validation_failed", details: { field } }),
      );
    });
  });
});

/** The stored metadata of every invitation edge of the item, read on the admin pool because a trashed Event hides its edges from the choke point. */
async function storedEdges(itemId: string): Promise<unknown[]> {
  const { rows } = await adminPool.query<{ metadata: unknown }>(
    "SELECT metadata FROM item_relations WHERE (item_a = $1 OR item_b = $1) AND metadata ? 'invitation' ORDER BY metadata::text",
    [itemId],
  );
  return rows.map((row) => row.metadata);
}

async function databaseIdOf(w: World, moduleId: string): Promise<string> {
  const database = await w.inTenant(() =>
    withTransaction(dataPool, (client) => databasesStore.getDatabaseByModuleId(client, moduleId)),
  );
  if (!database) throw new Error(`No ${moduleId} database`);
  return database.id;
}

/** The jobs of the task the open transaction can see, its own uncommitted ones included. */
async function jobsInTransaction(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE task_identifier = $1",
    [TASK],
  );
  return Number(rows[0]?.count);
}
