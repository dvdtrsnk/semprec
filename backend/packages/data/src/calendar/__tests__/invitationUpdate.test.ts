import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import "../../domainWriteHooks.js";
import { ValidationError } from "../../errors.js";
import { createRuntimeRolePool, getTestPool, resetDatabase, withTenantTransaction } from "../../testSupport/testDb.js";
import type { MailAttachmentWorld as World } from "../../testSupport/mailAttachmentFixtures.js";
import { logger } from "../logger.js";
import {
  createInvitationMail,
  ics,
  ORGANIZER_ADDRESS,
  type InvitationMail,
  type MailTenant,
} from "./invitationMailFixtures.js";

/** An organizer's higher-SEQUENCE REQUEST for an answered invitation and its Event (issue gh-2007). */

let admin: Pool;
let runtime: Pool;
let mail: InvitationMail;

/** A marker that is the title of the invitations below and must never reach a log line. */
const SECRET = "CONFIDENTIAL-MARKER";

const itemRow = z.object({
  id: z.string(),
  properties: z.record(z.string(), z.unknown()),
  deleted_at: z.date().nullable(),
  updated_at: z.date(),
});
type ItemRow = z.infer<typeof itemRow>;

/** Every row of one database of the tenant, trashed ones included, in id order. */
async function rowsOf(world: World, moduleKey: string): Promise<ItemRow[]> {
  const { rows } = await admin.query(
    "SELECT id, properties, deleted_at, updated_at FROM items WHERE database_id = $1 ORDER BY id",
    [world.databases[moduleKey]],
  );
  return z.array(itemRow).parse(rows);
}

const invitationsOf = (world: World) => rowsOf(world, "invitations");
const eventsOf = (world: World) => rowsOf(world, "events");

async function onlyRow(rows: Promise<ItemRow[]>): Promise<ItemRow> {
  const found = await rows;
  expect(found).toHaveLength(1);
  return found[0]!;
}

const notificationRow = z.object({
  id: z.string(),
  source_id: z.string(),
  read_at: z.date().nullable(),
  resolved_at: z.date().nullable(),
});

/** The notifications of the tenant, read as the runtime role inside that tenant, oldest first. */
async function notificationsOf(tenantId: string): Promise<Array<z.infer<typeof notificationRow>>> {
  return withTenantTransaction(runtime, tenantId, async (client) => {
    const { rows } = await client.query(
      "SELECT id, source_id, read_at, resolved_at FROM notifications ORDER BY created_at, id",
    );
    return z.array(notificationRow).parse(rows);
  });
}

/** The ids on the other end of the invitation's relation `key`. */
async function edgesOf(world: World, invitationId: string, key: string): Promise<string[]> {
  return runInTenant(world.tenantId, async () => {
    const property = (await world.cp.listProperties(world.databases.invitations!)).find((entry) => entry.key === key);
    if (!property) throw new Error(`No ${key} property`);
    return world.related(property.id, invitationId);
  });
}

/** Every argument that the spied logger methods were called with, as text. */
function loggedText(...spies: Array<{ mock: { calls: unknown[][] } }>): string {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
}

/** The properties of an Event without its iCalendar sequence, which the Events write raises for a change of the Event. */
const withoutIcalSequence = (properties: Record<string, unknown>) => ({ ...properties, icalSequence: undefined });

/** The meeting that moves from 13:00-14:00 to 14:00-15:00 (Europe/Prague, UTC+2 on 22 Oct 2026). */
const MOVED = { dtStart: "DTSTART:20261022T120000Z", dtEnd: "DTEND:20261022T130000Z" };

describe("an organizer's update of an answered invitation (issue gh-2007)", () => {
  let tenant: MailTenant;
  let world: World;
  let other: MailTenant;

  /** The invitation "Sprint review" arrives; the user answers it with `response`. Returns the invitation row. */
  async function answeredInvitation(response: string, request: Parameters<typeof ics>[0] = {}): Promise<ItemRow> {
    await mail.deliver(world, "<request@example.test>", ics({ summary: SECRET, ...request }));
    const invitation = await onlyRow(invitationsOf(world));
    await mail.respond(tenant, invitation.id, response);
    return onlyRow(invitationsOf(world));
  }

  /** An organizer's update arrives and is ingested; returns the Emails item id. */
  function update(request: Parameters<typeof ics>[0], id = "<update@example.test>"): Promise<string> {
    return mail.deliver(world, id, ics({ summary: SECRET, sequence: 1, ...request }));
  }

  /** The user changes the Event as they would in the app. */
  async function userEdit(eventId: string, propertiesPatch: Record<string, unknown>): Promise<void> {
    await runInTenant(world.tenantId, () =>
      world.cp.updateItem({ databaseId: world.databases.events!, itemId: eventId, propertiesPatch }),
    );
  }

  /** The tenant's time zone setting, written in SQL so the test does not depend on the settings route. */
  async function setTenantTimeZone(timeZone: string): Promise<void> {
    await admin.query(
      `UPDATE items SET properties = properties || jsonb_build_object('timezone', $2::text)
        WHERE database_id = (SELECT id FROM databases WHERE tenant_id = $1 AND owner_module_id = 'systemSettings')`,
      [world.tenantId, timeZone],
    );
  }

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    mail = createInvitationMail(runtime);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await mail.tenant(admin);
    world = tenant.world;
    other = await mail.tenant(admin);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it.each(["accepted", "tentative"])(
    "moves the Event of a %s invitation whose Event the user has not edited, and keeps the answer",
    async (response) => {
      const answered = await answeredInvitation(response);
      const event = await onlyRow(eventsOf(world));
      expect(event.properties).toMatchObject({ date: "2026-10-22", timeFrom: "13:00", timeTo: "14:00" });

      const emailItemId = await update(MOVED);

      const invitation = await onlyRow(invitationsOf(world));
      expect(invitation.id).toBe(answered.id);
      expect(invitation.properties).toEqual({
        ...answered.properties,
        startsAt: "2026-10-22T12:00:00.000Z",
        endsAt: "2026-10-22T13:00:00.000Z",
        sequence: 1,
      });
      expect(invitation.properties.status).toBe(response);
      expect(invitation.properties.respondedAt).toBe(answered.properties.respondedAt);
      expect(await edgesOf(world, invitation.id, "sourceEmail")).toEqual([emailItemId]);
      const moved = await onlyRow(eventsOf(world));
      expect(moved.id).toBe(event.id);
      expect(moved.deleted_at).toBeNull();
      expect(withoutIcalSequence(moved.properties)).toEqual(
        withoutIcalSequence({
          ...event.properties,
          timeFrom: "14:00",
          timeTo: "15:00",
          time: expect.stringMatching(/^14:00.15:00$/),
        }),
      );
      expect(await edgesOf(world, invitation.id, "event")).toEqual([event.id]);
    },
  );

  it("keeps the user's title and writes the new place when the user renamed the Event and the organizer changes both", async () => {
    await answeredInvitation("accepted");
    const event = await onlyRow(eventsOf(world));
    await userEdit(event.id, { name: "My own name" });

    await update({ summary: "Sprint review (renamed)", location: "Room 9" });

    const stored = await onlyRow(eventsOf(world));
    expect(withoutIcalSequence(stored.properties)).toEqual(
      withoutIcalSequence({ ...event.properties, name: "My own name", place: "Room 9" }),
    );
    expect((await onlyRow(invitationsOf(world))).properties).toMatchObject({
      title: "Sprint review (renamed)",
      place: "Room 9",
      status: "accepted",
    });
  });

  it.each([
    ["has no SUMMARY", null],
    ["has a blank SUMMARY", "   "],
  ])(
    "keeps the Event's title when the update %s, and still writes the fields it does carry",
    async (_name, summary) => {
      await answeredInvitation("accepted");
      const event = await onlyRow(eventsOf(world));
      expect(event.properties.name).toBe(SECRET);

      await update({ summary, location: "Room 9", ...MOVED });

      const stored = await onlyRow(eventsOf(world));
      expect(stored.properties.name).toBe(SECRET);
      expect(stored.properties).toMatchObject({ place: "Room 9", timeFrom: "14:00", timeTo: "15:00" });
      expect((await onlyRow(invitationsOf(world))).properties.title ?? null).toBeNull();
    },
  );

  it("keeps the user's place and writes the new title when the user changed the place", async () => {
    await answeredInvitation("accepted");
    const event = await onlyRow(eventsOf(world));
    await userEdit(event.id, { place: "My room" });

    await update({ summary: "Sprint review (renamed)", location: "Room 9" });

    expect((await onlyRow(eventsOf(world))).properties).toMatchObject({
      name: "Sprint review (renamed)",
      place: "My room",
    });
  });

  it("keeps the time the user moved the Event to and still writes the other fields the organizer changed", async () => {
    await answeredInvitation("accepted");
    const event = await onlyRow(eventsOf(world));
    await userEdit(event.id, { timeFrom: "16:00", timeTo: "17:00" });

    await update({ ...MOVED, location: "Room 9" });

    expect((await onlyRow(eventsOf(world))).properties).toMatchObject({
      date: "2026-10-22",
      timeFrom: "16:00",
      timeTo: "17:00",
      place: "Room 9",
    });
    expect((await onlyRow(invitationsOf(world))).properties).toMatchObject({
      startsAt: "2026-10-22T12:00:00.000Z",
      endsAt: "2026-10-22T13:00:00.000Z",
    });
  });

  it("decides each time field by itself: the end follows the organizer when only the start was moved by the user", async () => {
    await answeredInvitation("accepted");
    const event = await onlyRow(eventsOf(world));
    await userEdit(event.id, { timeFrom: "12:00" });

    await update(MOVED);

    expect((await onlyRow(eventsOf(world))).properties).toMatchObject({ timeFrom: "12:00", timeTo: "15:00" });
  });

  it("keeps a date the user changed and moves the times", async () => {
    await answeredInvitation("accepted");
    const event = await onlyRow(eventsOf(world));
    await userEdit(event.id, { date: "2026-10-23" });

    await update({ dtStart: "DTSTART:20261023T120000Z", dtEnd: "DTEND:20261023T130000Z" });

    expect((await onlyRow(eventsOf(world))).properties).toMatchObject({
      date: "2026-10-23",
      timeFrom: "14:00",
      timeTo: "15:00",
    });
  });

  it("clears a place the organizer removed when the user has not changed it, and keeps the one the user changed", async () => {
    await answeredInvitation("accepted");
    await update({ location: null });
    expect((await onlyRow(eventsOf(world))).properties.place).toBeNull();
    expect((await onlyRow(invitationsOf(world))).properties.place).toBeNull();
  });

  it("keeps the place the user wrote when the organizer removes theirs", async () => {
    await answeredInvitation("accepted");
    await userEdit((await onlyRow(eventsOf(world))).id, { place: "My room" });
    await update({ location: null });
    expect((await onlyRow(eventsOf(world))).properties.place).toBe("My room");
  });

  it("carries an update of a meeting that had no end, whose Event got the default end", async () => {
    await answeredInvitation("accepted", { dtEnd: null });
    const event = await onlyRow(eventsOf(world));
    expect(event.properties).toMatchObject({ timeFrom: "13:00", timeTo: "14:00" });

    await update({ dtStart: "DTSTART:20261022T130000Z", dtEnd: null });

    expect((await onlyRow(eventsOf(world))).properties).toMatchObject({ timeFrom: "15:00", timeTo: "16:00" });
  });

  it("carries an end the organizer adds to a meeting that had none", async () => {
    await answeredInvitation("accepted", { dtEnd: null });
    await update({ dtEnd: "DTEND:20261022T133000Z" });
    expect((await onlyRow(eventsOf(world))).properties).toMatchObject({ timeFrom: "13:00", timeTo: "15:30" });
  });

  it("moves an all-day Event to the new day", async () => {
    await answeredInvitation("accepted", {
      dtStart: "DTSTART;VALUE=DATE:20261022",
      dtEnd: "DTEND;VALUE=DATE:20261023",
    });
    const event = await onlyRow(eventsOf(world));
    expect(event.properties).toMatchObject({ date: "2026-10-22" });
    expect(event.properties.timeFrom ?? null).toBeNull();

    await update({ dtStart: "DTSTART;VALUE=DATE:20261026", dtEnd: "DTEND;VALUE=DATE:20261028" });

    expect((await onlyRow(eventsOf(world))).properties).toMatchObject({ date: "2026-10-26", endDate: "2026-10-27" });
  });

  it("reads the new times in the tenant's time zone", async () => {
    await setTenantTimeZone("America/New_York");
    await answeredInvitation("accepted");
    expect((await onlyRow(eventsOf(world))).properties).toMatchObject({ timeFrom: "07:00", timeTo: "08:00" });

    await update(MOVED);

    expect((await onlyRow(eventsOf(world))).properties).toMatchObject({ timeFrom: "08:00", timeTo: "09:00" });
  });

  it("updates the invitation of a declined one and leaves its trashed Event exactly as it was", async () => {
    const accepted = await answeredInvitation("accepted");
    await mail.respond(tenant, accepted.id, "declined");
    const declined = await onlyRow(invitationsOf(world));
    const trashed = await onlyRow(eventsOf(world));
    expect(trashed.deleted_at).not.toBeNull();

    const emailItemId = await update({ ...MOVED, summary: "Sprint review (moved)" });

    const invitation = await onlyRow(invitationsOf(world));
    expect(invitation.properties).toEqual({
      ...declined.properties,
      title: "Sprint review (moved)",
      startsAt: "2026-10-22T12:00:00.000Z",
      endsAt: "2026-10-22T13:00:00.000Z",
      sequence: 1,
    });
    expect(invitation.properties.status).toBe("declined");
    expect(await edgesOf(world, invitation.id, "sourceEmail")).toEqual([emailItemId]);
    expect(await eventsOf(world)).toEqual([trashed]);
  });

  it("updates the invitation of a declined one that never had an Event, and creates none", async () => {
    await mail.deliver(world, "<request@example.test>", ics());
    const pending = await onlyRow(invitationsOf(world));
    await mail.respond(tenant, pending.id, "declined");

    await update(MOVED);

    expect((await onlyRow(invitationsOf(world))).properties).toMatchObject({
      status: "declined",
      startsAt: "2026-10-22T12:00:00.000Z",
      sequence: 1,
    });
    expect(await eventsOf(world)).toEqual([]);
  });

  it("updates the invitation and leaves the Event the user trashed as it was", async () => {
    await answeredInvitation("accepted");
    const event = await onlyRow(eventsOf(world));
    await runInTenant(world.tenantId, () => world.cp.softDeleteItem(world.databases.events!, event.id));
    const trashed = await onlyRow(eventsOf(world));
    expect(trashed.deleted_at).not.toBeNull();

    await update(MOVED);

    expect((await onlyRow(invitationsOf(world))).properties).toMatchObject({
      status: "accepted",
      startsAt: "2026-10-22T12:00:00.000Z",
    });
    expect(await eventsOf(world)).toEqual([trashed]);
  });

  it("leaves the Event alone when the update changes none of its fields", async () => {
    await answeredInvitation("accepted");
    const event = await onlyRow(eventsOf(world));

    await update({ sequence: 1 });

    expect(await eventsOf(world)).toEqual([event]);
    expect((await onlyRow(invitationsOf(world))).properties.sequence).toBe(1);
  });

  it("writes no notification and queues no push for an update", async () => {
    await answeredInvitation("accepted");
    const before = await notificationsOf(world.tenantId);
    expect(before).toHaveLength(1);

    await update(MOVED);

    expect(await notificationsOf(world.tenantId)).toEqual(before);
    const { rows } = await admin.query<{ count: string }>(
      `SELECT count(*) FROM graphile_worker._private_jobs j
         JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier IN ('notificationFanout', 'pushDismiss')`,
    );
    // The invitation's own notification queued one fan-out and its answer one dismiss.
    expect(Number(rows[0]!.count)).toBe(2);
  });

  describe("an update that changes nothing", () => {
    it.each([
      ["an equal", 3, 3],
      ["a lower", 3, 2],
    ])("carries %s SEQUENCE", async (_name, stored, incoming) => {
      await mail.deliver(world, "<base@example.test>", ics({ sequence: stored }));
      await mail.respond(tenant, (await onlyRow(invitationsOf(world))).id, "accepted");
      const before = {
        invitations: await invitationsOf(world),
        events: await eventsOf(world),
        notifications: await notificationsOf(world.tenantId),
      };

      const emailItemId = await update({ ...MOVED, sequence: incoming, summary: "Changed" });

      expect(emailItemId).toBeDefined();
      expect({
        invitations: await invitationsOf(world),
        events: await eventsOf(world),
        notifications: await notificationsOf(world.tenantId),
      }).toEqual(before);
    });

    it("is for a cancelled invitation, whatever the SEQUENCE, and leaves its trashed Event", async () => {
      await answeredInvitation("accepted");
      await mail.deliver(world, "<cancel@example.test>", ics({ method: "CANCEL", sequence: 1 }));
      const before = { invitations: await invitationsOf(world), events: await eventsOf(world) };
      expect(before.invitations[0]!.properties.status).toBe("cancelled");
      expect(before.events[0]!.deleted_at).not.toBeNull();

      await update({ ...MOVED, sequence: 9, summary: "Changed" });

      expect({ invitations: await invitationsOf(world), events: await eventsOf(world) }).toEqual(before);
    });

    describe("comes from a sender that is not the organizer", () => {
      /** The invitation, its Event and the notifications of the tenant. */
      async function snapshot() {
        return {
          invitations: await invitationsOf(world),
          events: await eventsOf(world),
          notifications: await notificationsOf(world.tenantId),
        };
      }

      it.each(["accepted", "declined"])(
        "changes neither the %s invitation nor its Event, and logs the ids and a reason code only",
        async (response) => {
          const warn = vi.spyOn(logger, "warn");
          const info = vi.spyOn(logger, "info");
          await answeredInvitation(response);
          const before = await snapshot();
          const invitation = before.invitations[0]!;

          const emailItemId = await mail.deliver(
            world,
            "<forged@example.test>",
            ics({
              summary: "Moved by someone else",
              location: "Mallory's room",
              organizer: "ORGANIZER:mailto:mallory@example.test",
              sequence: 1,
              ...MOVED,
            }),
            "mallory@example.test",
          );

          expect(await snapshot()).toEqual(before);
          expect(await edgesOf(world, invitation.id, "sourceEmail")).not.toContain(emailItemId);
          expect(warn).toHaveBeenCalledWith(
            { emailItemId, invitationItemId: invitation.id, reason: "sender_not_organizer" },
            "calendar invitation update ignored",
          );
          expect(loggedText(warn, info)).not.toContain(SECRET);
          expect(loggedText(warn, info)).not.toContain("mallory");
        },
      );

      it("names no sender", async () => {
        await answeredInvitation("accepted");
        const before = await snapshot();

        await mail.deliver(world, "<anonymous@example.test>", ics({ summary: SECRET, sequence: 1, ...MOVED }), null);

        expect(await snapshot()).toEqual(before);
      });

      it("carries an end before the start, which fails nothing because nothing is applied", async () => {
        await answeredInvitation("accepted");
        const before = await snapshot();

        // An end before the start would roll the whole email back if the update were applied.
        await mail.deliver(
          world,
          "<bad-end@example.test>",
          ics({ sequence: 1, dtStart: "DTSTART:20261022T120000Z", dtEnd: "DTEND:20261022T100000Z" }),
          "mallory@example.test",
        );

        expect(await snapshot()).toEqual(before);
      });

      it("is the organizer's address in another letter case, which is applied", async () => {
        await answeredInvitation("accepted");

        await mail.deliver(
          world,
          "<upper@example.test>",
          ics({ summary: SECRET, sequence: 1, ...MOVED }),
          ORGANIZER_ADDRESS.toUpperCase(),
        );

        expect((await onlyRow(eventsOf(world))).properties).toMatchObject({ timeFrom: "14:00", timeTo: "15:00" });
        expect((await onlyRow(invitationsOf(world))).properties.sequence).toBe(1);
      });
    });

    it("is for an invitation in the trash", async () => {
      await answeredInvitation("accepted");
      const invitation = await onlyRow(invitationsOf(world));
      await runInTenant(world.tenantId, () => world.cp.softDeleteItem(world.databases.invitations!, invitation.id));
      const before = { invitations: await invitationsOf(world), events: await eventsOf(world) };

      await update({ ...MOVED, summary: "Changed" });

      expect({ invitations: await invitationsOf(world), events: await eventsOf(world) }).toEqual(before);
    });
  });

  it("rolls the whole email back, and logs the ids and a reason code, when the Events rules refuse the new fields", async () => {
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");
    const answered = await answeredInvitation("accepted");
    const event = await onlyRow(eventsOf(world));
    // The user ended the meeting at 18:00. The organizer's move to 19:00 would start it after that end.
    await userEdit(event.id, { timeTo: "18:00" });
    const before = {
      invitations: await invitationsOf(world),
      events: await eventsOf(world),
      sourceEmail: await edgesOf(world, answered.id, "sourceEmail"),
    };
    info.mockClear();
    const emailItemId = await mail.receive(
      world,
      "<refused@example.test>",
      ics({ summary: SECRET, sequence: 1, dtStart: "DTSTART:20261022T170000Z", dtEnd: "DTEND:20261022T180000Z" }),
    );

    const failure: unknown = await mail.ingest(world, emailItemId).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(failure).toBeInstanceOf(ValidationError);
    expect({
      invitations: await invitationsOf(world),
      events: await eventsOf(world),
      sourceEmail: await edgesOf(world, answered.id, "sourceEmail"),
    }).toEqual(before);
    expect(warn).toHaveBeenCalledWith(
      { emailItemId, invitationItemId: answered.id, reason: "event_validation_failed" },
      "calendar invitation update refused",
    );
    expect(loggedText(warn, info)).not.toContain(SECRET);
    expect(loggedText(warn, info)).not.toContain("19:00");
  });

  it("rolls the whole email back for a failure of the Event write that is no Events rule, and logs no Events reason code", async () => {
    const warn = vi.spyOn(logger, "warn");
    await answeredInvitation("accepted");
    const before = { invitations: await invitationsOf(world), events: await eventsOf(world) };
    const emailItemId = await mail.receive(world, "<broken-event@example.test>", ics({ sequence: 1, ...MOVED }));
    // A constraint that refuses an Events row ending at 15:00 (the invitation rows have no `timeTo`), standing in for a
    // failure of the Event write that is no Events rule; it is dropped below.
    await admin.query(
      "ALTER TABLE items ADD CONSTRAINT gh2007_refuse CHECK (properties->>'timeTo' IS DISTINCT FROM '15:00') NOT VALID",
    );
    try {
      await expect(mail.ingest(world, emailItemId)).rejects.toMatchObject({ code: "23514" });
    } finally {
      await admin.query("ALTER TABLE items DROP CONSTRAINT gh2007_refuse");
    }
    expect({ invitations: await invitationsOf(world), events: await eventsOf(world) }).toEqual(before);
    expect(warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "event_validation_failed" }),
      expect.any(String),
    );
  });

  it("logs the email and invitation ids and no content of the invitation when it updates one", async () => {
    const info = vi.spyOn(logger, "info");
    const warn = vi.spyOn(logger, "warn");
    const answered = await answeredInvitation("accepted");
    info.mockClear();

    const emailItemId = await update({ ...MOVED, location: "Secret room" });

    expect(info).toHaveBeenCalledWith({ emailItemId, invitationItemId: answered.id }, "calendar invitation updated");
    expect(loggedText(info, warn)).not.toContain(SECRET);
    expect(loggedText(info, warn)).not.toContain("Secret room");
  });

  it("updates the invitation and the Event of its own tenant only, when another tenant holds the same UID", async () => {
    await answeredInvitation("accepted");
    await mail.deliver(other.world, "<other-request@example.test>", ics());
    const otherInvitation = await onlyRow(invitationsOf(other.world));
    await mail.respond(other, otherInvitation.id, "accepted");
    const otherBefore = {
      invitations: await invitationsOf(other.world),
      events: await eventsOf(other.world),
      notifications: await notificationsOf(other.world.tenantId),
    };
    expect(otherBefore.invitations[0]!.properties.uid).toBe((await onlyRow(invitationsOf(world))).properties.uid);

    await update(MOVED);

    expect((await onlyRow(eventsOf(world))).properties).toMatchObject({ timeFrom: "14:00" });
    expect({
      invitations: await invitationsOf(other.world),
      events: await eventsOf(other.world),
      notifications: await notificationsOf(other.world.tenantId),
    }).toEqual(otherBefore);
  });
});
