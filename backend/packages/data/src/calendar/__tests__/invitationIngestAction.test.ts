import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runOnce } from "@semprec/queue";
import { runInTenant } from "@semprec/shared";
import "../../domainWriteHooks.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { withTransaction } from "../../db/pool.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { ingestEmailMessage } from "../../mail/ingest.js";
import { createActionRegistry, type ActionHandler } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  setupMailAttachmentWorld,
  type MailAttachmentWorld as World,
} from "../../testSupport/mailAttachmentFixtures.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { createCoreTaskList } from "../../worker.js";
import { CALENDAR_MODULE_ID } from "../calendarModuleId.js";
import { readCalendarPartsOfEmail } from "../emailCalendarParts.js";
import { ICALENDAR_MAX_BYTES } from "../icalendarParser.js";
import { CALENDAR_INGEST_INVITATION_ACTION_ID, createInvitationIngestAction } from "../invitationIngestAction.js";
import { logger } from "../logger.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let other: string;

/** A marker that appears in the content of the calendar parts below and must never reach a log line. */
const SECRET = "CONFIDENTIAL-MARKER";

interface Part {
  contentType: string;
  text: string;
}

interface Store {
  storage: BlobStorageWriter;
  /** The storage keys `readStream` was asked for. */
  reads: string[];
  /** Replaces what `readStream` returns for the keys that `override` answers. */
  override: { replace?: (storageKey: string) => Readable | undefined };
}

/** A storage that keeps the bytes it was given, so the action reads back what mail ingest wrote. */
function memoryStore(): Store {
  const blobs = new Map<string, Buffer>();
  const store: Store = {
    reads: [],
    override: {},
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
        const replaced = store.override.replace?.(storageKey);
        if (replaced) return replaced;
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
  uid?: string;
  sequence?: number;
  summary?: string | null;
  location?: string | null;
  dtStart?: string;
  dtEnd?: string | null;
  extra?: string[];
  /** Extra VEVENT blocks that follow the first one. */
  moreEvents?: string[][];
}

/** The text of an iMIP calendar part: one VEVENT of a UTC meeting unless an option says otherwise. */
function ics(options: IcsOptions = {}): string {
  const method = options.method === undefined ? "REQUEST" : options.method;
  const event = (lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];
  const first = event([
    `UID:${options.uid ?? "sprint-review@example.test"}`,
    `SEQUENCE:${options.sequence ?? 0}`,
    ...(options.summary === null ? [] : [`SUMMARY:${options.summary ?? "Sprint review"}`]),
    ...(options.location === null ? [] : [`LOCATION:${options.location ?? "Room 4"}`]),
    options.dtStart ?? "DTSTART:20261120T090000Z",
    ...(options.dtEnd === null ? [] : [options.dtEnd ?? "DTEND:20261120T100000Z"]),
    "ORGANIZER;CN=Olga Organizer:mailto:olga@example.test",
    "ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION:mailto:me@example.test",
    ...(options.extra ?? []),
  ]);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...(method === null ? [] : [`METHOD:${method}`]),
    ...first,
    ...(options.moreEvents ?? []).flatMap(event),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

const calendarPart = (text: string): Part => ({ contentType: "text/calendar", text });

/** A message that arrives through the sync writer with `parts` as its attachments; returns its Emails item id. */
async function receive(
  world: World,
  messageId: string,
  parts: Part[],
  options: { isDsn?: boolean } = {},
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
        envelope: { from: { name: "Olga", address: "olga@example.test" }, to: [{ address: "me@example.test" }] },
        attachments: parts.map((part, index) => ({
          filename: `part-${index}.ics`,
          contentType: part.contentType,
          contentId: null,
          disposition: "inline" as const,
          openStream: () => Readable.from([Buffer.from(part.text)]),
        })),
        storage: store.storage,
        storageKeyPrefix: "invitation-ingest",
        isDsn: options.isDsn,
      }),
    ),
  );
  return result.itemId;
}

function configOf(world: World): Record<string, unknown> {
  return { emailsDatabaseId: world.databases.emails, invitationsDatabaseId: world.databases.invitations };
}

function actionFor(storage: BlobStorageWriter = store.storage): ActionHandler {
  return createInvitationIngestAction(runtime, { storage });
}

/** Fires the heartbeat action for `emailItemId` the way a heartbeat for the Emails database does, in the tenant of `world`. */
function ingest(world: World, emailItemId: string, config: Record<string, unknown> = configOf(world)): Promise<void> {
  return runInTenant(world.tenantId, () =>
    actionFor()(config, { heartbeatId: "test", projectItemId: "test", itemId: emailItemId }),
  );
}

const invitationRow = z.object({
  id: z.string(),
  properties: z.record(z.string(), z.unknown()),
  deleted_at: z.date().nullable(),
});
type InvitationRow = z.infer<typeof invitationRow>;

/** Every invitation row of the tenant, trashed ones included, in id order, read on the admin pool by database id. */
async function invitationsOf(world: World): Promise<InvitationRow[]> {
  const { rows } = await admin.query(
    "SELECT id, properties, deleted_at FROM items WHERE database_id = $1 ORDER BY id",
    [world.databases.invitations],
  );
  return z.array(invitationRow).parse(rows);
}

async function onlyInvitation(world: World): Promise<InvitationRow> {
  const rows = await invitationsOf(world);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error("Missing invitation");
  return row;
}

/** The ids an invitation's relation `key` points at. */
async function edgesOf(world: World, invitationId: string, key: string): Promise<string[]> {
  return runInTenant(world.tenantId, async () => {
    const property = (await world.cp.listProperties(world.databases.invitations!)).find((entry) => entry.key === key);
    if (!property) throw new Error(`No ${key} property`);
    return world.related(property.id, invitationId);
  });
}

async function defaultCalendarId(world: World): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "SELECT id FROM items WHERE database_id = $1 AND properties->'isDefault' = 'true'::jsonb",
    [world.databases.calendars],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

/** Writes `patch` to an invitation as the calendar module's own writer: the state a later answer produces. */
async function writeInvitation(world: World, invitationId: string, patch: Record<string, unknown>): Promise<void> {
  await runInTenant(world.tenantId, () =>
    withTransaction(runtime, (client) =>
      updateItemWithClient(
        client,
        { databaseId: world.databases.invitations!, itemId: invitationId, propertiesPatch: patch },
        { allowedSystemKeys: Object.keys(patch), systemOwnerProcess: CALENDAR_MODULE_ID },
      ),
    ),
  );
}

/** Every argument that the spied logger methods were called with, as text. */
function loggedText(...spies: Array<{ mock: { calls: unknown[][] } }>): string {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
}

describe("calendar.ingestInvitation (issue gh-1929)", () => {
  let world: World;
  let otherWorld: World;

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
    store = memoryStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it("is fired by the heartbeat of a new Emails item and creates the invitation from the queued job", async () => {
    const registry = createActionRegistry();
    registry.set(CALENDAR_INGEST_INVITATION_ACTION_ID, actionFor());
    const emailId = await receive(world, "<heartbeat@example.test>", [calendarPart(ics())]);
    expect(await invitationsOf(world)).toEqual([]);

    await runOnce({ pgPool: runtime, taskList: createCoreTaskList(runtime, registry) });

    const invitation = await onlyInvitation(world);
    expect(await edgesOf(world, invitation.id, "sourceEmail")).toEqual([emailId]);
  });

  describe("a REQUEST creates a pending invitation", () => {
    it("creates exactly one pending invitation with its fields, the receiving mailbox, the source email and the default calendar", async () => {
      const emailId = await receive(world, "<request-1@example.test>", [calendarPart(ics())]);
      await ingest(world, emailId);

      const invitation = await onlyInvitation(world);
      expect(invitation.deleted_at).toBeNull();
      expect(invitation.properties).toEqual({
        title: "Sprint review",
        startsAt: "2026-11-20T09:00:00.000Z",
        endsAt: "2026-11-20T10:00:00.000Z",
        timeZone: "UTC",
        allDay: false,
        place: "Room 4",
        organizerName: "Olga Organizer",
        organizerEmail: "olga@example.test",
        status: "pending",
        kind: "invite",
        uid: "sprint-review@example.test",
        sequence: 0,
      });
      expect(await edgesOf(world, invitation.id, "sourceEmail")).toEqual([emailId]);
      expect(await edgesOf(world, invitation.id, "mailbox")).toEqual([world.inbox.mailboxId]);
      expect(await edgesOf(world, invitation.id, "suggestedCalendar")).toEqual([await defaultCalendarId(world)]);
      expect(await edgesOf(world, invitation.id, "event")).toEqual([]);
    });

    it("stores an all-day event with its first and last day at 00:00 UTC", async () => {
      const text = ics({ dtStart: "DTSTART;VALUE=DATE:20261120", dtEnd: "DTEND;VALUE=DATE:20261123" });
      await ingest(world, await receive(world, "<allday@example.test>", [calendarPart(text)]));
      expect((await onlyInvitation(world)).properties).toMatchObject({
        allDay: true,
        startsAt: "2026-11-20T00:00:00.000Z",
        endsAt: "2026-11-22T00:00:00.000Z",
      });
    });

    it("stores a time with a TZID as a UTC instant and keeps the IANA zone", async () => {
      const text = ics({ dtStart: "DTSTART;TZID=America/New_York:20261120T090000", dtEnd: null });
      await ingest(world, await receive(world, "<tzid@example.test>", [calendarPart(text)]));
      const { properties } = await onlyInvitation(world);
      expect(properties).toMatchObject({ startsAt: "2026-11-20T14:00:00.000Z", timeZone: "America/New_York" });
      expect(properties).not.toHaveProperty("endsAt");
    });

    it("falls back to the tenant time zone for an unknown TZID, never drops the invitation and logs a reason code only", async () => {
      const warn = vi.spyOn(logger, "warn");
      const text = ics({ dtStart: `DTSTART;TZID=Mars/Olympus-Mons:20261120T090000`, summary: SECRET });
      const emailId = await receive(world, "<unknown-tzid@example.test>", [calendarPart(text)]);
      await ingest(world, emailId);

      expect((await onlyInvitation(world)).properties).toMatchObject({
        startsAt: "2026-11-20T08:00:00.000Z",
        timeZone: "Europe/Prague",
      });
      expect(warn).toHaveBeenCalledWith({ emailItemId: emailId, reason: "unknown_tzid" }, expect.any(String));
      expect(loggedText(warn)).not.toContain(SECRET);
      expect(loggedText(warn)).not.toContain("Mars");
    });

    /** Sets the time zone of the tenant's settings row. SQL keeps the test independent of the settings route. */
    async function setTenantTimeZone(timeZone: string): Promise<void> {
      await admin.query(
        `UPDATE items SET properties = properties || jsonb_build_object('timezone', $2::text)
          WHERE database_id = (SELECT id FROM databases WHERE tenant_id = $1 AND owner_module_id = 'systemSettings')`,
        [tenant, timeZone],
      );
    }

    it("reads the fallback zone from the settings of the tenant it runs in", async () => {
      await setTenantTimeZone("America/New_York");
      const text = ics({ dtStart: "DTSTART;TZID=Mars/Olympus-Mons:20261120T090000", dtEnd: null });
      await ingest(world, await receive(world, "<tenant-zone@example.test>", [calendarPart(text)]));
      expect((await onlyInvitation(world)).properties).toMatchObject({
        startsAt: "2026-11-20T14:00:00.000Z",
        timeZone: "America/New_York",
      });
    });

    it("fails, and writes nothing, when the tenant's time zone setting is not an IANA zone", async () => {
      const emailId = await receive(world, "<bad-zone@example.test>", [calendarPart(ics())]);
      await setTenantTimeZone("Not/AZone");
      await expect(ingest(world, emailId)).rejects.toThrow(/Invalid IANA timezone/);
      expect(await invitationsOf(world)).toEqual([]);
    });

    it("stores a recurring invitation as one invitation for the first occurrence and ignores the rule", async () => {
      const text = ics({ extra: ["RRULE:FREQ=WEEKLY;COUNT=10"] });
      await ingest(world, await receive(world, "<recurring@example.test>", [calendarPart(text)]));
      const { properties } = await onlyInvitation(world);
      expect(properties).toMatchObject({ startsAt: "2026-11-20T09:00:00.000Z", status: "pending" });
      expect(Object.keys(properties)).not.toContain("recurrence");
    });

    it("creates nothing when every VEVENT has a RECURRENCE-ID", async () => {
      const override = [
        "UID:sprint-review@example.test",
        "SUMMARY:Moved occurrence",
        "DTSTART:20261127T090000Z",
        "RECURRENCE-ID:20261127T090000Z",
      ];
      const text = ics({ extra: ["RECURRENCE-ID:20261120T090000Z"], moreEvents: [override] });
      await ingest(world, await receive(world, "<only-overrides@example.test>", [calendarPart(text)]));
      expect(await invitationsOf(world)).toEqual([]);
    });

    it("skips the first VEVENT with a RECURRENCE-ID and takes the next one without", async () => {
      const series = ["UID:series@example.test", "SEQUENCE:1", "SUMMARY:Series master", "DTSTART:20261201T090000Z"];
      const text = ics({ uid: "series@example.test", extra: ["RECURRENCE-ID:20261124T090000Z"], moreEvents: [series] });
      await ingest(world, await receive(world, "<override-first@example.test>", [calendarPart(text)]));
      expect((await onlyInvitation(world)).properties).toMatchObject({
        title: "Series master",
        startsAt: "2026-12-01T09:00:00.000Z",
        sequence: 1,
      });
    });

    it("reads every calendar part of the message, application/ics and an upper-case content type included", async () => {
      const parts = [
        { contentType: "application/ics", text: ics({ uid: "one@example.test" }) },
        { contentType: "TEXT/CALENDAR", text: ics({ uid: "two@example.test" }) },
        { contentType: "application/pdf", text: ics({ uid: "pdf@example.test" }) },
      ];
      await ingest(world, await receive(world, "<three-parts@example.test>", parts));
      expect((await invitationsOf(world)).map((row) => row.properties.uid).sort()).toEqual([
        "one@example.test",
        "two@example.test",
      ]);
    });

    it("creates the invitation without a mailbox edge when the message has no mailbox, and without a calendar edge when no calendar is the default", async () => {
      const warn = vi.spyOn(logger, "warn");
      const emailId = await receive(world, "<legacy@example.test>", [calendarPart(ics())]);
      // A legacy-migrated message has no mailbox (see MailMessageMetaRow.mailboxItemId) and ingest cannot produce
      // one, and the calendar API refuses to clear the default calendar, so both states are written directly.
      await admin.query("UPDATE mail_message_meta SET mailbox_item_id = NULL WHERE item_id = $1", [emailId]);
      await admin.query("UPDATE items SET properties = properties || '{\"isDefault\": false}' WHERE database_id = $1", [
        world.databases.calendars,
      ]);
      await ingest(world, emailId);

      const invitation = await onlyInvitation(world);
      expect(await edgesOf(world, invitation.id, "sourceEmail")).toEqual([emailId]);
      expect(await edgesOf(world, invitation.id, "mailbox")).toEqual([]);
      expect(await edgesOf(world, invitation.id, "suggestedCalendar")).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        { emailItemId: emailId, invitationItemId: invitation.id },
        "default_calendar_missing",
      );
    });
  });

  describe("a later request for a known UID", () => {
    it("updates a pending invitation of a lower SEQUENCE, replaces its source email and keeps one row", async () => {
      const first = await receive(world, "<v0@example.test>", [calendarPart(ics())]);
      await ingest(world, first);
      const before = await onlyInvitation(world);

      const text = ics({
        sequence: 1,
        summary: "Sprint review (moved)",
        location: null,
        dtStart: "DTSTART:20261121T130000Z",
        dtEnd: null,
      });
      const second = await receive(world, "<v1@example.test>", [calendarPart(text)]);
      await ingest(world, second);

      const after = await onlyInvitation(world);
      expect(after.id).toBe(before.id);
      expect(after.properties).toEqual({
        title: "Sprint review (moved)",
        startsAt: "2026-11-21T13:00:00.000Z",
        // A value the new request no longer carries is cleared, not left as it was.
        endsAt: null,
        place: null,
        timeZone: "UTC",
        allDay: false,
        organizerName: "Olga Organizer",
        organizerEmail: "olga@example.test",
        status: "pending",
        kind: "invite",
        uid: "sprint-review@example.test",
        sequence: 1,
      });
      expect(await edgesOf(world, after.id, "sourceEmail")).toEqual([second]);
      // The receiving mailbox and the suggested calendar were chosen when the invitation arrived and stay.
      expect(await edgesOf(world, after.id, "mailbox")).toEqual([world.inbox.mailboxId]);
      expect(await edgesOf(world, after.id, "suggestedCalendar")).toEqual([await defaultCalendarId(world)]);
    });

    it.each([
      ["an equal", 3, 3],
      ["a lower", 3, 2],
    ])("changes nothing for %s SEQUENCE", async (_name, stored, incoming) => {
      const first = await receive(world, "<base@example.test>", [calendarPart(ics({ sequence: stored }))]);
      await ingest(world, first);
      const before = await onlyInvitation(world);

      const changed = ics({ sequence: incoming, summary: "Changed title", dtStart: "DTSTART:20270101T090000Z" });
      await ingest(world, await receive(world, "<later@example.test>", [calendarPart(changed)]));

      expect(await invitationsOf(world)).toEqual([before]);
      expect(await edgesOf(world, before.id, "sourceEmail")).toEqual([first]);
    });

    it.each(["accepted", "tentative", "declined", "acknowledged", "cancelled"])(
      "changes nothing for an invitation that is %s, whatever the SEQUENCE",
      async (status) => {
        const first = await receive(world, "<answered@example.test>", [calendarPart(ics())]);
        await ingest(world, first);
        const { id } = await onlyInvitation(world);
        await writeInvitation(world, id, { status });
        const before = await onlyInvitation(world);

        await ingest(
          world,
          await receive(world, "<after-answer@example.test>", [calendarPart(ics({ sequence: 9, summary: "Changed" }))]),
        );

        expect(await invitationsOf(world)).toEqual([before]);
        expect(await edgesOf(world, id, "sourceEmail")).toEqual([first]);
      },
    );

    it("changes nothing for a trashed invitation and does not create a second one", async () => {
      await ingest(world, await receive(world, "<to-trash@example.test>", [calendarPart(ics())]));
      const { id } = await onlyInvitation(world);
      await runInTenant(tenant, () => world.cp.softDeleteItem(world.databases.invitations!, id));
      const before = await onlyInvitation(world);
      expect(before.deleted_at).not.toBeNull();

      await ingest(world, await receive(world, "<after-trash@example.test>", [calendarPart(ics({ sequence: 4 }))]));
      expect(await invitationsOf(world)).toEqual([before]);
    });

    it("treats a stored SEQUENCE that is not a number as 0", async () => {
      await ingest(world, await receive(world, "<seq-base@example.test>", [calendarPart(ics())]));
      const { id } = await onlyInvitation(world);
      // The sequence property is a number, so a text value is a state the choke point refuses and only SQL can write.
      await admin.query('UPDATE items SET properties = properties || \'{"sequence": "legacy"}\' WHERE id = $1', [id]);

      await ingest(world, await receive(world, "<seq-one@example.test>", [calendarPart(ics({ sequence: 1 }))]));
      expect((await onlyInvitation(world)).properties.sequence).toBe(1);
    });
  });

  describe("a message that creates nothing", () => {
    it("does nothing for a message without a calendar part, and reads no blob", async () => {
      const emailId = await receive(world, "<plain@example.test>", [{ contentType: "application/pdf", text: "pdf" }]);
      await ingest(world, emailId);
      await ingest(world, await receive(world, "<no-parts@example.test>", []));
      expect(await invitationsOf(world)).toEqual([]);
      expect(store.reads).toEqual([]);
    });

    it.each([
      ["CANCEL", "CANCEL"],
      ["REPLY", "REPLY"],
      ["PUBLISH", "PUBLISH"],
      ["no METHOD", null],
    ])("does nothing for a %s calendar", async (_name, method) => {
      await ingest(world, await receive(world, "<other-method@example.test>", [calendarPart(ics({ method }))]));
      expect(await invitationsOf(world)).toEqual([]);
    });

    it("does not touch the invitation of a CANCEL for a known UID", async () => {
      await ingest(world, await receive(world, "<known@example.test>", [calendarPart(ics())]));
      const before = await onlyInvitation(world);
      await ingest(
        world,
        await receive(world, "<cancel@example.test>", [calendarPart(ics({ method: "CANCEL", sequence: 5 }))]),
      );
      expect(await invitationsOf(world)).toEqual([before]);
    });

    it("skips a delivery status notification before it reads any part", async () => {
      const emailId = await receive(world, "<bounce@example.test>", [calendarPart(ics())], { isDsn: true });
      await ingest(world, emailId);
      expect(await invitationsOf(world)).toEqual([]);
      expect(store.reads).toEqual([]);
    });

    it("skips an Emails item that has no message record", async () => {
      // An Emails item that mail ingest did not write has no `mail_message_meta` row.
      const emailId = await runInTenant(tenant, () =>
        withTransaction(
          runtime,
          async (client) =>
            (
              await createItemWithClient(
                client,
                { databaseId: world.databases.emails!, properties: { name: "Hand written" } },
                { allowedSystemKeys: ["name"] },
              )
            ).id,
        ),
      );
      await ingest(world, emailId);
      expect(await invitationsOf(world)).toEqual([]);
    });

    it("skips an email that was trashed before the action ran", async () => {
      const emailId = await receive(world, "<trashed-mail@example.test>", [calendarPart(ics())]);
      await runInTenant(tenant, () => world.cp.softDeleteItem(world.databases.emails!, emailId));
      await ingest(world, emailId);
      expect(await invitationsOf(world)).toEqual([]);
    });

    it("does nothing when the heartbeat fired for no item", async () => {
      await runInTenant(tenant, () => actionFor()(configOf(world), { heartbeatId: "test", projectItemId: "test" }));
      expect(await invitationsOf(world)).toEqual([]);
    });

    it("fails on a malformed action config and writes nothing", async () => {
      const emailId = await receive(world, "<bad-config@example.test>", [calendarPart(ics())]);
      await expect(ingest(world, emailId, { emailsDatabaseId: world.databases.emails })).rejects.toThrow(
        /Malformed action config for calendar\.ingestInvitation/,
      );
      expect(await invitationsOf(world)).toEqual([]);
    });
  });

  describe("limits and malformed parts", () => {
    it("skips a part whose recorded size is over 256 KiB without reading it and without an error", async () => {
      const warn = vi.spyOn(logger, "warn");
      const info = vi.spyOn(logger, "info");
      const padded = ics({ summary: SECRET, extra: [`X-PAD:${"x".repeat(ICALENDAR_MAX_BYTES)}`] });
      expect(Buffer.byteLength(padded)).toBeGreaterThan(ICALENDAR_MAX_BYTES);
      await ingest(world, await receive(world, "<big@example.test>", [calendarPart(padded)]));

      expect(await invitationsOf(world)).toEqual([]);
      expect(store.reads).toEqual([]);
      expect(loggedText(warn, info)).not.toContain(SECRET);
    });

    it("skips a part whose bytes are over 256 KiB although its row says otherwise, logging a reason code only", async () => {
      const warn = vi.spyOn(logger, "warn");
      const emailId = await receive(world, "<lying-size@example.test>", [calendarPart(ics({ summary: SECRET }))]);
      store.override.replace = () => Readable.from([Buffer.alloc(ICALENDAR_MAX_BYTES), Buffer.from(SECRET)]);
      await ingest(world, emailId);

      expect(await invitationsOf(world)).toEqual([]);
      expect(warn).toHaveBeenCalledWith({ emailItemId: emailId, reason: "part_over_limit" }, expect.any(String));
      expect(loggedText(warn)).not.toContain(SECRET);
    });

    it("skips a calendar with more than 10 events without an error and without logging its content", async () => {
      const warn = vi.spyOn(logger, "warn");
      const info = vi.spyOn(logger, "info");
      const more = Array.from({ length: 10 }, (_, index) => [
        `UID:extra-${index}@example.test`,
        `SUMMARY:${SECRET}`,
        "DTSTART:20261120T090000Z",
      ]);
      const emailId = await receive(world, "<eleven@example.test>", [
        calendarPart(ics({ summary: SECRET, moreEvents: more })),
      ]);
      await ingest(world, emailId);

      expect(await invitationsOf(world)).toEqual([]);
      expect(warn).toHaveBeenCalledWith({ emailItemId: emailId, reason: "tooManyEvents" }, expect.any(String));
      expect(loggedText(warn, info)).not.toContain(SECRET);
    });

    it("skips a malformed calendar without an error and without logging its content", async () => {
      const warn = vi.spyOn(logger, "warn");
      const text = `BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nSUMMARY:${SECRET}\r\n`;
      const emailId = await receive(world, "<malformed@example.test>", [calendarPart(text)]);
      await ingest(world, emailId);

      expect(await invitationsOf(world)).toEqual([]);
      expect(warn).toHaveBeenCalledWith({ emailItemId: emailId, reason: "malformed" }, expect.any(String));
      expect(loggedText(warn)).not.toContain(SECRET);
    });

    it("still creates the invitation of a good part when another part of the message is malformed", async () => {
      const parts = [calendarPart("not a calendar"), calendarPart(ics({ uid: "good@example.test" }))];
      await ingest(world, await receive(world, "<mixed@example.test>", parts));
      expect((await onlyInvitation(world)).properties.uid).toBe("good@example.test");
    });

    it("fails when the storage cannot be read, and writes nothing", async () => {
      const emailId = await receive(world, "<storage-down@example.test>", [calendarPart(ics())]);
      store.override.replace = () =>
        new Readable({
          read() {
            this.destroy(new Error("disk gone"));
          },
        });
      await expect(ingest(world, emailId)).rejects.toThrow("disk gone");
      expect(await invitationsOf(world)).toEqual([]);
    });
  });

  describe("idempotency and concurrency", () => {
    it("creates no duplicate when the same email is processed twice", async () => {
      const emailId = await receive(world, "<twice@example.test>", [calendarPart(ics())]);
      await ingest(world, emailId);
      const before = await onlyInvitation(world);
      await ingest(world, emailId);

      expect(await invitationsOf(world)).toEqual([before]);
      expect(await edgesOf(world, before.id, "sourceEmail")).toEqual([emailId]);
      expect(await edgesOf(world, before.id, "mailbox")).toEqual([world.inbox.mailboxId]);
      expect(await edgesOf(world, before.id, "suggestedCalendar")).toHaveLength(1);
    });

    it("creates one invitation when emails of the same UID are delivered at the same time", async () => {
      const emails = await Promise.all(
        [0, 1, 2, 3].map((sequence) =>
          receive(world, `<race-${sequence}@example.test>`, [calendarPart(ics({ sequence }))]),
        ),
      );
      await Promise.all(emails.map((emailId) => ingest(world, emailId)));

      const invitation = await onlyInvitation(world);
      // Whatever the order, a delivery only ever raises the sequence of a pending invitation.
      expect(invitation.properties.sequence).toBe(3);
      expect(await edgesOf(world, invitation.id, "sourceEmail")).toEqual([emails[3]]);
    });

    it("waits for the lock of the UID and then sees the invitation another delivery created", async () => {
      const emailId = await receive(world, "<locked@example.test>", [calendarPart(ics())]);
      let acquired!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      // A transaction that holds the key applyRequest locks is a delivery of the same UID in flight. The key text
      // mirrors the production one.
      const holding = withTenantTransaction(runtime, tenant, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('invitationUid:' || app_tenant_default()::text || ':' || $1::text, 0))",
          ["sprint-review@example.test"],
        );
        acquired();
        await released;
      });
      await lockTaken;
      let finished = false;
      const running = ingest(world, emailId).then(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(finished).toBe(false);
      expect(await invitationsOf(world)).toEqual([]);

      release();
      await holding;
      await running;
      expect(finished).toBe(true);
      expect(await invitationsOf(world)).toHaveLength(1);
    });
  });

  describe("readCalendarPartsOfEmail", () => {
    const read = (world: World, emailItemId: string, storage: Pick<BlobStorageWriter, "readStream"> = store.storage) =>
      runInTenant(world.tenantId, () => readCalendarPartsOfEmail(runtime, storage, emailItemId));

    it("returns the text of each calendar part of the message and no other part, in a stable order", async () => {
      const parts = [
        { contentType: "text/calendar", text: "first part" },
        { contentType: "application/ics", text: "second part" },
        { contentType: "Text/Calendar", text: "third part" },
        { contentType: "application/pdf", text: "not a calendar" },
        { contentType: "text/plain", text: "not a calendar either" },
      ];
      const emailId = await receive(world, "<parts@example.test>", parts);
      const other = await receive(world, "<other-message@example.test>", [calendarPart("another message")]);

      const texts = await read(world, emailId);
      expect([...texts].sort()).toEqual(["first part", "second part", "third part"]);
      expect(await read(world, emailId)).toEqual(texts);
      expect(await read(world, other)).toEqual(["another message"]);
    });

    it("returns an empty list for a message without a calendar part and for an unknown item", async () => {
      const emailId = await receive(world, "<none@example.test>", [{ contentType: "application/pdf", text: "pdf" }]);
      expect(await read(world, emailId)).toEqual([]);
      expect(await read(world, "00000000-0000-4000-8000-000000000000")).toEqual([]);
      expect(store.reads).toEqual([]);
    });

    it("lists only parts whose recorded size is within the limit and reads exactly those", async () => {
      const small = calendarPart("small");
      const big = calendarPart("x".repeat(ICALENDAR_MAX_BYTES + 1));
      const exact = calendarPart("y".repeat(ICALENDAR_MAX_BYTES));
      const emailId = await receive(world, "<sizes@example.test>", [small, big, exact]);

      const texts = await read(world, emailId);
      expect(texts.map((text) => text.length).sort((a, b) => a - b)).toEqual([5, ICALENDAR_MAX_BYTES]);
      expect(store.reads).toHaveLength(2);
    });

    it("decodes text and byte chunks alike as UTF-8", async () => {
      const emailId = await receive(world, "<chunks@example.test>", [calendarPart("ignored")]);
      const asText = { readStream: () => Readable.from(["Sch\u00f6ne", " Gr\u00fc\u00dfe"]) };
      expect(await read(world, emailId, asText)).toEqual(["Sch\u00f6ne Gr\u00fc\u00dfe"]);
      const asBytes = { readStream: () => Readable.from([Buffer.from("caf\u00e9")]) };
      expect(await read(world, emailId, asBytes)).toEqual(["caf\u00e9"]);
    });

    it("rejects a stream that yields neither text nor bytes, and one that fails", async () => {
      const emailId = await receive(world, "<bad-stream@example.test>", [calendarPart("ignored")]);
      const numbers = { readStream: () => Readable.from([42]) };
      await expect(read(world, emailId, numbers)).rejects.toThrow(TypeError);
      const failing = {
        readStream: () =>
          new Readable({
            read() {
              this.destroy(new Error("read failed"));
            },
          }),
      };
      await expect(read(world, emailId, failing)).rejects.toThrow("read failed");
    });

    it("destroys the stream of a part that turns out to be over the limit", async () => {
      const emailId = await receive(world, "<destroyed@example.test>", [calendarPart("ignored")]);
      const stream = Readable.from([Buffer.alloc(ICALENDAR_MAX_BYTES + 1), Buffer.from("never read")]);
      expect(await read(world, emailId, { readStream: () => stream })).toEqual([]);
      expect(stream.destroyed).toBe(true);
    });

    it("returns nothing for the message of another tenant", async () => {
      const foreign = await receive(otherWorld, "<foreign-parts@example.test>", [calendarPart("foreign")]);
      expect(await read(otherWorld, foreign)).toEqual(["foreign"]);
      expect(await read(world, foreign)).toEqual([]);
    });
  });

  describe("tenant isolation", () => {
    it("keeps the invitations of two tenants with the same UID apart", async () => {
      await ingest(
        world,
        await receive(world, "<mine@example.test>", [calendarPart(ics({ sequence: 5, summary: "Mine" }))]),
      );
      await ingest(
        otherWorld,
        await receive(otherWorld, "<theirs@example.test>", [calendarPart(ics({ sequence: 1, summary: "Theirs" }))]),
      );

      expect((await onlyInvitation(world)).properties).toMatchObject({ title: "Mine", sequence: 5 });
      expect((await onlyInvitation(otherWorld)).properties).toMatchObject({ title: "Theirs", sequence: 1 });

      // Through the runtime role, one tenant cannot see the other's invitation database or rows.
      await runInTenant(other, async () => {
        expect((await otherWorld.cp.listItems(world.databases.invitations!, { limit: 10 })).items).toEqual([]);
      });
    });

    it("does nothing for an email of another tenant, with that tenant's database ids in the config", async () => {
      const foreignEmail = await receive(otherWorld, "<foreign@example.test>", [calendarPart(ics())]);
      // The action runs in the scope of `tenant` but names the Emails item and databases of `other`.
      await ingest(world, foreignEmail, configOf(otherWorld));
      expect(await invitationsOf(world)).toEqual([]);
      expect(await invitationsOf(otherWorld)).toEqual([]);
    });
  });
});
