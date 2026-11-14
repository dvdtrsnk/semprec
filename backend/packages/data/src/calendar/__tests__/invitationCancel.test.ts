import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import "../../domainWriteHooks.js";
import { restoreItemWithClient } from "../../chokePoint/itemTrash.js";
import { withTransaction } from "../../db/pool.js";
import { ConflictError } from "../../errors.js";
import { createBadgeCountsRouteHandler } from "../../notifications/badgeCountsRoute.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
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

/** The organizer's `CANCEL` of an incoming invitation (issue gh-2006): its status, its Event and its notification. */

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

/** `pendingInvites` of `GET /api/badge-counts` for the session user of the tenant. */
async function pendingInvitesOf(tenant: MailTenant): Promise<number> {
  const answer = await runInTenant(tenant.world.tenantId, () =>
    createBadgeCountsRouteHandler(runtime)({ identity: { user: { id: tenant.userId } } }),
  );
  expect(answer.status).toBe(200);
  return z.object({ pendingInvites: z.number() }).parse(answer.body).pendingInvites;
}

/** Every argument that the spied logger methods were called with, as text. */
function loggedText(...spies: Array<{ mock: { calls: unknown[][] } }>): string {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
}

describe("an organizer's CANCEL of an invitation (issue gh-2006)", () => {
  let tenant: MailTenant;
  let world: World;
  let other: MailTenant;

  /** A pending "Sprint review" arrives from the organizer; returns its invitation row. */
  async function receiveInvitation(options: { sequence?: number } = {}): Promise<ItemRow> {
    await mail.deliver(world, "<request@example.test>", ics({ sequence: options.sequence, summary: SECRET }));
    return onlyRow(invitationsOf(world));
  }

  /** The invitation arrives and the user answers it, which makes the Event of `accepted` and `tentative`. */
  async function answeredInvitation(response: string): Promise<ItemRow> {
    const invitation = await receiveInvitation();
    await mail.respond(tenant, invitation.id, response);
    return onlyRow(invitationsOf(world));
  }

  /** A `CANCEL` message arrives and is ingested; returns the Emails item id. */
  function cancel(
    options: { from?: string | null; sequence?: number; uid?: string; id?: string } = {},
  ): Promise<string> {
    return mail.deliver(
      world,
      options.id ?? "<cancel@example.test>",
      ics({ method: "CANCEL", sequence: options.sequence ?? 1, uid: options.uid, summary: SECRET }),
      options.from,
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

  it("cancels a pending invitation, stores the sequence of the CANCEL, resolves its notification and drops pendingInvites by one", async () => {
    const pending = await receiveInvitation();
    const [notification] = await notificationsOf(world.tenantId);
    expect(notification).toMatchObject({ source_id: pending.id, resolved_at: null });
    expect(await pendingInvitesOf(tenant)).toBe(1);

    await cancel({ sequence: 1 });

    const cancelled = await onlyRow(invitationsOf(world));
    expect(cancelled.id).toBe(pending.id);
    expect(cancelled.deleted_at).toBeNull();
    expect(cancelled.properties).toEqual({ ...pending.properties, status: "cancelled", sequence: 1 });
    const [resolved, ...rest] = await notificationsOf(world.tenantId);
    expect(rest).toEqual([]);
    expect(resolved).toMatchObject({ id: notification!.id, source_id: pending.id });
    expect(resolved!.resolved_at).not.toBeNull();
    expect(await pendingInvitesOf(tenant)).toBe(0);
    expect(await eventsOf(world)).toEqual([]);
  });

  it.each(["accepted", "tentative"])(
    "cancels a %s invitation, trashes its Event without deleting it, keeps the answer, and the Event can be restored",
    async (response) => {
      const answered = await answeredInvitation(response);
      const event = await onlyRow(eventsOf(world));
      expect(event.deleted_at).toBeNull();

      await cancel({ sequence: 1 });

      const cancelled = await onlyRow(invitationsOf(world));
      expect(cancelled.properties).toEqual({ ...answered.properties, status: "cancelled", sequence: 1 });
      expect(cancelled.properties.respondedAt).toBe(answered.properties.respondedAt);
      const trashed = await onlyRow(eventsOf(world));
      expect(trashed.id).toBe(event.id);
      expect(trashed.deleted_at).not.toBeNull();
      expect(trashed.properties).toEqual(event.properties);

      const restored = await runInTenant(world.tenantId, () =>
        withTransaction(runtime, (client) =>
          restoreItemWithClient(client, world.databases.events!, event.id, createActionQueueAffinity(), tenant.userId, {
            writerKind: "user",
          }),
        ),
      );
      expect(restored?.deletedAt).toBeNull();
      const back = await onlyRow(eventsOf(world));
      expect(back.deleted_at).toBeNull();
      expect(back.properties).toEqual(event.properties);
      expect((await onlyRow(invitationsOf(world))).properties.status).toBe("cancelled");
    },
  );

  it("cancels an answered invitation whose Event is already in the trash and leaves that Event as it was", async () => {
    await answeredInvitation("accepted");
    await mail.respond(tenant, (await onlyRow(invitationsOf(world))).id, "declined");
    const trashedBefore = await onlyRow(eventsOf(world));
    expect(trashedBefore.deleted_at).not.toBeNull();

    await cancel({ sequence: 1 });

    expect((await onlyRow(invitationsOf(world))).properties.status).toBe("cancelled");
    expect(await eventsOf(world)).toEqual([trashedBefore]);
  });

  it("cancels a declined invitation that never had an Event", async () => {
    const pending = await receiveInvitation();
    await mail.respond(tenant, pending.id, "declined");
    expect(await eventsOf(world)).toEqual([]);

    await cancel({ sequence: 1 });

    expect((await onlyRow(invitationsOf(world))).properties.status).toBe("cancelled");
    expect(await eventsOf(world)).toEqual([]);
  });

  it("compares the sender with the organizer without regard to case, on either side", async () => {
    await mail.deliver(
      world,
      "<mixed-case@example.test>",
      ics({ organizer: "ORGANIZER;CN=Olga:mailto:Olga@Example.Test" }),
    );
    await cancel({ from: "OLGA@EXAMPLE.TEST", sequence: 1 });
    expect((await onlyRow(invitationsOf(world))).properties.status).toBe("cancelled");
  });

  describe("a CANCEL that changes nothing", () => {
    /** The invitation, its Event and its notification as they are, to be compared after the message. */
    async function snapshot() {
      return {
        invitations: await invitationsOf(world),
        events: await eventsOf(world),
        notifications: await notificationsOf(world.tenantId),
        pendingInvites: await pendingInvitesOf(tenant),
      };
    }

    it("comes from another sender address than the organizer's, and logs the ids and a reason code only", async () => {
      const warn = vi.spyOn(logger, "warn");
      const info = vi.spyOn(logger, "info");
      await answeredInvitation("accepted");
      const before = await snapshot();
      const invitation = before.invitations[0]!;

      const emailItemId = await cancel({ from: "mallory@example.test", sequence: 5 });

      expect(await snapshot()).toEqual(before);
      expect(before.events[0]!.deleted_at).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        { emailItemId, invitationItemId: invitation.id, reason: "sender_not_organizer" },
        "calendar cancellation ignored",
      );
      expect(loggedText(warn, info)).not.toContain(SECRET);
      expect(loggedText(warn, info)).not.toContain("mallory");
    });

    it("comes from a message that names no sender", async () => {
      const warn = vi.spyOn(logger, "warn");
      await receiveInvitation();
      const before = await snapshot();

      const emailItemId = await cancel({ from: null, sequence: 1 });

      expect(await snapshot()).toEqual(before);
      expect(warn).toHaveBeenCalledWith(
        { emailItemId, invitationItemId: before.invitations[0]!.id, reason: "sender_not_organizer" },
        "calendar cancellation ignored",
      );
    });

    it("comes from an invitation that stored no organizer address", async () => {
      await mail.deliver(world, "<no-organizer@example.test>", ics({ organizer: "ORGANIZER:not-an-address" }));
      const before = await snapshot();
      expect(before.invitations[0]!.properties.organizerEmail).toBeUndefined();

      await cancel({ sequence: 1 });

      expect(await snapshot()).toEqual(before);
    });

    it("is for a UID no invitation has, and creates none", async () => {
      await receiveInvitation();
      const before = await snapshot();
      await cancel({ uid: "unknown@example.test", sequence: 1 });
      expect(await snapshot()).toEqual(before);
    });

    it("carries a lower SEQUENCE than the stored one, and logs a reason code", async () => {
      const warn = vi.spyOn(logger, "warn");
      await receiveInvitation({ sequence: 3 });
      const before = await snapshot();

      const emailItemId = await cancel({ sequence: 2 });

      expect(await snapshot()).toEqual(before);
      expect(warn).toHaveBeenCalledWith(
        { emailItemId, invitationItemId: before.invitations[0]!.id, reason: "stale_sequence" },
        "calendar cancellation ignored",
      );
    });

    it.each([
      ["an equal", 3],
      ["a higher", 7],
    ])("cancels with %s SEQUENCE and stores the CANCEL's sequence", async (_name, sequence) => {
      await receiveInvitation({ sequence: 3 });
      await cancel({ sequence });
      expect((await onlyRow(invitationsOf(world))).properties).toMatchObject({ status: "cancelled", sequence });
    });

    it("is for an invitation in the trash", async () => {
      await answeredInvitation("accepted");
      const invitation = await onlyRow(invitationsOf(world));
      await runInTenant(world.tenantId, () => world.cp.softDeleteItem(world.databases.invitations!, invitation.id));
      const before = await snapshot();
      expect(before.invitations[0]!.deleted_at).not.toBeNull();

      await cancel({ sequence: 1 });

      expect(await snapshot()).toEqual(before);
    });

    it("is processed a second time, as the same email and as another email of the same CANCEL", async () => {
      const info = vi.spyOn(logger, "info");
      await answeredInvitation("accepted");
      const first = await cancel({ sequence: 1 });
      const after = await snapshot();
      expect(after.invitations[0]!.properties.status).toBe("cancelled");
      expect(after.events[0]!.deleted_at).not.toBeNull();
      expect(after.notifications[0]!.resolved_at).not.toBeNull();
      info.mockClear();

      await mail.ingest(world, first);
      await cancel({ sequence: 1, id: "<cancel-again@example.test>" });

      expect(await snapshot()).toEqual(after);
      expect(info).not.toHaveBeenCalledWith(expect.anything(), "calendar invitation cancelled");
    });

    it("is a REQUEST with a higher SEQUENCE for the cancelled invitation", async () => {
      await answeredInvitation("accepted");
      await cancel({ sequence: 1 });
      const after = await snapshot();

      await mail.deliver(
        world,
        "<late-request@example.test>",
        ics({ sequence: 9, summary: "Changed", dtStart: "DTSTART:20270101T090000Z" }),
      );

      expect(await snapshot()).toEqual(after);
    });

    it("is a calendar that holds only an occurrence with a RECURRENCE-ID", async () => {
      await receiveInvitation();
      const before = await snapshot();
      const text = ics({ method: "CANCEL", sequence: 1 }).replace(
        "SEQUENCE:1",
        "SEQUENCE:1\r\nRECURRENCE-ID:20261022T110000Z",
      );
      await mail.deliver(world, "<occurrence@example.test>", text);
      expect(await snapshot()).toEqual(before);
    });

    it("is malformed, and the action does not fail", async () => {
      await receiveInvitation();
      const before = await snapshot();
      const text =
        "BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\nBEGIN:VEVENT\r\nSUMMARY:no uid\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
      await mail.deliver(world, "<malformed@example.test>", text);
      expect(await snapshot()).toEqual(before);
    });
  });

  it("answering a cancelled invitation through the respond route is 409 conflict and writes nothing", async () => {
    await answeredInvitation("accepted");
    await cancel({ sequence: 1 });
    const invitations = await invitationsOf(world);
    const events = await eventsOf(world);

    const error: unknown = await mail.respond(tenant, invitations[0]!.id, "declined").then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ status: 409, code: "conflict" });
    expect(await invitationsOf(world)).toEqual(invitations);
    expect(await eventsOf(world)).toEqual(events);
  });

  it("applies the CANCEL part and the REQUEST part of one message, each to the invitation of its own UID", async () => {
    await receiveInvitation();
    const request = ics({ uid: "second@example.test", summary: "Second meeting" });
    await mail.deliver(world, "<cancel-and-request@example.test>", [ics({ method: "CANCEL", sequence: 1 }), request]);

    const invitations = await invitationsOf(world);
    expect(invitations.map((row) => [row.properties.uid, row.properties.status]).sort()).toEqual([
      ["second@example.test", "pending"],
      ["sprint-review@example.test", "cancelled"],
    ]);
  });

  it("rolls the whole email back when a step fails: the invitation stays answered, its Event live and its notification open", async () => {
    await answeredInvitation("accepted");
    // The answer resolved the notification, so the CANCEL would have nothing left to resolve; reopening it is a state
    // only SQL can write (the notification of an unanswered invitation, next to an Event the user has made).
    await admin.query("UPDATE notifications SET resolved_at = NULL");
    const before = {
      invitations: await invitationsOf(world),
      events: await eventsOf(world),
      notifications: await notificationsOf(world.tenantId),
    };
    expect(before.notifications[0]!.resolved_at).toBeNull();
    const emailItemId = await mail.receive(
      world,
      "<failing-cancel@example.test>",
      ics({ method: "CANCEL", sequence: 1 }),
    );
    // A constraint that refuses every write of a notification row, standing in for a failed resolution, the last step
    // of the cancellation; it is dropped below.
    await admin.query("ALTER TABLE notifications ADD CONSTRAINT gh2006_refuse CHECK (false) NOT VALID");
    try {
      await expect(mail.ingest(world, emailItemId)).rejects.toMatchObject({ code: "23514" });
    } finally {
      await admin.query("ALTER TABLE notifications DROP CONSTRAINT gh2006_refuse");
    }

    expect({
      invitations: await invitationsOf(world),
      events: await eventsOf(world),
      notifications: await notificationsOf(world.tenantId),
    }).toEqual(before);
  });

  it("applies the CANCEL in the tenant of its email only, when another tenant holds the same UID", async () => {
    await receiveInvitation();
    await mail.deliver(other.world, "<other-request@example.test>", ics({ summary: SECRET }));
    const otherBefore = {
      invitations: await invitationsOf(other.world),
      notifications: await notificationsOf(other.world.tenantId),
    };
    expect(otherBefore.invitations[0]!.properties.uid).toBe((await onlyRow(invitationsOf(world))).properties.uid);

    await cancel({ sequence: 1 });

    expect((await onlyRow(invitationsOf(world))).properties.status).toBe("cancelled");
    expect({
      invitations: await invitationsOf(other.world),
      notifications: await notificationsOf(other.world.tenantId),
    }).toEqual(otherBefore);
    expect(await pendingInvitesOf(other)).toBe(1);
  });

  it("logs the email and invitation ids and no content of the invitation when it cancels one", async () => {
    const info = vi.spyOn(logger, "info");
    const warn = vi.spyOn(logger, "warn");
    await answeredInvitation("accepted");
    info.mockClear();

    const emailItemId = await cancel({ sequence: 1 });

    const invitation = await onlyRow(invitationsOf(world));
    expect(info).toHaveBeenCalledWith(
      { emailItemId, invitationItemId: invitation.id },
      "calendar invitation cancelled",
    );
    expect(loggedText(info, warn)).not.toContain(SECRET);
    expect(loggedText(info, warn)).not.toContain(ORGANIZER_ADDRESS);
  });
});
