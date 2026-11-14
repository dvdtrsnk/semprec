import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runOnce } from "@semprec/queue";
import { runInTenant } from "@semprec/shared";
import "../../domainWriteHooks.js";
import { withTransaction } from "../../db/pool.js";
import { ChokePointError } from "../../errors.js";
import { parseAddressListProperty } from "../../mail/addressListParsing.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { ingestEmailMessage } from "../../mail/ingest.js";
import { reindexPersonEmails } from "../../mail/personEmailIndexStore.js";
import { createActionRegistry, type ActionHandler } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  setupMailAttachmentWorld,
  USER,
  type MailAttachmentWorld as World,
} from "../../testSupport/mailAttachmentFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createCoreTaskList } from "../../worker.js";
import { CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID, createInvitationReplyAction } from "../invitationReplyAction.js";
import { logger } from "../logger.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let other: string;

/** A marker in the content of the calendar parts below that must never reach a log line. */
const SECRET = "CONFIDENTIAL-MARKER";
const PETR = "petr@example.test";
const UID_PREFIX = "reply-uid";

interface Store {
  storage: BlobStorageWriter;
  /** The storage keys `readStream` was asked for. */
  reads: string[];
}

/** A storage that keeps the bytes it was given, so the action reads back what mail ingest wrote. */
function memoryStore(): Store {
  const blobs = new Map<string, Buffer>();
  const store: Store = {
    reads: [],
    storage: {
      async writeStream(storageKey, source) {
        const chunks: Buffer[] = [];
        for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        const bytes = Buffer.concat(chunks);
        blobs.set(storageKey, bytes);
        return { byteSize: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") };
      },
      async delete(storageKey) {
        blobs.delete(storageKey);
      },
      readStream(storageKey) {
        store.reads.push(storageKey);
        const bytes = blobs.get(storageKey);
        if (!bytes) throw new Error(`No blob under ${storageKey}`);
        return Readable.from([bytes]);
      },
    },
  };
  return store;
}

let store: Store;

interface IcsOptions {
  method?: string | null;
  uid: string;
  sequence?: number;
  /** The `ATTENDEE` lines as `[address, PARTSTAT]`; one accepting `PETR` unless given. */
  attendees?: Array<[string, string]>;
  recurrenceId?: boolean;
  summary?: string;
}

/** The text of an iMIP calendar part: one VEVENT with the given `ATTENDEE` lines. */
function ics(options: IcsOptions): string {
  const method = options.method === undefined ? "REPLY" : options.method;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...(method === null ? [] : [`METHOD:${method}`]),
    "BEGIN:VEVENT",
    `UID:${options.uid}`,
    `SEQUENCE:${options.sequence ?? 0}`,
    `SUMMARY:${options.summary ?? "Sprint review"}`,
    "DTSTART:20261120T090000Z",
    ...(options.recurrenceId ? ["RECURRENCE-ID:20261120T090000Z"] : []),
    "ORGANIZER;CN=Me:mailto:me@example.test",
    ...(options.attendees ?? [[PETR, "ACCEPTED"]]).map(
      ([address, partStat]) => `ATTENDEE;CN=Someone;PARTSTAT=${partStat}:mailto:${address}`,
    ),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/** A message that arrives through the sync writer from `from` with `parts` as its attachments; returns its Emails item id. */
async function receive(
  world: World,
  messageId: string,
  parts: string[],
  options: { from?: string; isDsn?: boolean } = {},
): Promise<string> {
  const result = await runInTenant(world.tenantId, () =>
    withTransaction(runtime, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: world.databases.emails!,
        filesDatabaseId: world.databases.files!,
        folderRelationPropertyId: world.properties.emailFolder,
        attachmentsRelationPropertyId: world.properties.emailAttachments,
        mailboxItemId: world.inbox.mailboxId,
        folderItemId: world.inbox.folderId,
        messageId,
        subject: `Subject of ${messageId}`,
        bodyText: `body of ${messageId}`,
        envelope: { from: { name: "Sender", address: options.from ?? PETR }, to: [{ address: "me@example.test" }] },
        attachments: parts.map((text, index) => ({
          filename: `part-${index}.ics`,
          contentType: "text/calendar",
          contentId: null,
          disposition: "inline" as const,
          openStream: () => Readable.from([Buffer.from(text)]),
        })),
        storage: store.storage,
        storageKeyPrefix: "invitation-reply",
        isDsn: options.isDsn,
      }),
    ),
  );
  return result.itemId;
}

function configOf(world: World): Record<string, unknown> {
  return {
    emailsDatabaseId: world.databases.emails,
    eventsDatabaseId: world.databases.events,
    peopleDatabaseId: world.databases.people,
  };
}

function actionFor(storage: BlobStorageWriter = store.storage): ActionHandler {
  return createInvitationReplyAction(runtime, { storage });
}

/** Fires the heartbeat action for `emailItemId` the way a heartbeat for the Emails database does, in the tenant of `world`. */
function apply(world: World, emailItemId: string, config: Record<string, unknown> = configOf(world)): Promise<void> {
  return runInTenant(world.tenantId, () =>
    actionFor()(config, { heartbeatId: "test", projectItemId: "test", itemId: emailItemId }),
  );
}

const edgeSchema = z.array(z.object({ targetItemId: z.string(), metadata: z.record(z.string(), z.unknown()) }));

/** The fixture rows of one tenant, all written through the choke point as production writes them. */
function fixtureOf(world: World) {
  const inTenant = <T>(fn: () => Promise<T>) => runInTenant(world.tenantId, fn);
  const peopleProperty = async (): Promise<string> => {
    const property = (await world.cp.listProperties(world.databases.events!)).find((entry) => entry.key === "people");
    if (!property) throw new Error("Missing Events.people");
    return property.id;
  };
  return {
    /** A live Event; its `icalUid` is assigned by the Events create hook. */
    event: (): Promise<{ id: string; uid: string }> =>
      inTenant(async () => {
        const created = await world.cp.createItem({
          databaseId: world.databases.events!,
          properties: { name: "Sprint review", date: "2026-11-20" },
        });
        const uid = created.properties.icalUid;
        if (typeof uid !== "string") throw new Error("The Event has no icalUid");
        return { id: created.id, uid };
      }),
    /** A person whose addresses are in the address index, as the reindex heartbeat leaves them. */
    person: (name: string, emails: string) =>
      inTenant(async () => {
        const created = await world.cp.createItem({
          databaseId: world.databases.people!,
          properties: { name, emails },
        });
        await withTransaction(runtime, (client) =>
          reindexPersonEmails(client, created.id, parseAddressListProperty(emails)),
        );
        return created.id;
      }),
    /** An edge written with the system writer kind, the way the invitation code writes one. */
    invite: (eventId: string, personId: string, invitation: Record<string, unknown>, role?: "attendee") =>
      inTenant(async () => {
        await world.cp.createRelation({
          relationPropertyId: await peopleProperty(),
          callerItemId: eventId,
          targetItemId: personId,
          metadata: { ...(role === undefined ? {} : { role }), invitation },
        });
      }),
    /** A plain participant edge, the way a user links a person. */
    link: (eventId: string, personId: string) =>
      inTenant(async () => {
        await world.cp.createRelation(
          { relationPropertyId: await peopleProperty(), callerItemId: eventId, targetItemId: personId },
          USER,
        );
      }),
    /** The stored edges of the Event by person id. */
    edges: (eventId: string) =>
      inTenant(async () => {
        const edges = edgeSchema.parse(await world.cp.listItemRelations(eventId, await peopleProperty()));
        return new Map(edges.map((edge) => [edge.targetItemId, edge.metadata]));
      }),
    peopleProperty: () => inTenant(peopleProperty),
  };
}

type Fixture = ReturnType<typeof fixtureOf>;

/** The invitation an Event's edge carries before any answer. */
function pending(world: World, email = PETR): Record<string, unknown> {
  return { status: "pending", email, mailboxId: world.inbox.mailboxId, sentAt: "2026-11-14T08:00:00.000Z" };
}

/** Every argument that the spied logger methods were called with, as text. */
function loggedText(...spies: Array<{ mock: { calls: unknown[][] } }>): string {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
}

describe("calendar.applyInvitationReply (issue gh-1950)", () => {
  let world: World;
  let otherWorld: World;
  let f: Fixture;

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    other = await createTestTenant(admin);
    for (const id of [tenant, other]) await runInTenant(id, () => seedSystem(runtime));
    world = await setupMailAttachmentWorld(runtime, tenant);
    otherWorld = await setupMailAttachmentWorld(runtime, other);
    f = fixtureOf(world);
    store = memoryStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  /** An Event with `PETR` invited, and the id of Petr. */
  async function invitedPetr(): Promise<{ event: { id: string; uid: string }; petr: string }> {
    const event = await f.event();
    const petr = await f.person("Petr", PETR);
    await f.invite(event.id, petr, pending(world), "attendee");
    return { event, petr };
  }

  it("is fired by the seeded heartbeat of a new Emails item and applies the answer from the queued job", async () => {
    const { event, petr } = await invitedPetr();
    const registry = createActionRegistry();
    registry.set(CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID, actionFor());
    await receive(world, "<heartbeat@example.test>", [ics({ uid: event.uid })]);
    expect((await f.edges(event.id)).get(petr)).toMatchObject({ invitation: { status: "pending" } });

    await runOnce({ pgPool: runtime, taskList: createCoreTaskList(runtime, registry) });

    expect((await f.edges(event.id)).get(petr)).toMatchObject({ invitation: { status: "accepted" } });
  });

  describe("an answer from the invited person's own address", () => {
    it.each([
      ["ACCEPTED", "accepted"],
      ["TENTATIVE", "tentative"],
      ["DECLINED", "declined"],
    ])("sets %s as %s with respondedAt and keeps the rest of the edge", async (partStat, status) => {
      const { event, petr } = await invitedPetr();
      const before = Date.now();

      await apply(
        world,
        await receive(world, "<answer@example.test>", [ics({ uid: event.uid, attendees: [[PETR, partStat]] })]),
      );

      const edges = await f.edges(event.id);
      expect(edges.size).toBe(1);
      const metadata = edges.get(petr);
      expect(metadata).toEqual({
        role: "attendee",
        invitation: {
          status,
          email: PETR,
          mailboxId: world.inbox.mailboxId,
          sentAt: "2026-11-14T08:00:00.000Z",
          respondedAt: expect.any(String),
        },
      });
      const respondedAt = z.object({ invitation: z.object({ respondedAt: z.iso.datetime() }) }).parse(metadata)
        .invitation.respondedAt;
      expect(Date.parse(respondedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(respondedAt)).toBeLessThanOrEqual(Date.now());
    });

    it("matches the sender and the attendee address in any letter case", async () => {
      const { event, petr } = await invitedPetr();
      const text = ics({ uid: event.uid, attendees: [["PETR@Example.Test", "DECLINED"]] });
      await apply(world, await receive(world, "<case@example.test>", [text], { from: "Petr@EXAMPLE.test" }));
      expect((await f.edges(event.id)).get(petr)).toMatchObject({ invitation: { status: "declined" } });
    });

    it("applies an answer from another address of the invited person", async () => {
      const event = await f.event();
      const petr = await f.person("Petr", `${PETR}, petr.home@example.test`);
      await f.invite(event.id, petr, pending(world));
      const text = ics({ uid: event.uid, attendees: [["petr.home@example.test", "ACCEPTED"]] });
      await apply(world, await receive(world, "<home@example.test>", [text], { from: "petr.home@example.test" }));
      expect((await f.edges(event.id)).get(petr)).toMatchObject({ invitation: { status: "accepted" } });
    });

    it("applies the answer of the sender only, leaving another invited attendee of the same message unchanged", async () => {
      const { event, petr } = await invitedPetr();
      const karel = await f.person("Karel", "karel@example.test");
      await f.invite(event.id, karel, pending(world, "karel@example.test"));
      const text = ics({
        uid: event.uid,
        attendees: [
          [PETR, "ACCEPTED"],
          ["karel@example.test", "DECLINED"],
        ],
      });

      await apply(world, await receive(world, "<two@example.test>", [text]));

      const edges = await f.edges(event.id);
      expect(edges.get(petr)).toMatchObject({ invitation: { status: "accepted" } });
      expect(edges.get(karel)).toEqual({ invitation: pending(world, "karel@example.test") });
    });

    it("lets the latest answer win whatever its SEQUENCE", async () => {
      const { event, petr } = await invitedPetr();
      await apply(world, await receive(world, "<first@example.test>", [ics({ uid: event.uid, sequence: 4 })]));
      await apply(
        world,
        await receive(world, "<second@example.test>", [
          ics({ uid: event.uid, sequence: 1, attendees: [[PETR, "DECLINED"]] }),
        ]),
      );
      expect((await f.edges(event.id)).get(petr)).toMatchObject({ invitation: { status: "declined" } });
    });
  });

  describe("an answer that changes nothing", () => {
    /** The edges before and after `apply` of a message made of `parts` from `from`. */
    async function expectUntouched(
      event: { id: string },
      parts: string[],
      options: { from?: string; isDsn?: boolean } = {},
    ): Promise<void> {
      const before = await f.edges(event.id);
      await apply(world, await receive(world, `<untouched-${Math.random()}@example.test>`, parts, options));
      expect(await f.edges(event.id)).toEqual(before);
    }

    it("ignores an answer whose sender differs from the attendee address", async () => {
      const { event } = await invitedPetr();
      await expectUntouched(event, [ics({ uid: event.uid })], { from: "mallory@example.test" });
    });

    it("ignores an answer from a sender that is another invited person's address, naming the first person", async () => {
      const { event } = await invitedPetr();
      const karel = await f.person("Karel", "karel@example.test");
      await f.invite(event.id, karel, pending(world, "karel@example.test"));
      await expectUntouched(event, [ics({ uid: event.uid })], { from: "karel@example.test" });
    });

    it("ignores a message that has no sender address", async () => {
      const { event } = await invitedPetr();
      const emailId = await receive(world, "<nosender@example.test>", [ics({ uid: event.uid })]);
      // A message without `envelope.from` cannot be produced by ingest, so the stored envelope is edited (raw SQL).
      await admin.query("UPDATE mail_message_meta SET envelope = '{}'::jsonb WHERE item_id = $1", [emailId]);
      const before = await f.edges(event.id);
      await apply(world, emailId);
      expect(await f.edges(event.id)).toEqual(before);
    });

    it("ignores an unknown UID", async () => {
      const { event } = await invitedPetr();
      await expectUntouched(event, [ics({ uid: `${UID_PREFIX}-unknown@semprec` })]);
    });

    it("ignores a UID that belongs to a trashed Event", async () => {
      const { event, petr } = await invitedPetr();
      const stored = (await f.edges(event.id)).get(petr);
      await runInTenant(tenant, () => world.cp.softDeleteItem(world.databases.events!, event.id));
      await apply(world, await receive(world, "<trashed-event@example.test>", [ics({ uid: event.uid })]));
      // The edges of a trashed Event are not listed through the choke point, so the stored edge is read directly.
      const { rows } = await admin.query<{ metadata: unknown }>(
        "SELECT metadata FROM item_relations WHERE (item_a = $1 OR item_b = $1) AND metadata ? 'invitation'",
        [event.id],
      );
      expect(rows).toEqual([{ metadata: stored }]);
    });

    it("ignores a UID that two live Events share", async () => {
      const { event, petr } = await invitedPetr();
      const twin = await f.event();
      // The create hook assigns every Event its own UID and the property is system-owned, so sharing one takes raw SQL.
      await admin.query(
        "UPDATE items SET properties = jsonb_set(properties, '{icalUid}', to_jsonb($1::text)) WHERE id = $2",
        [event.uid, twin.id],
      );
      // The same person is invited to both, so an unguarded lookup that picked either Event would change its edge.
      await f.invite(twin.id, petr, pending(world), "attendee");
      const twinBefore = await f.edges(twin.id);
      expect(twinBefore.get(petr)).toEqual({ role: "attendee", invitation: pending(world) });
      await expectUntouched(event, [ics({ uid: event.uid })]);
      expect(await f.edges(twin.id)).toEqual(twinBefore);
    });

    it("ignores an address that belongs to no person", async () => {
      const { event } = await invitedPetr();
      await expectUntouched(event, [ics({ uid: event.uid, attendees: [["stranger@example.test", "ACCEPTED"]] })], {
        from: "stranger@example.test",
      });
    });

    it("ignores a person who is in the trash", async () => {
      const { event, petr } = await invitedPetr();
      await runInTenant(tenant, () => world.cp.softDeleteItem(world.databases.people!, petr));
      await expectUntouched(event, [ics({ uid: event.uid })]);
    });

    it("ignores a person who is linked to the Event without an invitation, and does not give them one", async () => {
      const event = await f.event();
      const petr = await f.person("Petr", PETR);
      await f.link(event.id, petr);
      await expectUntouched(event, [ics({ uid: event.uid })]);
      expect((await f.edges(event.id)).get(petr)).toEqual({});
    });

    it("ignores a person who is not linked to the Event, and does not link them", async () => {
      const event = await f.event();
      await f.person("Petr", PETR);
      await expectUntouched(event, [ics({ uid: event.uid })]);
      expect((await f.edges(event.id)).size).toBe(0);
    });

    it.each(["NEEDS-ACTION", "DELEGATED", "IN-PROCESS", "X-OTHER"])("ignores PARTSTAT=%s", async (partStat) => {
      const { event } = await invitedPetr();
      await expectUntouched(event, [ics({ uid: event.uid, attendees: [[PETR, partStat]] })]);
    });

    it("ignores an ATTENDEE without a PARTSTAT", async () => {
      const { event } = await invitedPetr();
      const text = ics({ uid: event.uid }).replace(";PARTSTAT=ACCEPTED", "");
      expect(text).not.toContain("PARTSTAT");
      await expectUntouched(event, [text]);
    });

    it.each(["REQUEST", "CANCEL", "PUBLISH", null])("ignores a calendar with METHOD %s", async (method) => {
      const { event } = await invitedPetr();
      await expectUntouched(event, [ics({ uid: event.uid, method })]);
    });

    it("ignores the answer to one occurrence of a series", async () => {
      const { event } = await invitedPetr();
      await expectUntouched(event, [ics({ uid: event.uid, recurrenceId: true })]);
    });

    it("ignores a message without a calendar part", async () => {
      const { event } = await invitedPetr();
      await expectUntouched(event, []);
    });

    it("ignores a delivery status notification before it reads any part", async () => {
      const { event } = await invitedPetr();
      await expectUntouched(event, [ics({ uid: event.uid })], { isDsn: true });
      expect(store.reads).toEqual([]);
    });

    it("ignores a malformed calendar part without failing and logs a reason code only", async () => {
      const warn = vi.spyOn(logger, "warn");
      const { event } = await invitedPetr();
      const emailId = await receive(world, "<malformed@example.test>", [`BEGIN:VCALENDAR\r\n${SECRET}\r\n`]);
      await apply(world, emailId);
      expect((await f.edges(event.id)).size).toBe(1);
      expect(warn).toHaveBeenCalledWith({ emailItemId: emailId, reason: "malformed" }, expect.any(String));
      expect(loggedText(warn)).not.toContain(SECRET);
    });

    it("ignores an Emails item that has no message record", async () => {
      const { event } = await invitedPetr();
      const emailId = await receive(world, "<gone-meta@example.test>", [ics({ uid: event.uid })]);
      // An Emails item that mail ingest did not write has no `mail_message_meta` row; removing it reproduces that.
      await admin.query("DELETE FROM mail_message_meta WHERE item_id = $1", [emailId]);
      const before = await f.edges(event.id);
      await apply(world, emailId);
      expect(await f.edges(event.id)).toEqual(before);
    });

    it("ignores an email that was trashed before the action ran", async () => {
      const { event } = await invitedPetr();
      const emailId = await receive(world, "<trashed-mail@example.test>", [ics({ uid: event.uid })]);
      await runInTenant(tenant, () => world.cp.softDeleteItem(world.databases.emails!, emailId));
      const before = await f.edges(event.id);
      await apply(world, emailId);
      expect(await f.edges(event.id)).toEqual(before);
    });

    it("does nothing when the heartbeat fired for no item", async () => {
      const { event } = await invitedPetr();
      const before = await f.edges(event.id);
      await runInTenant(tenant, () => actionFor()(configOf(world), { heartbeatId: "test", projectItemId: "test" }));
      expect(await f.edges(event.id)).toEqual(before);
    });

    it("fails on a malformed action config and writes nothing", async () => {
      const { event } = await invitedPetr();
      const emailId = await receive(world, "<bad-config@example.test>", [ics({ uid: event.uid })]);
      const before = await f.edges(event.id);
      await expect(apply(world, emailId, { emailsDatabaseId: world.databases.emails })).rejects.toThrow(
        /Malformed action config for calendar\.applyInvitationReply/,
      );
      expect(await f.edges(event.id)).toEqual(before);
    });
  });

  describe("processing the same email twice", () => {
    it("leaves the state of the first run, respondedAt included", async () => {
      const { event, petr } = await invitedPetr();
      const emailId = await receive(world, "<twice@example.test>", [ics({ uid: event.uid })]);

      await apply(world, emailId);
      const afterFirst = await f.edges(event.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await apply(world, emailId);

      expect(await f.edges(event.id)).toEqual(afterFirst);
      expect(afterFirst.get(petr)).toMatchObject({ invitation: { status: "accepted" } });
    });

    it("keeps the respondedAt of the first answer when a later, different email repeats the same status", async () => {
      const { event, petr } = await invitedPetr();
      await apply(world, await receive(world, "<first-accept@example.test>", [ics({ uid: event.uid })]));
      const afterFirst = await f.edges(event.id);
      await new Promise((resolve) => setTimeout(resolve, 5));

      await apply(world, await receive(world, "<second-accept@example.test>", [ics({ uid: event.uid, sequence: 3 })]));

      expect(await f.edges(event.id)).toEqual(afterFirst);
      expect(afterFirst.get(petr)).toMatchObject({ invitation: { status: "accepted" } });
    });

    it("moves respondedAt when a later email changes the status", async () => {
      const { event, petr } = await invitedPetr();
      await apply(world, await receive(world, "<accept-first@example.test>", [ics({ uid: event.uid })]));
      const respondedAtOf = async (): Promise<string> =>
        z.object({ invitation: z.object({ respondedAt: z.iso.datetime() }) }).parse((await f.edges(event.id)).get(petr))
          .invitation.respondedAt;
      const first = await respondedAtOf();
      await new Promise((resolve) => setTimeout(resolve, 5));

      await apply(
        world,
        await receive(world, "<then-decline@example.test>", [ics({ uid: event.uid, attendees: [[PETR, "DECLINED"]] })]),
      );

      expect(Date.parse(await respondedAtOf())).toBeGreaterThan(Date.parse(first));
      expect((await f.edges(event.id)).get(petr)).toMatchObject({ invitation: { status: "declined" } });
    });
  });

  describe("the invitation this action wrote", () => {
    it("survives a public edge write that repeats it, and a public write that changes it is refused", async () => {
      const { event, petr } = await invitedPetr();
      await apply(world, await receive(world, "<answered@example.test>", [ics({ uid: event.uid })]));
      const stored = (await f.edges(event.id)).get(petr);
      const invitation = z.object({ invitation: z.record(z.string(), z.unknown()) }).parse(stored).invitation;
      const propertyId = await f.peopleProperty();
      const publicWrite = (metadata: Record<string, unknown>) =>
        runInTenant(tenant, () =>
          world.cp.updateRelation(
            { relationPropertyId: propertyId, callerItemId: event.id, targetItemId: petr, metadata },
            USER,
          ),
        );

      // The allowed side: a user changes only the role and sends the stored invitation back.
      await publicWrite({ role: "attendee", invitation });
      expect((await f.edges(event.id)).get(petr)).toEqual(stored);

      // The refused side: a user cannot move the status the action set.
      const refusal = await publicWrite({ role: "attendee", invitation: { ...invitation, status: "declined" } }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(ChokePointError);
      expect(refusal).toMatchObject({ details: { field: "metadata", reason: "invitationReadOnly" } });
      expect((await f.edges(event.id)).get(petr)).toEqual(stored);
    });
  });

  describe("logs", () => {
    it("carry the email item id and a reason code, never an address or calendar content", async () => {
      const info = vi.spyOn(logger, "info");
      const warn = vi.spyOn(logger, "warn");
      const { event } = await invitedPetr();
      const applied = await receive(world, "<log-applied@example.test>", [ics({ uid: event.uid, summary: SECRET })]);
      const mismatch = await receive(world, "<log-mismatch@example.test>", [ics({ uid: event.uid, summary: SECRET })], {
        from: "mallory@example.test",
      });
      await apply(world, applied);
      await apply(world, mismatch);

      expect(info).toHaveBeenCalledWith({ emailItemId: applied }, "calendar invitation reply applied");
      expect(info).toHaveBeenCalledWith(
        { emailItemId: mismatch, reason: "sender_mismatch" },
        "calendar invitation reply ignored",
      );
      const text = loggedText(info, warn);
      for (const forbidden of [SECRET, PETR, "mallory@example.test", event.uid]) expect(text).not.toContain(forbidden);
    });
  });

  describe("tenant isolation", () => {
    it("cannot reach the Events of another tenant with its own tenant's message, person and a UID it knows", async () => {
      const { event, petr } = await invitedPetr();
      const before = await f.edges(event.id);
      // The other tenant has a person with the same address and receives a reply that names this tenant's UID.
      const theirPetr = await fixtureOf(otherWorld).person("Petr", PETR);
      const theirs = await receive(otherWorld, "<theirs@example.test>", [ics({ uid: event.uid })]);

      await apply(otherWorld, theirs);

      expect(await f.edges(event.id)).toEqual(before);
      expect(before.get(petr)).toMatchObject({ invitation: { status: "pending" } });
      expect(theirPetr).not.toBe(petr);
    });

    it("does nothing when the action of one tenant names the Emails item and databases of another", async () => {
      const foreignFixture = fixtureOf(otherWorld);
      const foreignEvent = await foreignFixture.event();
      const foreignPetr = await foreignFixture.person("Petr", PETR);
      await foreignFixture.invite(foreignEvent.id, foreignPetr, pending(otherWorld));
      const foreignEmail = await receive(otherWorld, "<foreign@example.test>", [ics({ uid: foreignEvent.uid })]);

      // The action runs in the scope of `tenant` but names the Emails item and databases of `other`.
      await apply(world, foreignEmail, configOf(otherWorld));

      expect((await foreignFixture.edges(foreignEvent.id)).get(foreignPetr)).toEqual({
        invitation: pending(otherWorld),
      });
    });

    it("applies the answer in its own tenant when both tenants have an Event, a person and a reply of their own", async () => {
      const mine = await invitedPetr();
      const foreignFixture = fixtureOf(otherWorld);
      const theirEvent = await foreignFixture.event();
      const theirPetr = await foreignFixture.person("Petr", PETR);
      await foreignFixture.invite(theirEvent.id, theirPetr, pending(otherWorld));

      await apply(world, await receive(world, "<mine@example.test>", [ics({ uid: mine.event.uid })]));

      expect((await f.edges(mine.event.id)).get(mine.petr)).toMatchObject({ invitation: { status: "accepted" } });
      expect((await foreignFixture.edges(theirEvent.id)).get(theirPetr)).toEqual({ invitation: pending(otherWorld) });
    });
  });
});
