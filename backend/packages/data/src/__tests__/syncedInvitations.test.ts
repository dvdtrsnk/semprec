import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUser } from "../auth/usersStore.js";
import { createInvitationMail, ics } from "../calendar/__tests__/invitationMailFixtures.js";
import { createRespondToInvitationRouteHandler } from "../calendar/invitationRouteHandlers.js";
import { CalendarSyncProviderError, type RemoteEvent } from "../calendar/sync/adapter.js";
import { handleCalendarAccountSyncTask } from "../calendar/sync/calendarAccountSyncJob.js";
import { resolveCalendarSyncIds, type CalendarSyncIds } from "../calendar/sync/calendarSyncStore.js";
import { handleCalendarEventPushTask } from "../calendar/sync/eventPushJob.js";
import { handleCalendarInvitationRespondTask } from "../calendar/sync/invitationRespondJob.js";
import { readCalendarTimeline } from "../calendar/timelineRead.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { ConflictError } from "../errors.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeCalendarProvider, remoteFields } from "../testSupport/fakeCalendarSyncAdapter.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const USER_WRITER = { writerKind: "user" } as const;
const OWN_ADDRESS = "me@example.test";
const ORGANIZER = { email: "olga@example.test", name: "Olga Organizer", role: null, status: null };

let admin: Pool;
let runtime: Pool;
let tenant: string;
let userId: string;

function inTenant<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenant, () => withTransaction(runtime, fn));
}

async function ids(): Promise<CalendarSyncIds> {
  const resolved = await inTenant((client) => resolveCalendarSyncIds(client));
  if (resolved === null) throw new Error("the tenant has no calendar databases");
  return resolved;
}

/**
 * A meeting Olga invites the account to, as Google reports it: Friday 2026-11-27 10:00-11:00 in Prague, the
 * account's attendee marked `self` and still to answer.
 */
function googleInvitation(overrides: Partial<RemoteEvent> = {}): RemoteEvent {
  return {
    remoteId: "review",
    href: null,
    etag: '"review-1"',
    seriesRemoteId: null,
    fields: remoteFields({
      name: "Design review",
      date: "2026-11-27",
      timeFrom: "10:00",
      timeTo: "11:00",
      timeZone: "Europe/Prague",
      place: "Room 4",
    }),
    organizer: ORGANIZER,
    attendees: [
      { email: ORGANIZER.email, name: ORGANIZER.name, role: "required", status: "accepted" },
      { email: OWN_ADDRESS, name: "Me", role: "required", status: "needsAction" },
    ],
    icalUid: "review@google.com",
    sequence: 0,
    selfStatus: "needsAction",
    ...overrides,
  };
}

function provider(): FakeCalendarProvider {
  const fake = new FakeCalendarProvider();
  fake.addCalendar({ remoteId: "work", url: null, name: "Work", color: null, readOnly: false, ctag: null });
  return fake;
}

function runPass(accountId: string, fake: FakeCalendarProvider) {
  return runInTenant(tenant, () =>
    handleCalendarAccountSyncTask(runtime, { accountItemId: accountId }, { adapters: fake.registry() }),
  );
}

/** An account with Calendars on whose initial pass has run over the provider as it is. */
async function syncedAccount(fake: FakeCalendarProvider): Promise<string> {
  const { mailboxesDatabaseId } = await ids();
  const accountId = await inTenant(async (client) => {
    const account = await createChokePoint(runtime).createItem({
      databaseId: mailboxesDatabaseId,
      properties: { name: "Work account", provider: "generic", mailEnabled: true, calendarsEnabled: true },
    });
    await writeMailboxAddresses(client, { mailboxesDatabaseId, mailboxItemId: account.id, address: OWN_ADDRESS });
    await storeCredential(client, { itemId: account.id, credentialType: "plain_password", plaintext: "s3cret" });
    await ensureMailAccountSyncState(client, { itemId: account.id, syncMode: "imap" });
    return account.id;
  });
  expect((await runPass(accountId, fake))?.kind).toBe("applied");
  return accountId;
}

/** An account whose initial pass found nothing, and a pass after the invitation arrived at the provider. */
async function invited(fake: FakeCalendarProvider, event: RemoteEvent = googleInvitation()): Promise<string> {
  const accountId = await syncedAccount(fake);
  fake.putEvent("work", event);
  expect((await runPass(accountId, fake))?.kind).toBe("applied");
  return accountId;
}

const invitationRow = z.object({
  id: z.string(),
  deleted: z.boolean(),
  properties: z.record(z.string(), z.unknown()),
  event_ids: z.array(z.string()),
  mailbox_ids: z.array(z.string()),
});

/** Every Invitations row, trashed ones included, with the ids its `event` and `mailbox` relations reach. */
async function invitations() {
  return inTenant(async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT i.id, i.deleted_at IS NOT NULL AS deleted, i.properties,
              ARRAY(SELECT CASE WHEN r.item_a = i.id THEN r.item_b ELSE r.item_a END::text
                      FROM item_relations r JOIN properties p ON (p.config->>'relationDefinitionId')::uuid = r.relation_definition_id
                     WHERE p.database_id = d.id AND p.key = 'event' AND i.id IN (r.item_a, r.item_b)) AS event_ids,
              ARRAY(SELECT CASE WHEN r.item_a = i.id THEN r.item_b ELSE r.item_a END::text
                      FROM item_relations r JOIN properties p ON (p.config->>'relationDefinitionId')::uuid = r.relation_definition_id
                     WHERE p.database_id = d.id AND p.key = 'mailbox' AND i.id IN (r.item_a, r.item_b)) AS mailbox_ids
         FROM items i JOIN databases d ON d.id = i.database_id
        WHERE d.owner_module_id = 'invitations' AND d.system
        ORDER BY i.created_at, i.id`,
    );
    return z.array(invitationRow).parse(rows);
  });
}

async function onlyInvitation() {
  const [invitation, ...others] = await invitations();
  expect(others).toEqual([]);
  if (invitation === undefined) throw new Error("expected one invitation");
  return invitation;
}

const notificationRow = z.object({
  kind: z.string(),
  source_id: z.string(),
  transition_instance: z.string().nullable(),
  resolved: z.boolean(),
});

async function notifications() {
  return inTenant(async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT kind, source_id, transition_instance, resolved_at IS NOT NULL AS resolved FROM notifications
        WHERE kind = 'calendar_invitation' OR kind LIKE 'calendar_event_%' ORDER BY created_at, id`,
    );
    return z.array(notificationRow).parse(rows);
  });
}

const eventRow = z.object({ id: z.string(), deleted: z.boolean() });

/** The Events named `name`, trashed ones included. */
async function eventsNamed(name: string) {
  return inTenant(async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT i.id, i.deleted_at IS NOT NULL AS deleted FROM items i JOIN databases d ON d.id = i.database_id
        WHERE d.owner_module_id = 'events' AND d.system AND i.properties->>'name' = $1`,
      [name],
    );
    return z.array(eventRow).parse(rows);
  });
}

const timelineSchema = z.object({
  items: z.array(z.object({ id: z.string(), kind: z.string(), title: z.string().optional() })),
});

async function timelineTitled(title: string) {
  const timeline = await inTenant((client) =>
    readCalendarTimeline(client, { from: "2026-11-23", to: "2026-11-29", shape: "compact" }),
  );
  return timelineSchema.parse(timeline).items.filter((item) => item.title === title);
}

/** The queued jobs of a task, by key. */
async function jobKeys(taskIdentifier: string): Promise<string[]> {
  const { rows } = await admin.query<{ key: string | null }>(
    `SELECT j.key FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      WHERE t.identifier = $1 ORDER BY j.key`,
    [taskIdentifier],
  );
  return rows.map((row) => row.key ?? "");
}

async function respond(invitationId: string, response: string) {
  return runInTenant(tenant, () =>
    createRespondToInvitationRouteHandler(runtime)({
      params: { id: invitationId },
      body: { response },
      identity: { user: { id: userId } },
    }),
  );
}

/** The respond job of the latest answer, as the queue would run it. */
async function runRespondJob(fake: FakeCalendarProvider, options: { isFinalAttempt?: boolean } = {}) {
  const invitation = await onlyInvitation();
  const { status, respondedAt } = z
    .object({ status: z.enum(["accepted", "tentative", "declined"]), respondedAt: z.string() })
    .parse(invitation.properties);
  return runInTenant(tenant, () =>
    handleCalendarInvitationRespondTask(
      runtime,
      { invitationId: invitation.id, response: status, respondedAt: new Date(respondedAt).toISOString() },
      { adapters: fake.registry(), ...options },
    ),
  );
}

describe("invitations from synced calendars, answered through the provider", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  afterAll(async () => {
    await runtime.end();
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    const user = await createUser(admin, {
      tenantId: tenant,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
      locale: "en",
    });
    userId = user.id;
    await runInTenant(tenant, () => seedSystem(runtime));
  });

  it("shows a Google invitation once in Invitations and once in the timeline, notified once", async () => {
    const fake = provider();
    const accountId = await invited(fake);

    const [event, ...otherEvents] = await eventsNamed("Design review");
    expect(otherEvents).toEqual([]);
    const invitation = await onlyInvitation();
    expect(invitation).toEqual({
      id: expect.any(String),
      deleted: false,
      properties: expect.objectContaining({
        title: "Design review",
        startsAt: "2026-11-27T09:00:00.000Z",
        endsAt: "2026-11-27T10:00:00.000Z",
        timeZone: "Europe/Prague",
        allDay: false,
        place: "Room 4",
        organizerName: "Olga Organizer",
        organizerEmail: "olga@example.test",
        status: "pending",
        kind: "invite",
        uid: "review@google.com",
        sequence: 0,
      }),
      event_ids: [event!.id],
      mailbox_ids: [accountId],
    });
    expect(await timelineTitled("Design review")).toEqual([{ id: event!.id, kind: "event", title: "Design review" }]);
    // The invitation's notification stands for the Event's own "added" notice.
    expect(await notifications()).toEqual([
      { kind: "calendar_invitation", source_id: invitation.id, transition_instance: "sequence:0", resolved: false },
    ]);

    // A pass that finds the same version, and one that reads everything again, add nothing.
    await runPass(accountId, fake);
    // A calendar without a cursor is fetched in full; no API forgets a cursor, so it is cleared here.
    await inTenant((client) => client.query("UPDATE calendar_remote_state SET sync_token = NULL"));
    await runPass(accountId, fake);
    expect(await invitations()).toEqual([invitation]);
    expect(await notifications()).toHaveLength(1);
    expect(await eventsNamed("Design review")).toEqual([event]);
  });

  it("writes the invitation of the account's initial sync without notifying it", async () => {
    const fake = provider();
    fake.putEvent("work", googleInvitation());
    await syncedAccount(fake);

    expect((await onlyInvitation()).properties.status).toBe("pending");
    expect(await notifications()).toEqual([]);
  });

  it.each([
    ["the account is the organizer", { organizer: { ...ORGANIZER, email: "ME@example.test" } }],
    ["the account answered already", { selfStatus: "accepted" }],
    ["the account is no attendee", { selfStatus: null, attendees: [] }],
    ["it has no organizer", { organizer: null }],
  ])("writes no invitation when %s", async (_case, overrides: Partial<RemoteEvent>) => {
    const fake = provider();
    await invited(fake, googleInvitation(overrides));

    expect(await eventsNamed("Design review")).toHaveLength(1);
    expect(await invitations()).toEqual([]);
    expect(await notifications()).toEqual([expect.objectContaining({ kind: "calendar_event_added" })]);
  });

  it("finds a CalDAV attendee by the account's address, and one without PARTSTAT is still to answer", async () => {
    const fake = provider();
    await invited(
      fake,
      googleInvitation({
        selfStatus: undefined,
        icalUid: "review-uid",
        sequence: 2,
        attendees: [{ email: "Me@Example.test", name: null, role: "REQ-PARTICIPANT", status: null }],
      }),
    );

    expect((await onlyInvitation()).properties).toMatchObject({ status: "pending", uid: "review-uid", sequence: 2 });
  });

  it("accepts through the provider and sends no e-mail", async () => {
    const fake = provider();
    const accountId = await invited(fake);
    const [event] = await eventsNamed("Design review");
    const invitation = await onlyInvitation();

    const answered = await respond(invitation.id, "accepted");

    expect(answered).toMatchObject({ status: 200, item: { properties: { status: "accepted" } } });
    expect(await jobKeys("calendarInvitationRespond")).toEqual([`calendar-invitation-respond:${invitation.id}`]);
    expect(await jobKeys("calendarSendInvitationReply")).toEqual([]);
    expect(await notifications()).toEqual([expect.objectContaining({ kind: "calendar_invitation", resolved: true })]);
    expect(fake.responses).toEqual([]);

    expect(await runRespondJob(fake)).toEqual({ kind: "answered" });

    expect(fake.responses).toEqual([
      { remoteId: "review", response: "accepted", attendeeEmails: expect.arrayContaining([OWN_ADDRESS]) },
    ]);
    expect(fake.event("work", "review").selfStatus).toBe("accepted");
    expect(await jobKeys("calendarSendInvitationReply")).toEqual([]);
    expect(await jobKeys("calendarAccountSync")).toEqual([`calendar-account-sync:${accountId}`]);

    // The next pass brings the provider's answer back: the invitation and its Event stay as they are.
    await runPass(accountId, fake);
    expect((await onlyInvitation()).properties.status).toBe("accepted");
    expect(await eventsNamed("Design review")).toEqual([event]);
    expect(await notifications()).toHaveLength(1);
  });

  it("declines without trashing the Event here, and a provider that then removes it does not cancel the invitation", async () => {
    const fake = provider();
    const accountId = await invited(fake);
    const invitation = await onlyInvitation();

    await respond(invitation.id, "declined");
    expect(await eventsNamed("Design review")).toEqual([expect.objectContaining({ deleted: false })]);
    expect(await runRespondJob(fake)).toEqual({ kind: "answered" });
    // As Graph does with a declined meeting.
    fake.deleteEvent("work", "review");
    await runPass(accountId, fake);

    expect((await onlyInvitation()).properties.status).toBe("declined");
    expect(await eventsNamed("Design review")).toEqual([expect.objectContaining({ deleted: true })]);
  });

  it("cancels the invitation and trashes its Event when the organizer cancels the meeting", async () => {
    const fake = provider();
    const accountId = await invited(fake);

    fake.deleteEvent("work", "review");
    await runPass(accountId, fake);

    const invitation = await onlyInvitation();
    expect(invitation.properties.status).toBe("cancelled");
    expect(await eventsNamed("Design review")).toEqual([expect.objectContaining({ deleted: true })]);
    expect(await notifications()).toEqual([
      expect.objectContaining({ kind: "calendar_invitation", source_id: invitation.id, resolved: true }),
      expect.objectContaining({ kind: "calendar_event_cancelled" }),
    ]);
  });

  it("takes an answer given at the provider, and asks again when the organizer changes the meeting", async () => {
    const fake = provider();
    const accountId = await invited(fake);
    const invitation = await onlyInvitation();

    fake.putEvent("work", googleInvitation({ etag: '"review-2"', selfStatus: "tentative" }));
    await runPass(accountId, fake);
    expect((await onlyInvitation()).properties).toMatchObject({ status: "tentative", respondedAt: expect.any(String) });
    expect(await notifications()).toEqual([expect.objectContaining({ resolved: true })]);

    fake.putEvent(
      "work",
      googleInvitation({
        etag: '"review-3"',
        sequence: 1,
        fields: remoteFields({ name: "Design review", date: "2026-11-27", timeFrom: "14:00", timeTo: "15:00" }),
      }),
    );
    await runPass(accountId, fake);

    expect((await onlyInvitation()).properties).toMatchObject({
      status: "pending",
      respondedAt: null,
      sequence: 1,
      startsAt: "2026-11-27T13:00:00.000Z",
    });
    expect(await notifications()).toEqual([
      expect.objectContaining({ source_id: invitation.id, transition_instance: "sequence:0", resolved: true }),
      expect.objectContaining({ source_id: invitation.id, transition_instance: "sequence:1", resolved: false }),
    ]);
  });

  it("keeps an answer given here while the provider still shows it unanswered", async () => {
    const fake = provider();
    const accountId = await invited(fake);
    await respond((await onlyInvitation()).id, "accepted");

    fake.putEvent(
      "work",
      googleInvitation({ etag: '"review-2"', fields: remoteFields({ ...googleInvitation().fields, place: "Room 5" }) }),
    );
    await runPass(accountId, fake);

    expect((await onlyInvitation()).properties).toMatchObject({ status: "accepted", place: "Room 5" });
  });

  it.each([
    [
      "the provider no longer has the Event",
      (fake: FakeCalendarProvider) => fake.deleteEvent("work", "review"),
      {},
      { kind: "failed", reason: "eventGone" },
    ],
    [
      "the provider fails on the last attempt",
      (fake: FakeCalendarProvider) => {
        fake.failNextWrite = new CalendarSyncProviderError("providerUnavailable");
      },
      { isFinalAttempt: true },
      { kind: "failed", reason: "providerUnavailable" },
    ],
  ])("makes the invitation pending again when %s", async (_case, arrange, options, expected) => {
    const fake = provider();
    await invited(fake);
    await respond((await onlyInvitation()).id, "accepted");
    arrange(fake);

    expect(await runRespondJob(fake, options)).toEqual(expected);

    expect((await onlyInvitation()).properties).toMatchObject({ status: "pending", respondedAt: null });
    expect(fake.responses).toEqual([]);
  });

  it("retries a provider failure before the last attempt and keeps the answer", async () => {
    const fake = provider();
    await invited(fake);
    await respond((await onlyInvitation()).id, "accepted");
    fake.failNextWrite = new CalendarSyncProviderError("providerUnavailable");

    await expect(runRespondJob(fake)).rejects.toThrow(CalendarSyncProviderError);

    expect((await onlyInvitation()).properties.status).toBe("accepted");
    expect(await runRespondJob(fake)).toEqual({ kind: "answered" });
    expect(fake.responses).toHaveLength(1);
  });

  it("refuses an answer whose Event the provider no longer has, and keeps the invitation pending", async () => {
    const fake = provider();
    await invited(fake);
    const [event] = await eventsNamed("Design review");
    const { eventsDatabaseId } = await ids();
    // The user trashes the meeting here, and its push deletes it at the provider.
    await inTenant((client) =>
      itemDeleteWithClient(client, eventsDatabaseId, event!.id, {
        writer: USER_WRITER,
        actingUserId: userId,
        queueAffinity: createActionQueueAffinity(),
      }),
    );
    await runInTenant(tenant, () =>
      handleCalendarEventPushTask(runtime, { eventItemId: event!.id }, { adapters: fake.registry() }),
    );

    await expect(respond((await onlyInvitation()).id, "accepted")).rejects.toBeInstanceOf(ConflictError);

    expect((await onlyInvitation()).properties.status).toBe("pending");
    expect(await jobKeys("calendarInvitationRespond")).toEqual([]);
    expect(await jobKeys("calendarSendInvitationReply")).toEqual([]);
  });

  describe("the same invitation by e-mail", () => {
    it.each([
      [true, 0],
      [false, 1],
    ])("with Calendars %s, makes %i invitations", async (calendarsEnabled, expected) => {
      const mail = createInvitationMail(runtime);
      const mailTenant = await mail.tenant(admin);
      tenant = mailTenant.world.tenantId;
      const { mailboxesDatabaseId } = await ids();
      await runInTenant(tenant, () =>
        createChokePoint(runtime).updateItem(
          {
            databaseId: mailboxesDatabaseId,
            itemId: mailTenant.world.inbox.mailboxId,
            propertiesPatch: { calendarsEnabled },
          },
          mailTenant.userId,
          mailTenant.userId,
          USER_WRITER,
        ),
      );

      await mail.deliver(mailTenant.world, "<invite@example.test>", ics());

      expect(await invitations()).toHaveLength(expected);
      expect(await eventsNamed("Sprint review")).toEqual([]);
      expect(await notifications()).toHaveLength(expected);
    });
  });
});
