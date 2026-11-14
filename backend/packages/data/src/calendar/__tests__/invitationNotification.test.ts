import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import "../../domainWriteHooks.js";
import { createUser } from "../../auth/usersStore.js";
import { withTransaction } from "../../db/pool.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { ingestEmailMessage } from "../../mail/ingest.js";
import { computeBadgeForUser } from "../../notifications/badgeCount.js";
import { createBadgeCountsRouteHandler } from "../../notifications/badgeCountsRoute.js";
import { handleNotificationFanoutTask } from "../../notifications/notificationFanoutJob.js";
import { patchNotificationPreferences } from "../../notifications/notificationPreferencesStore.js";
import { upsertApnsSubscription } from "../../push/pushSubscriptionsStore.js";
import type { PushSenders } from "../../push/pushSenders.js";
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
import { createInvitationIngestAction } from "../invitationIngestAction.js";
import { logger } from "../logger.js";
import { createRespondToInvitationRouteHandler } from "../invitationRouteHandlers.js";

/** The `calendar_invitation` notification of an invitation (issue gh-1954): its write, push, resolution and count. */

let admin: Pool;
let runtime: Pool;

const notificationRow = z.object({
  id: z.string(),
  user_id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  link_href: z.string().nullable(),
  source_table: z.string(),
  source_id: z.string(),
  transition_instance: z.string(),
  payload: z.record(z.string(), z.unknown()),
  read_at: z.date().nullable(),
  resolved_at: z.date().nullable(),
});
type NotificationRow = z.infer<typeof notificationRow>;

/** A storage that keeps the bytes it was given, so the ingest reads back what mail ingest wrote. */
function memoryStorage(): BlobStorageWriter {
  const blobs = new Map<string, Buffer>();
  return {
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
      const bytes = blobs.get(storageKey);
      if (!bytes) throw new Error(`No blob under ${storageKey}`);
      return Readable.from([bytes]);
    },
  };
}

interface IcsOptions {
  uid?: string;
  sequence?: number;
  /** `null` leaves SUMMARY out. */
  summary?: string | null;
  organizer?: string;
}

/** The text of an iMIP REQUEST of one UTC meeting. */
function ics(options: IcsOptions = {}): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${options.uid ?? "sprint-review@example.test"}`,
    `SEQUENCE:${options.sequence ?? 0}`,
    ...(options.summary === null ? [] : [`SUMMARY:${options.summary ?? "Sprint review"}`]),
    "DTSTART:20261120T090000Z",
    "DTEND:20261120T100000Z",
    options.organizer ?? "ORGANIZER;CN=Olga Organizer:mailto:olga@example.test",
    "ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION:mailto:me@example.test",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

let storage: BlobStorageWriter;

/** A message with one calendar part arrives through the sync writer; returns its Emails item id. */
async function receive(world: World, messageId: string, text: string): Promise<string> {
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
        attachments: [
          {
            filename: "invite.ics",
            contentType: "text/calendar",
            contentId: null,
            disposition: "inline" as const,
            openStream: () => Readable.from([Buffer.from(text)]),
          },
        ],
        storage,
        storageKeyPrefix: "invitation-notification",
      }),
    ),
  );
  return result.itemId;
}

/** Fires the ingest heartbeat action for `emailItemId` the way the heartbeat of the Emails database does. */
function ingest(world: World, emailItemId: string): Promise<void> {
  return runInTenant(world.tenantId, () =>
    createInvitationIngestAction(runtime, { storage })(
      { emailsDatabaseId: world.databases.emails, invitationsDatabaseId: world.databases.invitations },
      { heartbeatId: "test", projectItemId: "test", itemId: emailItemId },
    ),
  );
}

/** Delivers one message and ingests it; returns the Emails item id. */
async function deliver(world: World, messageId: string, text: string = ics()): Promise<string> {
  const emailItemId = await receive(world, messageId, text);
  await ingest(world, emailItemId);
  return emailItemId;
}

/** Every notification of the tenant, read as the runtime role inside that tenant, oldest first. */
async function notificationsOf(tenantId: string): Promise<NotificationRow[]> {
  return withTenantTransaction(runtime, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, user_id, kind, title, body, link_href, source_table, source_id, transition_instance, payload,
              read_at, resolved_at
         FROM notifications ORDER BY created_at, id`,
    );
    return z.array(notificationRow).parse(rows);
  });
}

/** The ids of every invitation of the tenant, trashed ones included, in id order. */
async function invitationIds(world: World): Promise<string[]> {
  return withTenantTransaction(runtime, world.tenantId, async (client) => {
    const { rows } = await client.query("SELECT id FROM items WHERE database_id = $1 ORDER BY id", [
      world.databases.invitations,
    ]);
    return z
      .array(z.object({ id: z.string() }))
      .parse(rows)
      .map((row) => row.id);
  });
}

async function onlyNotification(tenantId: string): Promise<NotificationRow> {
  const rows = await notificationsOf(tenantId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const jobRow = z.object({ key: z.string().nullable(), payload: z.unknown() });

/** The queued jobs of one task, as the key and the stored envelope. */
async function queuedJobs(task: string): Promise<Array<z.infer<typeof jobRow>>> {
  const { rows } = await admin.query(
    `SELECT j.key, j.payload
       FROM graphile_worker._private_jobs j
       JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      WHERE t.identifier = $1`,
    [task],
  );
  return z.array(jobRow).parse(rows);
}

/** `POST /api/calendar/invitations/:id/respond` as the session user of `tenantId`. */
function respond(tenantId: string, userId: string, invitationId: string, response: string): Promise<unknown> {
  return runInTenant(tenantId, () =>
    createRespondToInvitationRouteHandler(runtime)({
      params: { id: invitationId },
      body: { response },
      identity: { user: { id: userId } },
    }),
  );
}

const badgeBody = z.object({ pendingApprovals: z.number(), pendingInvites: z.number(), openInboxItems: z.number() });

/** The answer of `GET /api/badge-counts` for the session user `userId` of `tenantId`. */
async function badgeCountsOf(tenantId: string, userId: string): Promise<z.infer<typeof badgeBody>> {
  const answer = await runInTenant(tenantId, () =>
    createBadgeCountsRouteHandler(runtime)({ identity: { user: { id: userId } } }),
  );
  expect(answer.status).toBe(200);
  return badgeBody.parse(answer.body);
}

describe("calendar invitation notification (issue gh-1954)", () => {
  let world: World;
  let otherWorld: World;
  let userId: string;
  let otherUserId: string;

  /** A tenant with one English-speaking user, seeded, with its mail world. */
  async function tenantWithUser(): Promise<{ world: World; userId: string }> {
    const tenantId = await createTestTenant(admin);
    const user = await createUser(admin, {
      tenantId,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
      locale: "en",
    });
    await runInTenant(tenantId, () => seedSystem(runtime));
    return { world: await setupMailAttachmentWorld(runtime, tenantId), userId: user.id };
  }

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    ({ world, userId } = await tenantWithUser());
    ({ world: otherWorld, userId: otherUserId } = await tenantWithUser());
    storage = memoryStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  describe("creating an invitation", () => {
    it("writes exactly one unread, unresolved notification for the tenant's user with the invitation as its source", async () => {
      await deliver(world, "<one@example.test>");

      const [invitationId] = await invitationIds(world);
      const notification = await onlyNotification(world.tenantId);
      expect(notification).toMatchObject({
        user_id: userId,
        kind: "calendar_invitation",
        title: "Olga Organizer invites you: Sprint review",
        body: null,
        link_href: null,
        source_table: "items",
        source_id: invitationId,
        transition_instance: "created",
        payload: { invitationId },
        read_at: null,
        resolved_at: null,
      });
    });

    it("renders the title in the language of the tenant's user", async () => {
      await admin.query("UPDATE users SET locale = 'cs' WHERE id = $1", [userId]);
      await deliver(world, "<cs@example.test>");

      expect((await onlyNotification(world.tenantId)).title).toBe("Olga Organizer vás zve: Sprint review");
    });

    it("names the organizer by address when the organizer has no name", async () => {
      await deliver(world, "<no-cn@example.test>", ics({ organizer: "ORGANIZER:mailto:olga@example.test" }));

      expect((await onlyNotification(world.tenantId)).title).toBe("olga@example.test invites you: Sprint review");
    });

    it("leaves the organizer and the title empty when the message carries neither", async () => {
      await deliver(world, "<bare@example.test>", ics({ summary: null, organizer: "ORGANIZER:not-an-address" }));

      expect((await onlyNotification(world.tenantId)).title).toBe(" invites you: ");
    });

    it("cuts the title of the invitation to 120 characters and leaves a title of exactly 120 whole", async () => {
      await deliver(world, "<long@example.test>", ics({ uid: "long", summary: "ž".repeat(130) }));
      await deliver(world, "<exact@example.test>", ics({ uid: "exact", summary: "ž".repeat(120) }));

      const titles = (await notificationsOf(world.tenantId)).map((row) => row.title);
      expect(titles).toEqual([
        `Olga Organizer invites you: ${"ž".repeat(120)}`,
        `Olga Organizer invites you: ${"ž".repeat(120)}`,
      ]);
    });

    it("never cuts a character outside the basic plane in half when it ends the 120 characters", async () => {
      await deliver(world, "<emoji@example.test>", ics({ summary: `${"a".repeat(119)}😀😀` }));

      expect((await onlyNotification(world.tenantId)).title).toBe(`Olga Organizer invites you: ${"a".repeat(119)}😀`);
    });

    it("queues the fan-out job of the notification, so the push follows the commit", async () => {
      await deliver(world, "<job@example.test>");

      const notification = await onlyNotification(world.tenantId);
      expect((await queuedJobs("notificationFanout")).map((job) => job.key)).toEqual([
        `notification-fanout:${notification.id}`,
      ]);
    });

    it("writes the invitation and no notification when the tenant has no user, and logs a reason code only", async () => {
      const warn = vi.spyOn(logger, "warn");
      await admin.query("DELETE FROM users WHERE id = $1", [userId]);
      const emailItemId = await deliver(world, "<no-user@example.test>");

      const [invitationId] = await invitationIds(world);
      expect(invitationId).toBeDefined();
      expect(await notificationsOf(world.tenantId)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        { emailItemId, invitationItemId: invitationId, reason: "no_tenant_user" },
        "calendar invitation not notified",
      );
    });

    it("rolls the invitation back with the notification when the notification cannot be written", async () => {
      const emailItemId = await receive(world, "<rollback@example.test>", ics());
      // A constraint that refuses every new notification, standing in for a failed insert; it is dropped below.
      await admin.query("ALTER TABLE notifications ADD CONSTRAINT gh1954_refuse CHECK (false) NOT VALID");
      try {
        await expect(ingest(world, emailItemId)).rejects.toMatchObject({ code: "23514" });
      } finally {
        await admin.query("ALTER TABLE notifications DROP CONSTRAINT gh1954_refuse");
      }

      expect(await invitationIds(world)).toEqual([]);
      expect(await notificationsOf(world.tenantId)).toEqual([]);
      expect(await queuedJobs("notificationFanout")).toEqual([]);
    });

    it("notifies the user of the tenant the invitation belongs to and nobody else", async () => {
      await deliver(world, "<tenant-a@example.test>");

      expect((await onlyNotification(world.tenantId)).user_id).toBe(userId);
      expect(await notificationsOf(otherWorld.tenantId)).toEqual([]);

      await deliver(otherWorld, "<tenant-b@example.test>");
      expect((await onlyNotification(otherWorld.tenantId)).user_id).toBe(otherUserId);
      expect(await notificationsOf(world.tenantId)).toHaveLength(1);
    });
  });

  describe("a repeated or updated invitation", () => {
    it("writes no second notification when the same message is processed twice", async () => {
      const emailItemId = await receive(world, "<twice@example.test>", ics());
      await ingest(world, emailItemId);
      await ingest(world, emailItemId);

      expect(await notificationsOf(world.tenantId)).toHaveLength(1);
      expect(await queuedJobs("notificationFanout")).toHaveLength(1);
    });

    it("writes no second notification for a message of the same UID and SEQUENCE", async () => {
      await deliver(world, "<same-1@example.test>");
      await deliver(world, "<same-2@example.test>");

      expect(await notificationsOf(world.tenantId)).toHaveLength(1);
    });

    it("writes no second notification when a higher SEQUENCE updates the invitation, and leaves the first one as it was", async () => {
      await deliver(world, "<seq-0@example.test>");
      const before = await onlyNotification(world.tenantId);

      await deliver(world, "<seq-1@example.test>", ics({ sequence: 1, summary: "Sprint review, moved" }));

      expect(await invitationIds(world)).toHaveLength(1);
      expect(await onlyNotification(world.tenantId)).toEqual(before);
      expect(await queuedJobs("notificationFanout")).toHaveLength(1);
    });

    it("writes one notification for each invitation of another UID", async () => {
      await deliver(world, "<uid-a@example.test>", ics({ uid: "a@example.test" }));
      await deliver(world, "<uid-b@example.test>", ics({ uid: "b@example.test" }));

      const notifications = await notificationsOf(world.tenantId);
      expect(notifications.map((row) => row.source_id).sort()).toEqual((await invitationIds(world)).sort());
    });
  });

  describe("the push", () => {
    function senders() {
      return {
        sendWebPush: vi.fn<PushSenders["sendWebPush"]>().mockResolvedValue({ outcome: "delivered" }),
        sendApns: vi.fn<PushSenders["sendApns"]>().mockResolvedValue({ outcome: "delivered" }),
      };
    }

    async function addApnsRegistration(): Promise<void> {
      await runInTenant(world.tenantId, () =>
        upsertApnsSubscription(runtime, {
          userId,
          sessionId: null,
          platform: "ios",
          deviceToken: "device-token-invitation",
          apnsEnvironment: "sandbox",
        }),
      );
    }

    it("carries the CALENDAR_INVITATION category and the invitation id to the APNs sender, with the badge of the invitation", async () => {
      await addApnsRegistration();
      await deliver(world, "<push@example.test>");
      const [invitationId] = await invitationIds(world);
      const notification = await onlyNotification(world.tenantId);
      const sent = senders();

      await runInTenant(world.tenantId, () =>
        handleNotificationFanoutTask(runtime, { notificationId: notification.id }, sent),
      );

      expect(sent.sendApns).toHaveBeenCalledTimes(1);
      expect(sent.sendApns.mock.calls[0]![1]).toMatchObject({
        notificationId: notification.id,
        title: "Olga Organizer invites you: Sprint review",
        linkHref: null,
        interruptionLevel: "active",
        kind: "calendar_invitation",
        badge: 1,
        apns: { category: "CALENDAR_INVITATION", data: { invitation_id: invitationId } },
      });
    });

    it("stores the notification and sends no push once the invites category is switched off", async () => {
      await addApnsRegistration();
      await runInTenant(world.tenantId, () =>
        withTransaction(runtime, (client) => patchNotificationPreferences(client, userId, { invites: false })),
      );
      await deliver(world, "<off@example.test>");
      const notification = await onlyNotification(world.tenantId);
      const sent = senders();

      await runInTenant(world.tenantId, () =>
        handleNotificationFanoutTask(runtime, { notificationId: notification.id }, sent),
      );

      expect(sent.sendApns).not.toHaveBeenCalled();
      expect(sent.sendWebPush).not.toHaveBeenCalled();
    });
  });

  describe("answering the invitation", () => {
    /** Delivers the sprint review and returns the invitation id with its notification. */
    async function pendingInvitation(): Promise<{ invitationId: string; notification: NotificationRow }> {
      await deliver(world, `<answer-${randomUUID()}@example.test>`);
      const [invitationId] = await invitationIds(world);
      return { invitationId: invitationId!, notification: await onlyNotification(world.tenantId) };
    }

    it.each(["accepted", "tentative", "declined"])(
      "resolves and reads the notification and queues the silent dismiss push when the answer is %s",
      async (response) => {
        const { invitationId, notification } = await pendingInvitation();

        await respond(world.tenantId, userId, invitationId, response);

        const resolved = await onlyNotification(world.tenantId);
        expect(resolved.id).toBe(notification.id);
        expect(resolved.resolved_at).toBeInstanceOf(Date);
        expect(resolved.read_at).toBeInstanceOf(Date);
        const dismissals = await queuedJobs("pushDismiss");
        expect(dismissals).toHaveLength(1);
        expect(JSON.stringify(dismissals[0]!.payload)).toContain(notification.id);
      },
    );

    it("changes nothing about the notification, and queues no second dismiss, when the same answer is repeated", async () => {
      const { invitationId } = await pendingInvitation();
      await respond(world.tenantId, userId, invitationId, "accepted");
      const afterFirst = await onlyNotification(world.tenantId);

      await respond(world.tenantId, userId, invitationId, "accepted");

      expect(await onlyNotification(world.tenantId)).toEqual(afterFirst);
      expect(await queuedJobs("pushDismiss")).toHaveLength(1);
    });

    it("leaves the notification unresolved when the answer is refused and rolled back", async () => {
      const { invitationId, notification } = await pendingInvitation();

      // A calendar that is not one of the tenant's own is refused after the Event write started.
      await expect(
        runInTenant(world.tenantId, () =>
          createRespondToInvitationRouteHandler(runtime)({
            params: { id: invitationId },
            body: { response: "accepted", calendarId: randomUUID() },
            identity: { user: { id: userId } },
          }),
        ),
      ).rejects.toMatchObject({ details: { field: "calendarId" } });

      expect(await onlyNotification(world.tenantId)).toEqual(notification);
      expect(await queuedJobs("pushDismiss")).toEqual([]);
    });

    it("leaves the notification unresolved when the answer does not fit the invitation", async () => {
      const { invitationId, notification } = await pendingInvitation();

      await expect(respond(world.tenantId, userId, invitationId, "acknowledged")).rejects.toMatchObject({
        details: { field: "response" },
      });

      expect(await onlyNotification(world.tenantId)).toEqual(notification);
      expect(await queuedJobs("pushDismiss")).toEqual([]);
    });

    it("does not resolve the notification when another tenant answers with the invitation's id", async () => {
      const { invitationId, notification } = await pendingInvitation();

      await expect(respond(otherWorld.tenantId, otherUserId, invitationId, "accepted")).rejects.toMatchObject({
        status: 404,
      });

      expect(await onlyNotification(world.tenantId)).toEqual(notification);
      expect(await queuedJobs("pushDismiss")).toEqual([]);
    });
  });

  describe("pendingInvites of the badge counts", () => {
    it("is 0 for a tenant without an invitation", async () => {
      expect(await badgeCountsOf(world.tenantId, userId)).toEqual({
        pendingApprovals: 0,
        pendingInvites: 0,
        openInboxItems: 0,
      });
    });

    it("counts each pending invitation and drops by one after an answer", async () => {
      await deliver(world, "<count-a@example.test>", ics({ uid: "a@example.test" }));
      await deliver(world, "<count-b@example.test>", ics({ uid: "b@example.test" }));
      await deliver(world, "<count-c@example.test>", ics({ uid: "c@example.test" }));
      expect((await badgeCountsOf(world.tenantId, userId)).pendingInvites).toBe(3);

      const [first, second] = await invitationIds(world);
      await respond(world.tenantId, userId, first!, "declined");
      expect((await badgeCountsOf(world.tenantId, userId)).pendingInvites).toBe(2);

      await respond(world.tenantId, userId, second!, "tentative");
      expect((await badgeCountsOf(world.tenantId, userId)).pendingInvites).toBe(1);
    });

    it("does not count a trashed invitation, although its status is still pending", async () => {
      await deliver(world, "<trash-a@example.test>", ics({ uid: "a@example.test" }));
      await deliver(world, "<trash-b@example.test>", ics({ uid: "b@example.test" }));
      const [trashed] = await invitationIds(world);
      // The Trash move of an invitation belongs to a later source; the row is trashed directly to give the count one.
      await admin.query("UPDATE items SET deleted_at = now() WHERE id = $1", [trashed]);

      expect((await badgeCountsOf(world.tenantId, userId)).pendingInvites).toBe(1);
    });

    it("counts only the invitations of the tenant in scope", async () => {
      await deliver(world, "<iso-a@example.test>", ics({ uid: "a@example.test" }));
      await deliver(world, "<iso-b@example.test>", ics({ uid: "b@example.test" }));
      await deliver(otherWorld, "<iso-c@example.test>", ics({ uid: "c@example.test" }));

      expect((await badgeCountsOf(world.tenantId, userId)).pendingInvites).toBe(2);
      expect((await badgeCountsOf(otherWorld.tenantId, otherUserId)).pendingInvites).toBe(1);
    });

    it("enters the badge of the user while the invites switch is on, and leaves it while the switch is off", async () => {
      await deliver(world, "<badge-a@example.test>", ics({ uid: "a@example.test" }));
      await deliver(world, "<badge-b@example.test>", ics({ uid: "b@example.test" }));
      const badge = () =>
        runInTenant(world.tenantId, () => withTransaction(runtime, (client) => computeBadgeForUser(client, userId)));
      expect(await badge()).toBe(2);

      await runInTenant(world.tenantId, () =>
        withTransaction(runtime, (client) => patchNotificationPreferences(client, userId, { badgeInvites: false })),
      );
      expect(await badge()).toBe(0);
    });
  });
});
