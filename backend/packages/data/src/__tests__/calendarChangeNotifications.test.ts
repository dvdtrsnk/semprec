import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createUser } from "../auth/usersStore.js";
import { CalendarSyncWriteUnsupportedError, type RemoteEvent } from "../calendar/sync/adapter.js";
import { notifyCalendarChanges } from "../calendar/sync/calendarChangeNotifications.js";
import { handleCalendarAccountSyncTask } from "../calendar/sync/calendarAccountSyncJob.js";
import { handleCalendarEventPushTask } from "../calendar/sync/eventPushJob.js";
import { resolveCalendarSyncIds, type CalendarSyncIds } from "../calendar/sync/calendarSyncStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { handleNotificationFanoutTask } from "../notifications/notificationFanoutJob.js";
import { patchNotificationPreferences } from "../notifications/notificationPreferencesStore.js";
import type { PushSenders } from "../push/pushSenders.js";
import { upsertApnsSubscription } from "../push/pushSubscriptionsStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeCalendarProvider, remoteFields } from "../testSupport/fakeCalendarSyncAdapter.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const USER_WRITER = { writerKind: "user" } as const;
const OWN_ADDRESS = "me@example.test";
/** Noon, outside the seeded sleep mute, so the fan-out never holds a push back. */
const FAN_OUT_AT = new Date("2026-11-20T12:00:00Z");

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

/** An Event on Friday 2026-11-27, inside every sync window of this suite. */
function remoteEvent(remoteId: string, overrides: Partial<RemoteEvent> = {}): RemoteEvent {
  return {
    remoteId,
    href: `/cal/${remoteId}.ics`,
    etag: `"${remoteId}-1"`,
    seriesRemoteId: null,
    fields: remoteFields({ name: "Dinner", date: "2026-11-27", timeFrom: "19:00", timeTo: "21:00" }),
    organizer: { email: "peter@example.test", name: "Peter", role: "CHAIR", status: "ACCEPTED" },
    attendees: [],
    ...overrides,
  };
}

/** A provider with a shared `family` calendar holding one Event and an empty `work` calendar. */
function provider(): FakeCalendarProvider {
  const fake = new FakeCalendarProvider();
  fake.addCalendar({
    remoteId: "family",
    url: "/cal/family/",
    name: "Family",
    color: null,
    readOnly: false,
    ctag: null,
  });
  fake.addCalendar({ remoteId: "work", url: "/cal/work/", name: "Work", color: null, readOnly: false, ctag: null });
  fake.putEvent("family", remoteEvent("existing", { fields: remoteFields({ name: "Brunch", date: "2026-11-22" }) }));
  return fake;
}

function runPass(accountId: string, fake: FakeCalendarProvider) {
  return runInTenant(tenant, () =>
    handleCalendarAccountSyncTask(runtime, { accountItemId: accountId }, { adapters: fake.registry() }),
  );
}

/** A password account with Calendars on whose first pass has run. */
async function syncedAccount(fake: FakeCalendarProvider): Promise<string> {
  const { mailboxesDatabaseId } = await ids();
  const accountId = await inTenant(async (client) => {
    const account = await createChokePoint(runtime).createItem({
      databaseId: mailboxesDatabaseId,
      properties: { name: "Family account", provider: "generic", mailEnabled: true, calendarsEnabled: true },
    });
    await writeMailboxAddresses(client, { mailboxesDatabaseId, mailboxItemId: account.id, address: OWN_ADDRESS });
    await storeCredential(client, { itemId: account.id, credentialType: "plain_password", plaintext: "s3cret" });
    await ensureMailAccountSyncState(client, { itemId: account.id, syncMode: "imap" });
    return account.id;
  });
  expect((await runPass(accountId, fake))?.kind).toBe("applied");
  return accountId;
}

const notificationRow = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  link_href: z.string().nullable(),
  source_table: z.string(),
  source_id: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

async function notifications() {
  return inTenant(async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT id, kind, title, body, link_href, source_table, source_id, payload FROM notifications
        WHERE kind LIKE 'calendar_event_%' ORDER BY body`,
    );
    return z.array(notificationRow).parse(rows);
  });
}

const syncedRow = z.object({ event_item_id: z.string(), calendar_item_id: z.string() });

async function syncedEvent(remoteId: string) {
  return inTenant(async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      "SELECT event_item_id, calendar_item_id FROM event_remote_state WHERE remote_id = $1",
      [remoteId],
    );
    return syncedRow.parse(rows[0]);
  });
}

async function calendarIdOf(remoteId: string): Promise<string> {
  return inTenant(async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      "SELECT calendar_item_id FROM calendar_remote_state WHERE remote_id = $1",
      [remoteId],
    );
    return z.object({ calendar_item_id: z.string() }).parse(rows[0]).calendar_item_id;
  });
}

async function patchAsUser(databaseId: string, itemId: string, propertiesPatch: Record<string, unknown>) {
  await runInTenant(tenant, () =>
    createChokePoint(runtime).updateItem({ databaseId, itemId, propertiesPatch }, userId, userId, USER_WRITER),
  );
}

function senders() {
  return {
    sendWebPush: vi.fn<PushSenders["sendWebPush"]>().mockResolvedValue({ outcome: "delivered" }),
    sendApns: vi.fn<PushSenders["sendApns"]>().mockResolvedValue({ outcome: "delivered" }),
    now: () => FAN_OUT_AT,
  };
}

async function fanOut(notificationId: string) {
  const sent = senders();
  await runInTenant(tenant, () => handleNotificationFanoutTask(runtime, { notificationId }, sent));
  return sent;
}

describe("notifications about others' changes in synced calendars", () => {
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
    await runInTenant(tenant, () =>
      upsertApnsSubscription(runtime, {
        userId,
        sessionId: null,
        platform: "ios",
        deviceToken: "device-token-calendar",
        apnsEnvironment: "sandbox",
      }),
    );
  });

  it("writes nothing for the first sync of a new account", async () => {
    const fake = provider();
    fake.putEvent("family", remoteEvent("dinner"));
    fake.putEvent("work", remoteEvent("standup"));

    await syncedAccount(fake);

    expect(await syncedEvent("dinner")).toBeDefined();
    expect(await notifications()).toEqual([]);
  });

  it("pushes a remote added Event of a notify calendar once, and writes nothing for one of a calendar with notify off", async () => {
    const fake = provider();
    const accountId = await syncedAccount(fake);
    const { calendarsDatabaseId } = await ids();
    await patchAsUser(calendarsDatabaseId, await calendarIdOf("work"), { notify: false });
    fake.putEvent("family", remoteEvent("dinner"));
    fake.putEvent("work", remoteEvent("standup", { fields: remoteFields({ name: "Standup", date: "2026-11-23" }) }));

    await runPass(accountId, fake);

    const dinner = await syncedEvent("dinner");
    const [notification, ...others] = await notifications();
    expect(others).toEqual([]);
    expect(notification).toEqual({
      id: expect.any(String),
      kind: "calendar_event_added",
      title: "Family",
      body: "Peter added Dinner, Fri 19:00",
      link_href: `?page=event&id=${dinner.event_item_id}`,
      source_table: "items",
      source_id: dinner.event_item_id,
      payload: { eventId: dinner.event_item_id, calendarId: dinner.calendar_item_id },
    });
    const sent = await fanOut(notification!.id);
    expect(sent.sendApns).toHaveBeenCalledTimes(1);
    expect(sent.sendApns.mock.calls[0]![1]).toMatchObject({
      title: "Family",
      body: "Peter added Dinner, Fri 19:00",
      interruptionLevel: "active",
      kind: "calendar_event_added",
      apns: { data: { event_id: dinner.event_item_id, calendar_id: dinner.calendar_item_id } },
    });
  });

  it("names the organizer only when it is someone else with a name, up to three changes one by one", async () => {
    const fake = provider();
    const accountId = await syncedAccount(fake);
    fake.putEvent("family", remoteEvent("by-peter"));
    fake.putEvent(
      "family",
      remoteEvent("by-me", {
        fields: remoteFields({ name: "Swim", date: "2026-11-28" }),
        organizer: { email: "ME@example.test", name: "Me", role: null, status: null },
      }),
    );
    fake.putEvent("family", remoteEvent("no-organizer", { organizer: null }));

    await runPass(accountId, fake);

    expect((await notifications()).map((row) => [row.kind, row.body])).toEqual([
      ["calendar_event_added", "New event Dinner, Fri 19:00"],
      ["calendar_event_added", "New event Swim, Sat"],
      ["calendar_event_added", "Peter added Dinner, Fri 19:00"],
    ]);
  });

  it("notifies a provider change of the title, time or place and a cancellation, but not of another field", async () => {
    const fake = provider();
    fake.putEvent("family", remoteEvent("dinner"));
    fake.putEvent("family", remoteEvent("lunch", { fields: remoteFields({ name: "Lunch", date: "2026-11-24" }) }));
    const accountId = await syncedAccount(fake);
    const lunch = await syncedEvent("lunch");
    fake.putEvent(
      "family",
      remoteEvent("dinner", {
        etag: '"dinner-2"',
        fields: remoteFields({ name: "Dinner", date: "2026-11-27", timeFrom: "20:00", timeTo: "22:00", place: "Home" }),
      }),
    );
    fake.putEvent(
      "family",
      remoteEvent("existing", {
        etag: '"existing-2"',
        fields: remoteFields({ name: "Brunch", date: "2026-11-22", description: "Bring juice" }),
      }),
    );
    fake.deleteEvent("family", "lunch");

    const result = await runPass(accountId, fake);

    expect(result).toMatchObject({ kind: "applied", initialSync: false });
    expect((await notifications()).map((row) => [row.kind, row.body, row.source_id])).toEqual([
      ["calendar_event_cancelled", "Peter cancelled Lunch, Tue", lunch.event_item_id],
      ["calendar_event_changed", "Peter changed Dinner, Fri 20:00", (await syncedEvent("dinner")).event_item_id],
    ]);
  });

  it("collapses five changes of one calendar in one pass into one summary", async () => {
    const fake = provider();
    const accountId = await syncedAccount(fake);
    const familyId = await calendarIdOf("family");
    for (const remoteId of ["a", "b", "c", "d", "e"]) fake.putEvent("family", remoteEvent(remoteId));

    await runPass(accountId, fake);

    const [summary, ...others] = await notifications();
    expect(others).toEqual([]);
    expect(summary).toEqual({
      id: expect.any(String),
      kind: "calendar_event_changed",
      title: "Family",
      body: "5 changes",
      link_href: null,
      source_table: "items",
      source_id: familyId,
      payload: { calendarId: familyId, count: 5 },
    });
    const sent = await fanOut(summary!.id);
    expect(sent.sendApns).toHaveBeenCalledTimes(1);
    expect(sent.sendApns.mock.calls[0]![1]).toMatchObject({ apns: { data: { calendar_id: familyId } } });
    expect(sent.sendApns.mock.calls[0]![1].apns?.data).not.toHaveProperty("event_id");
  });

  it("writes nothing when the provider sends back a local edit", async () => {
    const fake = provider();
    fake.putEvent("family", remoteEvent("dinner"));
    const accountId = await syncedAccount(fake);
    const dinner = await syncedEvent("dinner");
    const { eventsDatabaseId } = await ids();
    await patchAsUser(eventsDatabaseId, dinner.event_item_id, { name: "Family dinner", place: "Home" });
    // The push cannot reach the provider, so the user makes the same change there.
    fake.failNextWrite = new CalendarSyncWriteUnsupportedError("not representable");
    expect(
      await runInTenant(tenant, () =>
        handleCalendarEventPushTask(runtime, { eventItemId: dinner.event_item_id }, { adapters: fake.registry() }),
      ),
    ).toEqual({ kind: "failed", code: "unsupported" });
    fake.putEvent(
      "family",
      remoteEvent("dinner", {
        etag: '"dinner-2"',
        fields: remoteFields({
          name: "Family dinner",
          date: "2026-11-27",
          timeFrom: "19:00",
          timeTo: "21:00",
          place: "Home",
        }),
      }),
    );

    const result = await runPass(accountId, fake);

    expect(result).toMatchObject({ kind: "applied", changed: [expect.objectContaining({ remoteId: "dinner" })] });
    expect(await notifications()).toEqual([]);
  });

  it("stores the notification but sends no push while the calendar changes switch is off", async () => {
    const fake = provider();
    const accountId = await syncedAccount(fake);
    await inTenant((client) => patchNotificationPreferences(client, userId, { calendarChanges: false }));
    fake.putEvent("family", remoteEvent("dinner"));

    await runPass(accountId, fake);

    const [notification] = await notifications();
    const sent = await fanOut(notification!.id);
    expect(sent.sendApns).not.toHaveBeenCalled();
    expect(sent.sendWebPush).not.toHaveBeenCalled();
  });

  it("writes a replay of the same provider versions once", async () => {
    const fake = provider();
    const accountId = await syncedAccount(fake);
    const familyId = await calendarIdOf("family");
    const existing = await syncedEvent("existing");
    const notice = {
      kind: "changed" as const,
      eventItemId: existing.event_item_id,
      calendarItemId: familyId,
      snapshot: { fields: { name: "Brunch", date: "2026-11-22", timeFrom: null }, organizer: null },
      etag: null,
    };
    const replay = () =>
      inTenant((client) =>
        notifyCalendarChanges(client, {
          accountItemId: accountId,
          calendars: [{ calendarItemId: familyId, name: "Family" }],
          ownAddresses: [OWN_ADDRESS],
          notices: [notice],
        }),
      );

    await replay();
    await replay();

    expect((await notifications()).map((row) => row.body)).toEqual(["Changed event Brunch, Sun"]);
  });
});
