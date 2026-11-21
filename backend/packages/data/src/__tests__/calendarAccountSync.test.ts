import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUser } from "../auth/usersStore.js";
import {
  CalendarSyncConsentRequiredError,
  CalendarSyncProviderError,
  CalendarSyncReauthorizationRequiredError,
  type RemoteEvent,
} from "../calendar/sync/adapter.js";
import { handleCalendarAccountCleanupTask } from "../calendar/sync/calendarAccountCleanupJob.js";
import {
  calendarAccountCleanupJobKey,
  calendarAccountSyncJobKey,
} from "../calendar/sync/calendarAccountSyncEnqueue.js";
import { lockCalendarAccountSync } from "../calendar/sync/calendarAccountSyncGuard.js";
import {
  createCalendarAccountSyncRouteHandler,
  handleCalendarAccountSyncSweepTask,
  handleCalendarAccountSyncTask,
} from "../calendar/sync/calendarAccountSyncJob.js";
import { resolveCalendarSyncIds, type CalendarSyncIds } from "../calendar/sync/calendarSyncStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { ensureMailAccountSyncState, recordGrantedOauthScopes } from "../mail/mailAccountSyncStateStore.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { removeMailbox } from "../mail/mailboxRemoval.js";
import { createMailboxDetailRouteHandler, createMailboxListRouteHandler } from "../mail/mailboxRouteHandlers.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { createCalendarTimelineRouteHandler } from "../calendar/timelineRouteHandler.js";
import type { CalendarSyncApplyResult } from "../calendar/sync/calendarSyncApply.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getProfileAccountSummary } from "../tenancy/profileAccountSummary.js";
import { FakeCalendarProvider, remoteFields } from "../testSupport/fakeCalendarSyncAdapter.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const USER_WRITER = { writerKind: "user" } as const;

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
const userIds = new Map<string, string>();

function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

async function ids(tenantId = tenant): Promise<CalendarSyncIds> {
  const resolved = await inTenant((client) => resolveCalendarSyncIds(client), tenantId);
  if (resolved === null) throw new Error("the tenant has no calendar databases");
  return resolved;
}

const STANDUP: RemoteEvent = {
  remoteId: "standup",
  href: "/cal/work/standup.ics",
  etag: '"s1"',
  seriesRemoteId: null,
  fields: remoteFields({
    name: "Standup",
    date: "2026-11-18",
    timeFrom: "09:00",
    timeTo: "09:15",
    timeZone: "America/New_York",
    recurrenceRule: "FREQ=WEEKLY;BYDAY=WE",
    exceptionDates: ["2026-12-02T09:00"],
  }),
  organizer: { email: "boss@example.test", name: "Boss", role: "CHAIR", status: "ACCEPTED" },
  attendees: [{ email: "me@example.test", name: null, role: "REQ-PARTICIPANT", status: "NEEDS-ACTION" }],
};

const STANDUP_MOVED: RemoteEvent = {
  remoteId: "standup-2026-11-25",
  href: "/cal/work/standup.ics",
  etag: '"s1"',
  seriesRemoteId: "standup",
  fields: remoteFields({
    name: "Standup (late)",
    date: "2026-11-25",
    timeFrom: "10:00",
    timeTo: "10:15",
    timeZone: "America/New_York",
    recurrenceId: "2026-11-25T09:00",
  }),
  organizer: null,
  attendees: [],
};

const LUNCH: RemoteEvent = {
  remoteId: "lunch",
  href: "/cal/work/lunch.ics",
  etag: '"l1"',
  seriesRemoteId: null,
  fields: remoteFields({
    name: "Lunch",
    date: "2026-11-26",
    timeFrom: "12:00",
    timeTo: "13:00",
    place: "Canteen",
    description: "Bring the slides",
    url: "https://example.test/lunch",
    alertMinutes: 15,
  }),
  organizer: null,
  attendees: [],
};

const NEW_YEAR: RemoteEvent = {
  remoteId: "new-year",
  href: null,
  etag: '"n1"',
  seriesRemoteId: null,
  fields: remoteFields({ name: "New Year", date: "2027-01-01" }),
  organizer: null,
  attendees: [],
};

/** A provider with a writable `work` calendar (a series with an override, a single Event) and a read-only one. */
function provider(): FakeCalendarProvider {
  const fake = new FakeCalendarProvider();
  fake.addCalendar({
    remoteId: "work",
    url: "/cal/work/",
    name: "Work",
    color: "#FF0000",
    readOnly: false,
    ctag: null,
  });
  fake.addCalendar({ remoteId: "holidays", url: null, name: "Holidays", color: null, readOnly: true, ctag: null });
  fake.putEvent("work", STANDUP);
  fake.putEvent("work", STANDUP_MOVED);
  fake.putEvent("work", LUNCH);
  fake.putEvent("holidays", NEW_YEAR);
  return fake;
}

/** A connected password (`imap`) account, or an OAuth one with the given grant. */
async function createAccount(
  options: { calendarsEnabled?: boolean; provider?: "generic" | "gmail"; grantedScopes?: string[] } = {},
  tenantId = tenant,
): Promise<string> {
  const { mailboxesDatabaseId } = await ids(tenantId);
  return inTenant(async (client) => {
    const mailbox = await createChokePoint(runtime).createItem({
      databaseId: mailboxesDatabaseId,
      properties: {
        name: "Family account",
        provider: options.provider ?? "generic",
        mailEnabled: true,
        calendarsEnabled: options.calendarsEnabled ?? false,
      },
    });
    await writeMailboxAddresses(client, { mailboxesDatabaseId, mailboxItemId: mailbox.id, address: "me@example.test" });
    await storeCredential(client, { itemId: mailbox.id, credentialType: "plain_password", plaintext: "s3cret" });
    await ensureMailAccountSyncState(client, {
      itemId: mailbox.id,
      syncMode: options.provider === "gmail" ? "gmail_api" : "imap",
    });
    if (options.grantedScopes) await recordGrantedOauthScopes(client, mailbox.id, options.grantedScopes);
    return mailbox.id;
  }, tenantId);
}

async function switchCalendars(accountId: string, calendarsEnabled: boolean, tenantId = tenant) {
  const { mailboxesDatabaseId } = await ids(tenantId);
  const userId = userIds.get(tenantId);
  return runInTenant(tenantId, () =>
    createChokePoint(runtime).updateItem(
      { databaseId: mailboxesDatabaseId, itemId: accountId, propertiesPatch: { calendarsEnabled } },
      userId,
      userId,
      USER_WRITER,
    ),
  );
}

function runPass(accountId: string, fake: FakeCalendarProvider, tenantId = tenant) {
  return runInTenant(tenantId, () =>
    handleCalendarAccountSyncTask(runtime, { accountItemId: accountId }, { adapters: fake.registry() }),
  );
}

function runCleanup(accountId: string, tenantId = tenant) {
  return runInTenant(tenantId, () =>
    handleCalendarAccountCleanupTask(runtime, { accountItemId: accountId }, { chunkSize: 1 }),
  );
}

async function enableAndSync(fake: FakeCalendarProvider): Promise<string> {
  const accountId = await createAccount();
  await switchCalendars(accountId, true);
  const result = await runPass(accountId, fake);
  expect(result?.kind).toBe("applied");
  return accountId;
}

async function jobKeys(accountId: string): Promise<string[]> {
  const { rows } = await admin.query<{ key: string }>(
    "SELECT key FROM graphile_worker.jobs WHERE key LIKE '%' || $1 ORDER BY key",
    [accountId],
  );
  return rows.map((row) => row.key);
}

async function clearJobs(): Promise<void> {
  await admin.query("DELETE FROM graphile_worker._private_jobs");
}

const itemRow = z.object({
  id: z.uuid(),
  properties: z.record(z.string(), z.unknown()),
  version: z.string(),
  /** Postgres' `xmin`: any write of the row changes it, also one that stores the same values. */
  row_version: z.string(),
  deleted: z.boolean(),
  remote_id: z.string().nullable(),
});

/** Every Calendars and Events item of the tenant except the seeded calendars, with its remote id. */
async function syncedItems(tenantId = tenant) {
  const { calendarsDatabaseId, eventsDatabaseId } = await ids(tenantId);
  return inTenant(async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT i.id, i.properties, i.version::text AS version, i.xmin::text AS row_version,
              (i.deleted_at IS NOT NULL) AS deleted,
              COALESCE(c.remote_id, e.remote_id) AS remote_id
         FROM items i
         LEFT JOIN calendar_remote_state c ON c.calendar_item_id = i.id
         LEFT JOIN event_remote_state e ON e.event_item_id = i.id
        WHERE (i.database_id = $1 AND i.properties->>'kind' = 'account') OR i.database_id = $2
        ORDER BY i.id`,
      [calendarsDatabaseId, eventsDatabaseId],
    );
    return z.array(itemRow).parse(rows);
  }, tenantId);
}

async function itemByRemoteId(remoteId: string) {
  const found = (await syncedItems()).find((item) => item.remote_id === remoteId);
  if (!found) throw new Error(`no synced item for ${remoteId}`);
  return found;
}

const remoteRows = z.array(z.record(z.string(), z.unknown()));

async function remoteState(tenantId = tenant) {
  return inTenant(async (client) => {
    const calendars = await client.query<Record<string, unknown>>(
      "SELECT calendar_item_id, remote_id, remote_url, sync_token FROM calendar_remote_state ORDER BY remote_id",
    );
    const events = await client.query<Record<string, unknown>>(
      `SELECT event_item_id, calendar_item_id, remote_id, remote_href, etag, base_snapshot, xmin::text AS row_version
         FROM event_remote_state ORDER BY remote_id`,
    );
    return { calendars: remoteRows.parse(calendars.rows), events: remoteRows.parse(events.rows) };
  }, tenantId);
}

const syncStateRow = z.object({
  status: z.string(),
  failing_since: z.date().nullable(),
  last_error_code: z.string().nullable(),
  last_successful_sync_at: z.date().nullable(),
  initial_sync_completed_at: z.date().nullable(),
});

async function syncState(accountId: string, tenantId = tenant) {
  return inTenant(async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT status, failing_since, last_error_code, last_successful_sync_at, initial_sync_completed_at
         FROM calendar_account_sync_state WHERE account_item_id = $1`,
      [accountId],
    );
    return rows[0] === undefined ? null : syncStateRow.parse(rows[0]);
  }, tenantId);
}

const problemRow = z.object({
  severity: z.string(),
  resolved_at: z.date().nullable(),
  resolution_kind: z.string().nullable(),
});

async function calendarProblems(accountId: string) {
  return inTenant(async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT severity, resolved_at, resolution_kind FROM semp_problems
        WHERE kind = 'calendarSyncError' AND source_id = $1 ORDER BY first_seen_at`,
      [accountId],
    );
    return z.array(problemRow).parse(rows);
  });
}

async function calendarStatus(accountId: string): Promise<unknown> {
  const response = await runInTenant(tenant, () =>
    createMailboxDetailRouteHandler(runtime)({ params: { id: accountId } }),
  );
  return z.object({ calendarStatus: z.unknown() }).parse(response.body).calendarStatus;
}

/** `calendars` calendars `c0`, `c1`, … of `events` single timed Events each, `c<n>-<i>`, spread over December. */
function bulkProvider(calendars: number, events: number): FakeCalendarProvider {
  const fake = new FakeCalendarProvider();
  for (let calendar = 0; calendar < calendars; calendar += 1) {
    fake.addCalendar({
      remoteId: `c${calendar}`,
      url: null,
      name: `C${calendar}`,
      color: null,
      readOnly: false,
      ctag: null,
    });
    addBulkEvents(fake, `c${calendar}`, 0, events);
  }
  return fake;
}

function addBulkEvents(fake: FakeCalendarProvider, calendarRemoteId: string, from: number, to: number): void {
  for (let index = from; index < to; index += 1) {
    fake.putEvent(calendarRemoteId, {
      remoteId: `${calendarRemoteId}-${index}`,
      href: null,
      etag: `"${index}"`,
      seriesRemoteId: null,
      fields: remoteFields({
        name: `Event ${index}`,
        date: `2026-12-${String((index % 28) + 1).padStart(2, "0")}`,
        timeFrom: "10:00",
        timeTo: "11:00",
      }),
      organizer: null,
      attendees: [],
    });
  }
}

/** The longest open transaction of the runtime role on this worker's database, in seconds, sampled until `done`. */
function sampleLongestTransaction(done: () => boolean): Promise<number> {
  return (async () => {
    let longest = 0;
    while (!done()) {
      const { rows } = await admin.query<{ age: number | null }>(
        `SELECT max(extract(epoch FROM now() - xact_start))::float8 AS age FROM pg_stat_activity
          WHERE datname = current_database() AND usename = 'semprec_data' AND xact_start IS NOT NULL`,
      );
      longest = Math.max(longest, rows[0]?.age ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return longest;
  })();
}

describe("calendar sync of internet accounts", () => {
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
    foreign = await createTestTenant(admin);
    userIds.clear();
    for (const id of [tenant, foreign]) {
      const user = await createUser(admin, {
        tenantId: id,
        email: `${randomUUID()}@example.test`,
        passwordHash: "unused",
        locale: "en",
      });
      userIds.set(id, user.id);
      await runInTenant(id, () => seedSystem(runtime));
    }
  });

  it("switching Calendars on queues a pass that creates the account calendars and their Events", async () => {
    const fake = provider();
    const accountId = await createAccount();
    expect(await calendarStatus(accountId)).toBe("off");
    await clearJobs();

    await switchCalendars(accountId, true);
    expect(await jobKeys(accountId)).toEqual([calendarAccountSyncJobKey(accountId)]);
    expect(await calendarStatus(accountId)).toBe("never");

    const result = await runPass(accountId, fake);
    expect(result).toMatchObject({ kind: "applied", initialSync: true, changed: [], cancelled: [], skippedEvents: 0 });
    expect(result?.kind === "applied" ? result.added.map((event) => event.remoteId).sort() : null).toEqual([
      "lunch",
      "new-year",
      "standup",
      "standup-2026-11-25",
    ]);

    const work = await itemByRemoteId("work");
    const holidays = await itemByRemoteId("holidays");
    expect(work.properties).toMatchObject({
      kind: "account",
      name: null,
      color: null,
      remoteName: "Work",
      remoteColor: "#FF0000",
      readOnly: false,
    });
    expect(holidays.properties).toMatchObject({ kind: "account", remoteName: "Holidays", readOnly: true });
    const synced = await ids();
    const edges = await inTenant(async (client) => {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM item_relations
          WHERE relation_definition_id = $1 AND (item_a = $2 OR item_b = $2)`,
        [synced.accountRelationDefinitionId, accountId],
      );
      return rows[0]?.n;
    });
    expect(edges).toBe(2);

    const standup = await itemByRemoteId("standup");
    expect(standup.properties).toMatchObject({
      name: "Standup",
      date: "2026-11-18",
      timeFrom: "09:00",
      timeTo: "09:15",
      timeZone: "America/New_York",
      recurrenceRule: "FREQ=WEEKLY;BYDAY=WE",
      exceptionDates: ["2026-12-02T09:00"],
    });
    expect(standup.properties).not.toHaveProperty("seriesId");
    expect((await itemByRemoteId("standup-2026-11-25")).properties).toMatchObject({
      name: "Standup (late)",
      seriesId: standup.id,
      recurrenceId: "2026-11-25T09:00",
    });
    expect((await itemByRemoteId("lunch")).properties).toMatchObject({
      place: "Canteen",
      description: "Bring the slides",
      url: "https://example.test/lunch",
      alertMinutes: 15,
    });
    expect((await itemByRemoteId("new-year")).properties).toMatchObject({ name: "New Year", date: "2027-01-01" });

    const state = await remoteState();
    expect(state.calendars.map((row) => [row.remote_id, row.remote_url])).toEqual([
      ["holidays", null],
      ["work", "/cal/work/"],
    ]);
    const standupState = state.events.find((row) => row.remote_id === "standup");
    expect(standupState).toMatchObject({
      calendar_item_id: work.id,
      remote_href: "/cal/work/standup.ics",
      etag: '"s1"',
      base_snapshot: {
        fields: STANDUP.fields,
        seriesRemoteId: null,
        organizer: STANDUP.organizer,
        attendees: STANDUP.attendees,
      },
    });
    expect(await syncState(accountId)).toMatchObject({ status: "ok", failing_since: null, last_error_code: null });
    expect((await syncState(accountId))?.initial_sync_completed_at).toBeInstanceOf(Date);
    expect(await calendarStatus(accountId)).toBe("ok");
  });

  it("an account created with Calendars on queues its first pass", async () => {
    await clearJobs();
    const accountId = await createAccount({ calendarsEnabled: true });
    expect(await jobKeys(accountId)).toEqual([calendarAccountSyncJobKey(accountId)]);
  });

  it.each([
    { fetch: "an incremental", forgetCursors: false, cursors: ["4", "4"] },
    // Every Event comes back unchanged, so only the snapshot comparison keeps the pass from writing.
    { fetch: "a full", forgetCursors: true, cursors: [null, null] },
  ])("a second pass with unchanged data and $fetch fetch writes nothing", async ({ forgetCursors, cursors }) => {
    const fake = provider();
    const accountId = await enableAndSync(fake);
    if (forgetCursors) await admin.query("UPDATE calendar_remote_state SET sync_token = NULL");
    const itemsBefore = await syncedItems();
    const stateBefore = await remoteState();
    fake.fetches.length = 0;

    const result = await runPass(accountId, fake);

    expect(result).toEqual({
      kind: "applied",
      initialSync: false,
      added: [],
      changed: [],
      cancelled: [],
      skippedEvents: 0,
    });
    expect(await syncedItems()).toEqual(itemsBefore);
    expect((await remoteState()).events).toEqual(stateBefore.events);
    expect(fake.fetches.map((fetch) => fetch.cursor?.syncToken ?? null)).toEqual(cursors);
  });

  it("adopts the provider's changes, keeps a local edit of another field, and moves an address-only change to the remote state", async () => {
    const fake = provider();
    const accountId = await enableAndSync(fake);
    const lunch = await itemByRemoteId("lunch");
    const { eventsDatabaseId } = await ids();
    // A field the provider does not store, so the edit queues no push and the pass applies the Event.
    await runInTenant(tenant, () =>
      createChokePoint(runtime).updateItem(
        { databaseId: eventsDatabaseId, itemId: lunch.id, propertiesPatch: { travelMinutes: 15 } },
        userIds.get(tenant),
        userIds.get(tenant),
        USER_WRITER,
      ),
    );
    fake.putEvent("work", { ...LUNCH, etag: '"l2"', fields: { ...LUNCH.fields, name: "Team lunch" } });
    fake.putEvent("holidays", { ...NEW_YEAR, etag: '"n2"' });
    const newYearBefore = await itemByRemoteId("new-year");

    const result = await runPass(accountId, fake);

    expect(result).toMatchObject({
      kind: "applied",
      initialSync: false,
      added: [],
      cancelled: [],
      changed: [{ eventItemId: lunch.id, remoteId: "lunch" }],
    });
    expect((await itemByRemoteId("lunch")).properties).toMatchObject({ name: "Team lunch", travelMinutes: 15 });
    expect(await itemByRemoteId("new-year")).toEqual(newYearBefore);
    const events = (await remoteState()).events;
    expect(events.find((row) => row.remote_id === "new-year")?.etag).toBe('"n2"');
    expect(events.find((row) => row.remote_id === "lunch")?.etag).toBe('"l2"');
  });

  it("an Event deleted at the provider goes to the trash on the next pass", async () => {
    const fake = provider();
    const accountId = await enableAndSync(fake);
    const lunch = await itemByRemoteId("lunch");
    fake.deleteEvent("work", "lunch");

    const result = await runPass(accountId, fake);

    expect(result).toMatchObject({ kind: "applied", cancelled: [{ eventItemId: lunch.id, remoteId: "lunch" }] });
    const items = await syncedItems();
    expect(items.find((item) => item.id === lunch.id)).toMatchObject({ deleted: true, remote_id: null });
    expect(items.filter((item) => !item.deleted)).toHaveLength(5);
    expect((await remoteState()).events.map((row) => row.remote_id)).not.toContain("lunch");
  });

  it("a full fetch trashes the stored Events of the window it no longer lists", async () => {
    const fake = provider();
    const accountId = await enableAndSync(fake);
    const lunch = await itemByRemoteId("lunch");
    // Forgetting the cursor makes the next fetch a full one; the provider lost the lunch meanwhile.
    await admin.query("UPDATE calendar_remote_state SET sync_token = NULL WHERE remote_id = 'work'");
    fake.deleteEvent("work", "lunch");

    const result = await runPass(accountId, fake);

    expect(result).toMatchObject({ kind: "applied", cancelled: [{ eventItemId: lunch.id }] });
    expect((await itemByRemoteId("standup")).deleted).toBe(false);
  });

  it("a calendar the provider stops listing is cleaned up with its Events", async () => {
    const fake = provider();
    const accountId = await enableAndSync(fake);
    const holidays = await itemByRemoteId("holidays");
    const newYear = await itemByRemoteId("new-year");
    await clearJobs();
    fake.removeCalendar("holidays");

    expect(await runPass(accountId, fake)).toMatchObject({ kind: "applied" });
    expect(await jobKeys(accountId)).toEqual([calendarAccountCleanupJobKey(accountId)]);
    await runCleanup(accountId);

    const items = await syncedItems();
    expect(
      items
        .filter((item) => item.deleted)
        .map((item) => item.id)
        .sort(),
    ).toEqual([holidays.id, newYear.id].sort());
    expect((await remoteState()).calendars.map((row) => row.remote_id)).toEqual(["work"]);
    expect((await remoteState()).events.map((row) => row.remote_id)).not.toContain("new-year");
  });

  it("switching Calendars off removes the account calendars and their Events and stops further passes", async () => {
    const fake = provider();
    const accountId = await enableAndSync(fake);
    await clearJobs();

    await switchCalendars(accountId, false);

    expect(await jobKeys(accountId)).toEqual([
      calendarAccountCleanupJobKey(accountId),
      `calendar-push-channels:${accountId}`,
    ]);
    expect(await syncState(accountId)).toBeNull();
    expect((await remoteState()).calendars).toEqual([]);
    expect(await calendarStatus(accountId)).toBe("off");
    // Chunks of one Event: three for `work`, one for `holidays`, plus the calendars themselves.
    await runCleanup(accountId);
    const items = await syncedItems();
    expect(items).toHaveLength(6);
    expect(items.every((item) => item.deleted)).toBe(true);
    expect(await remoteState()).toEqual({ calendars: [], events: [] });

    await clearJobs();
    const listCalls = fake.listCalls;
    expect(await runPass(accountId, fake)).toBeNull();
    expect(fake.listCalls).toBe(listCalls);
    await handleCalendarAccountSyncSweepTask(runtime);
    expect(await jobKeys(accountId)).toEqual([]);
    expect(await syncedItems()).toEqual(items);
  });

  it("switching Calendars back on syncs the account anew", async () => {
    const fake = provider();
    const accountId = await enableAndSync(fake);
    await switchCalendars(accountId, false);
    await runCleanup(accountId);
    await switchCalendars(accountId, true);

    const result = await runPass(accountId, fake);

    expect(result).toMatchObject({ kind: "applied", initialSync: true });
    expect((await syncedItems()).filter((item) => !item.deleted)).toHaveLength(6);
  });

  it("removing the account removes its calendars and their Events", async () => {
    const fake = provider();
    const accountId = await enableAndSync(fake);
    await clearJobs();

    expect(
      await runInTenant(tenant, () =>
        removeMailbox(runtime, accountId, { queueAffinity: createActionQueueAffinity() }),
      ),
    ).toBe(true);

    expect(await jobKeys(accountId)).toContain(calendarAccountCleanupJobKey(accountId));
    expect(await syncState(accountId)).toBeNull();
    await runCleanup(accountId);
    expect((await syncedItems()).every((item) => item.deleted)).toBe(true);
    expect(await remoteState()).toEqual({ calendars: [], events: [] });
  });

  describe.each([
    {
      name: "a provider failure",
      error: () => new CalendarSyncProviderError("providerUnavailable"),
      status: "error",
      code: "providerUnavailable",
      severity: "warning",
      rethrown: true,
    },
    {
      name: "an unexpected failure",
      error: () => new Error("socket hang up"),
      status: "error",
      code: "unexpected",
      severity: "warning",
      rethrown: true,
    },
    {
      name: "a 401",
      error: () => new CalendarSyncReauthorizationRequiredError(),
      status: "needsReauthorization",
      code: "reauthorizationRequired",
      severity: "critical",
      rethrown: false,
    },
    {
      name: "a missing calendar grant",
      error: () => new CalendarSyncConsentRequiredError(),
      status: "needsConsent",
      code: "consentRequired",
      severity: "critical",
      rethrown: false,
    },
  ])("$name", ({ error, status, code, severity, rethrown }) => {
    it(`leaves the data unchanged, sets status ${status} and raises a Semp problem until a pass succeeds`, async () => {
      const fake = provider();
      const accountId = await enableAndSync(fake);
      fake.putEvent("work", { ...LUNCH, etag: '"l2"', fields: { ...LUNCH.fields, name: "Team lunch" } });
      const itemsBefore = await syncedItems();
      const stateBefore = await remoteState();
      const failure = error();
      fake.failNext = failure;

      const pass = runPass(accountId, fake);
      if (rethrown) await expect(pass).rejects.toBe(failure);
      else expect(await pass).toBeNull();

      expect(await syncedItems()).toEqual(itemsBefore);
      expect(await remoteState()).toEqual(stateBefore);
      expect(await syncState(accountId)).toMatchObject({ status, last_error_code: code });
      expect((await syncState(accountId))?.failing_since).toBeInstanceOf(Date);
      expect(await calendarStatus(accountId)).toBe(status);
      expect(await calendarProblems(accountId)).toEqual([{ severity, resolved_at: null, resolution_kind: null }]);

      expect(await runPass(accountId, fake)).toMatchObject({ kind: "applied", changed: [{ remoteId: "lunch" }] });
      expect(await syncState(accountId)).toMatchObject({ status: "ok", failing_since: null, last_error_code: null });
      expect(await calendarProblems(accountId)).toMatchObject([{ resolution_kind: "recovered" }]);
    });
  });

  it("refuses an adapter answer outside the contract as invalidResponse and writes nothing", async () => {
    const fake = provider();
    const accountId = await createAccount();
    await switchCalendars(accountId, true);
    fake.putEvent("work", { ...LUNCH, remoteId: "bad", fields: { ...LUNCH.fields, date: "26.11.2026" } });

    await expect(runPass(accountId, fake)).rejects.toBeInstanceOf(CalendarSyncProviderError);

    expect(await syncedItems()).toEqual([]);
    expect(await syncState(accountId)).toMatchObject({ status: "error", last_error_code: "invalidResponse" });
  });

  it("a pass without an adapter for the account's sync mode fails as unexpected", async () => {
    const accountId = await createAccount();
    await switchCalendars(accountId, true);

    await expect(
      runInTenant(tenant, () => handleCalendarAccountSyncTask(runtime, { accountItemId: accountId }, { adapters: {} })),
    ).rejects.toThrow("No calendar adapter configured for sync mode imap");
    expect(await syncState(accountId)).toMatchObject({ status: "error", last_error_code: "unexpected" });
  });

  it("an OAuth account whose grant lacks calendar access is not fetched and shows needsConsent", async () => {
    const fake = provider();
    const accountId = await createAccount({
      provider: "gmail",
      calendarsEnabled: true,
      grantedScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    });

    expect(await runPass(accountId, fake)).toBeNull();

    expect(fake.listCalls).toBe(0);
    expect(await syncedItems()).toEqual([]);
    expect(await calendarStatus(accountId)).toBe("needsConsent");
  });

  it("the sweep queues accounts with Calendars on that are due, and no others", async () => {
    const fake = provider();
    const synced = await enableAndSync(fake);
    const neverSynced = await createAccount({ calendarsEnabled: true });
    const off = await createAccount();
    const failing = await enableAndSync(provider());
    await admin.query("UPDATE calendar_account_sync_state SET status = 'error' WHERE account_item_id = $1", [failing]);
    // Long past due, but only a new sign-in can change what a pass of these would answer.
    const refused: string[] = [];
    for (const status of ["needsReauthorization", "needsConsent"]) {
      const accountId = await enableAndSync(provider());
      await admin.query(
        `UPDATE calendar_account_sync_state SET status = $2, last_successful_sync_at = now() - interval '1 day'
          WHERE account_item_id = $1`,
        [accountId, status],
      );
      refused.push(accountId);
    }
    await clearJobs();

    await handleCalendarAccountSyncSweepTask(runtime);

    expect(await jobKeys(neverSynced)).toEqual([calendarAccountSyncJobKey(neverSynced)]);
    expect(await jobKeys(failing)).toEqual([calendarAccountSyncJobKey(failing)]);
    expect(await jobKeys(synced)).toEqual([]);
    expect(await jobKeys(off)).toEqual([]);
    for (const accountId of refused) expect(await jobKeys(accountId)).toEqual([]);
    // As if the last success were five minutes ago.
    await admin.query(
      "UPDATE calendar_account_sync_state SET last_successful_sync_at = now() - interval '5 minutes' WHERE account_item_id = $1",
      [synced],
    );
    await handleCalendarAccountSyncSweepTask(runtime);
    expect(await jobKeys(synced)).toEqual([calendarAccountSyncJobKey(synced)]);
  });

  describe("POST /api/accounts/:id/calendars/sync", () => {
    const route = (id: string, tenantId = tenant) =>
      runInTenant(tenantId, () => createCalendarAccountSyncRouteHandler(runtime)({ params: { id } }));

    /** The account's waiting sync jobs with their run times. */
    async function syncJobs(accountId: string): Promise<Array<{ key: string; runAt: string }>> {
      const { rows } = await admin.query<{ key: string; run_at: Date }>(
        "SELECT key, run_at FROM graphile_worker.jobs WHERE key = $1",
        [calendarAccountSyncJobKey(accountId)],
      );
      return rows.map((row) => ({ key: row.key, runAt: row.run_at.toISOString() }));
    }

    /** Moves the recorded request back by `seconds`, as if it had been made that long ago. */
    async function ageRequest(accountId: string, seconds: number): Promise<void> {
      await admin.query(
        `UPDATE calendar_account_sync_state
            SET manual_sync_requested_at = manual_sync_requested_at - make_interval(secs => $2)
          WHERE account_item_id = $1`,
        [accountId, seconds],
      );
    }

    async function recordedRequest(accountId: string): Promise<Date | null> {
      const { rows } = await admin.query<{ requested: Date | null }>(
        "SELECT manual_sync_requested_at AS requested FROM calendar_account_sync_state WHERE account_item_id = $1",
        [accountId],
      );
      return rows[0]?.requested ?? null;
    }

    it("queues a pass at once, and coalesces requests within a minute into one pass at the minute's end", async () => {
      const accountId = await createAccount({ calendarsEnabled: true });
      await clearJobs();

      const before = Date.now();
      const first = await route(accountId);
      expect(first).toEqual({ status: 202, body: { id: accountId, queued: true, runAt: expect.any(String) } });
      const firstRunAt = Date.parse(first.body.runAt);
      expect(Math.abs(firstRunAt - before)).toBeLessThan(5_000);
      expect(await syncJobs(accountId)).toEqual([
        { key: calendarAccountSyncJobKey(accountId), runAt: first.body.runAt },
      ]);

      // The worker took the first pass; the second request comes a second later.
      await clearJobs();
      await ageRequest(accountId, 1);
      const windowEnd = new Date(firstRunAt - 1_000 + 60_000).toISOString();
      const second = await route(accountId);
      expect(second).toEqual({ status: 202, body: { id: accountId, queued: true, runAt: windowEnd } });
      expect(await syncJobs(accountId)).toEqual([{ key: calendarAccountSyncJobKey(accountId), runAt: windowEnd }]);

      const third = await route(accountId);
      expect(third).toEqual({ status: 202, body: { id: accountId, queued: true, runAt: windowEnd } });
      expect(await syncJobs(accountId)).toEqual([{ key: calendarAccountSyncJobKey(accountId), runAt: windowEnd }]);

      // The deferred pass ran at the window's end; a request a minute after it queues at once again.
      await clearJobs();
      await ageRequest(accountId, 120);
      const later = await route(accountId);
      expect(Math.abs(Date.parse(later.body.runAt) - Date.now())).toBeLessThan(5_000);
      expect(await syncJobs(accountId)).toEqual([
        { key: calendarAccountSyncJobKey(accountId), runAt: later.body.runAt },
      ]);
    });

    it("lets a pass still waiting to run serve a request within its minute", async () => {
      const accountId = await createAccount({ calendarsEnabled: true });
      await clearJobs();
      const first = await route(accountId);
      await ageRequest(accountId, 1);
      const second = await route(accountId);
      expect(Date.parse(second.body.runAt)).toBeGreaterThan(Date.parse(first.body.runAt));
      expect(await syncJobs(accountId)).toEqual([
        { key: calendarAccountSyncJobKey(accountId), runAt: first.body.runAt },
      ]);
    });

    it("answers 409 calendars_disabled with Calendars off, queuing nothing", async () => {
      const accountId = await createAccount();
      await clearJobs();
      await expect(route(accountId)).rejects.toMatchObject({ status: 409, code: "calendars_disabled" });
      await expect(route(accountId)).rejects.toBeInstanceOf(ConflictError);
      expect(await jobKeys(accountId)).toEqual([]);
      expect(await syncState(accountId)).toBeNull();
    });

    it("answers another tenant's, an unknown and a malformed id with the same 404", async () => {
      const accountId = await createAccount({ calendarsEnabled: true });
      await clearJobs();
      for (const [id, tenantId] of [
        [accountId, foreign],
        [randomUUID(), tenant],
        ["not-a-uuid", tenant],
      ] as const) {
        await expect(route(id, tenantId)).rejects.toBeInstanceOf(NotFoundError);
      }
      expect(await jobKeys(accountId)).toEqual([]);
      expect(await syncState(accountId)).toBeNull();
    });

    it.each([
      {
        held: "the account's state row",
        lock: "SELECT 1 FROM calendar_account_sync_state WHERE account_item_id = $1 FOR UPDATE",
      },
      { held: "the account row", lock: "SELECT 1 FROM items WHERE id = $1 FOR UPDATE" },
    ])("answers 202 at once and queues a pass while a writer holds $held", async ({ lock }) => {
      const accountId = await enableAndSync(provider());
      await clearJobs();
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => {};
      const holding = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = inTenant(async (client) => {
        await lockCalendarAccountSync(client, accountId);
        expect((await client.query(lock, [accountId])).rowCount).toBe(1);
        locked();
        await released;
      });
      try {
        await holding;
        const started = performance.now();
        const response = await route(accountId);
        const elapsedMs = performance.now() - started;

        expect(response).toEqual({ status: 202, body: { id: accountId, queued: true, runAt: expect.any(String) } });
        expect(elapsedMs).toBeLessThan(1_000);
        expect(await syncJobs(accountId)).toEqual([
          { key: calendarAccountSyncJobKey(accountId), runAt: response.body.runAt },
        ]);
      } finally {
        release();
        await holder;
      }
      expect(await recordedRequest(accountId)).toBeNull();
    });
  });

  it("another tenant's pass of the account id finds nothing and writes nothing", async () => {
    const fake = provider();
    const accountId = await createAccount({ calendarsEnabled: true });

    expect(await runPass(accountId, fake, foreign)).toBeNull();

    expect(fake.listCalls).toBe(0);
    expect(await syncedItems()).toEqual([]);
    expect(await syncedItems(foreign)).toEqual([]);
    expect(await syncState(accountId)).toBeNull();
    await expect(switchCalendars(accountId, false, foreign)).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([
    { pass: "an initial", tokensBefore: [null, null], tokensAfter: ["60", "60"], events: 60 },
    { pass: "an incremental", tokensBefore: ["60", "60"], tokensAfter: ["120", "120"], events: 120 },
  ])(
    "$pass pass ended between batches keeps its cursors, and the next pass resumes it without duplicates",
    async ({ pass, tokensBefore, tokensAfter, events }) => {
      const fake = bulkProvider(2, 30);
      const accountId = await createAccount();
      await switchCalendars(accountId, true);
      if (pass === "an incremental") {
        expect(await runPass(accountId, fake)).toMatchObject({ kind: "applied", initialSync: true });
        addBulkEvents(fake, "c0", 30, 60);
        addBulkEvents(fake, "c1", 30, 60);
      }
      const storedBefore = (await remoteState()).events.length;
      const stop = new Error("stopped between batches");

      await expect(
        runInTenant(tenant, () =>
          handleCalendarAccountSyncTask(
            runtime,
            { accountItemId: accountId },
            {
              adapters: fake.registry(),
              batchEvents: 10,
              afterBatch: (batch) => {
                if (batch === 2) throw stop;
              },
            },
          ),
        ),
      ).rejects.toBe(stop);

      const stopped = await remoteState();
      expect(stopped.calendars.map((row) => [row.remote_id, row.sync_token])).toEqual([
        ["c0", tokensBefore[0]],
        ["c1", tokensBefore[1]],
      ]);
      expect(stopped.events).toHaveLength(storedBefore + 20);
      expect(await syncState(accountId)).toMatchObject({ status: "error", last_error_code: "unexpected" });

      const resumed = await runPass(accountId, fake);

      expect(resumed).toMatchObject({ kind: "applied", initialSync: pass === "an initial" });
      expect(resumed?.kind === "applied" ? resumed.added : null).toHaveLength(events - storedBefore - 20);
      const state = await remoteState();
      expect(state.calendars.map((row) => [row.remote_id, row.sync_token])).toEqual([
        ["c0", tokensAfter[0]],
        ["c1", tokensAfter[1]],
      ]);
      expect(new Set(state.events.map((row) => row.remote_id)).size).toBe(events);
      const items = await syncedItems();
      expect(items.filter((item) => !item.deleted)).toHaveLength(2 + events);
      expect(new Set(items.map((item) => item.remote_id)).size).toBe(items.length);
      expect(await syncState(accountId)).toMatchObject({ status: "ok", last_error_code: null });
    },
  );

  it("a pass whose account a newer pass claimed stops at its next batch and stores no cursor of its own", async () => {
    const fake = bulkProvider(1, 30);
    const accountId = await createAccount();
    await switchCalendars(accountId, true);
    const newer: Array<CalendarSyncApplyResult | null> = [];

    const older = await runInTenant(tenant, () =>
      handleCalendarAccountSyncTask(
        runtime,
        { accountItemId: accountId },
        {
          adapters: fake.registry(),
          batchEvents: 10,
          afterBatch: async (batch) => {
            if (batch !== 1) return;
            addBulkEvents(fake, "c0", 30, 31);
            newer.push(await runPass(accountId, fake));
          },
        },
      ),
    );

    expect(older).toEqual({ kind: "superseded" });
    expect(newer).toHaveLength(1);
    expect(newer[0]).toMatchObject({ kind: "applied", initialSync: true });
    expect(newer[0]?.kind === "applied" ? newer[0].added : null).toHaveLength(21);
    const state = await remoteState();
    expect(state.calendars.map((row) => [row.remote_id, row.sync_token])).toEqual([["c0", "31"]]);
    expect(state.events).toHaveLength(31);
    expect((await syncedItems()).filter((item) => !item.deleted)).toHaveLength(32);
  });

  it("a pass of 2000 Events keeps every transaction short while reads and a manual sync request go through", async () => {
    // As the API process shares its pool: the pass and the reads on six connections, two seconds per statement.
    const shared = await createRuntimeRolePool(admin, "semprec_data", { statementTimeoutMs: 2_000, max: 6 });
    try {
      const fake = bulkProvider(6, 334);
      const accountId = await createAccount({ calendarsEnabled: true });
      const userId = userIds.get(tenant);
      if (userId === undefined) throw new Error("the tenant has no user");
      let done = false;
      const longestTransaction = sampleLongestTransaction(() => done);
      const failures: string[] = [];
      const latenciesMs: number[] = [];
      const manual: Array<{ status: number; elapsedMs: number }> = [];
      const reads = runInTenant(tenant, async () => {
        const timeline = createCalendarTimelineRouteHandler(shared);
        const mailboxes = createMailboxListRouteHandler(shared);
        const syncRoute = createCalendarAccountSyncRouteHandler(shared);
        let round = 0;
        while (!done) {
          round += 1;
          const started = performance.now();
          const read = async (name: string, call: () => Promise<unknown>) => {
            try {
              await call();
            } catch (error) {
              failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
            }
          };
          await Promise.all([
            read("timeline", () => timeline({ req: { url: "/api/calendar/timeline?from=2026-12-01&to=2026-12-31" } })),
            read("summary", () => getProfileAccountSummary(shared, { userId })),
            read("mailboxes", () => mailboxes()),
          ]);
          latenciesMs.push(performance.now() - started);
          if (round === 5) {
            const requested = performance.now();
            const response = await syncRoute({ params: { id: accountId } });
            manual.push({ status: response.status, elapsedMs: performance.now() - requested });
          }
        }
      });

      const result = await runInTenant(tenant, () =>
        handleCalendarAccountSyncTask(shared, { accountItemId: accountId }, { adapters: fake.registry() }),
      );
      done = true;
      const longestSeconds = await longestTransaction;
      await reads;

      expect(result).toMatchObject({ kind: "applied", initialSync: true });
      expect(result?.kind === "applied" ? result.added : null).toHaveLength(2004);
      expect(failures).toEqual([]);
      expect(latenciesMs.length).toBeGreaterThan(5);
      expect(manual).toHaveLength(1);
      expect(manual[0]?.status).toBe(202);
      expect(manual[0]?.elapsedMs).toBeLessThan(1_000);
      // One transaction of the whole apply lasted over a minute on a laptop.
      expect(longestSeconds).toBeLessThan(10);
      const state = await remoteState();
      expect(new Set(state.events.map((row) => row.remote_id)).size).toBe(2004);
      expect(state.events).toHaveLength(2004);
    } finally {
      await shared.end();
    }
  }, 600_000);

  it("a Calendars switch waits for an apply holding the account's guard", async () => {
    const accountId = await createAccount({ calendarsEnabled: true });
    let releaseGuard: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });
    let guardHeld: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      guardHeld = resolve;
    });
    const holder = inTenant(async (client) => {
      await lockCalendarAccountSync(client, accountId);
      guardHeld();
      await released;
    });
    await held;
    let switched = false;
    const switching = switchCalendars(accountId, false).then(() => {
      switched = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(switched).toBe(false);
    releaseGuard();
    await holder;
    await switching;
    expect(switched).toBe(true);
  });
});
