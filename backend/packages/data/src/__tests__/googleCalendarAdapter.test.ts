import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@alldots/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createUser } from "../auth/usersStore.js";
import { logger as calendarLogger } from "../calendar/logger.js";
import {
  CalendarSyncEventConflictError,
  type RemoteCalendar,
  type RemoteEventFields,
} from "../calendar/sync/adapter.js";
import {
  GoogleCalendarAdapter,
  googleEventIdOf,
  setGoogleCalendarSyncRuntime,
  type GoogleCalendarSyncRuntime,
} from "../calendar/sync/adapters/google/googleCalendarAdapter.js";
import { handleCalendarAccountSyncTask } from "../calendar/sync/calendarAccountSyncJob.js";
import { resolveCalendarSyncIds, type CalendarSyncIds } from "../calendar/sync/calendarSyncStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getDecryptedCredential, storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { ForbiddenError } from "../errors.js";
import { ensureMailAccountSyncState, recordGrantedOauthScopes } from "../mail/mailAccountSyncStateStore.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const API = "https://www.googleapis.com/calendar/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PRIMARY = "me@example.test";
const HOLIDAYS = "cs.czech#holiday@group.v.calendar.google.com";
const REFRESH_TOKEN = "1//refresh-token-of-the-account";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const USER_WRITER = { writerKind: "user" } as const;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/googleCalendar/${name}.json`, import.meta.url), "utf8"));
}

/** The `standup` master as the first events page lists it, for `events.get`. */
function standupMaster(): unknown {
  const page = z.object({ items: z.array(z.object({ id: z.string() }).loose()) }).parse(fixture("primaryEventsPage1"));
  return page.items.find((item) => item.id === "standup");
}

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface RecordedRequest {
  method: string;
  /** Below the API base, decoded. */
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

type Route = (request: RecordedRequest) => Reply | undefined;

/** Google's token endpoint and Calendar API over the recorded responses; an unrouted request fails the test. */
class FakeGoogle {
  readonly requests: RecordedRequest[] = [];
  tokenRequests = 0;
  tokenStatus = 200;
  private routes: Route[] = [];

  on(method: string, path: string, reply: (request: RecordedRequest) => Reply | undefined): this {
    this.routes.push((request) => (request.method === method && request.path === path ? reply(request) : undefined));
    return this;
  }

  /** Replaces every route; the request log stays. */
  reset(): this {
    this.routes = [];
    return this;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.href === TOKEN_URL) {
      this.tokenRequests += 1;
      const form =
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe(REFRESH_TOKEN);
      return this.tokenStatus === 200
        ? Response.json({ access_token: `access-${this.tokenRequests}`, expires_in: 3599, token_type: "Bearer" })
        : Response.json({ error: "invalid_grant" }, { status: this.tokenStatus });
    }
    if (!url.href.startsWith(`${API}/`)) throw new Error(`unexpected request to ${url.origin}`);
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname.slice(new URL(API).pathname.length)),
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    this.requests.push(request);
    for (const route of this.routes) {
      const reply = route(request);
      if (reply !== undefined) {
        return reply.body === undefined
          ? new Response(null, { status: reply.status, headers: reply.headers })
          : Response.json(reply.body, { status: reply.status, headers: reply.headers });
      }
    }
    throw new Error(`no recorded response for ${request.method} ${request.path}?${request.query.toString()}`);
  };

  eventRequests(calendarId: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path === `/calendars/${calendarId}/events`);
  }
}

/** The first pass's answers: both calendars listed in full, the primary one over two pages. */
function firstPassRoutes(google: FakeGoogle): FakeGoogle {
  return google
    .on("GET", "/users/me/calendarList", () => ({ status: 200, body: fixture("calendarList") }))
    .on("GET", `/calendars/${PRIMARY}/events`, (request) =>
      request.query.has("syncToken")
        ? undefined
        : {
            status: 200,
            body: fixture(request.query.has("pageToken") ? "primaryEventsPage2" : "primaryEventsPage1"),
          },
    )
    .on("GET", `/calendars/${HOLIDAYS}/events`, (request) =>
      request.query.has("syncToken") ? undefined : { status: 200, body: fixture("holidaysEvents") },
    );
}

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let userId: string;
let google: FakeGoogle;

function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

async function ids(tenantId = tenant): Promise<CalendarSyncIds> {
  const resolved = await inTenant((client) => resolveCalendarSyncIds(client), tenantId);
  if (resolved === null) throw new Error("the tenant has no calendar databases");
  return resolved;
}

function googleRuntime(): GoogleCalendarSyncRuntime {
  return { pool: runtime, clientId: "client-id", clientSecret: "client-secret", fetchImpl: google.fetch };
}

/** A Google account with Calendars on, its refresh token stored and the given grant recorded. */
async function createGoogleAccount(grantedScopes: string[], tenantId = tenant): Promise<string> {
  const { mailboxesDatabaseId } = await ids(tenantId);
  return inTenant(async (client) => {
    const mailbox = await createChokePoint(runtime).createItem({
      databaseId: mailboxesDatabaseId,
      properties: { name: "Google", provider: "gmail", mailEnabled: true, calendarsEnabled: true },
    });
    await writeMailboxAddresses(client, { mailboxesDatabaseId, mailboxItemId: mailbox.id, address: PRIMARY });
    await storeCredential(client, {
      itemId: mailbox.id,
      credentialType: "oauth2_refresh_token",
      plaintext: REFRESH_TOKEN,
    });
    await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "gmail_api" });
    await recordGrantedOauthScopes(client, mailbox.id, grantedScopes);
    return mailbox.id;
  }, tenantId);
}

const GRANT = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  CALENDAR_SCOPE,
];

/** A pass through the production adapter registry. */
function runPass(accountId: string, tenantId = tenant) {
  return runInTenant(tenantId, () => handleCalendarAccountSyncTask(runtime, { accountItemId: accountId }));
}

const itemRow = z.object({
  id: z.uuid(),
  properties: z.record(z.string(), z.unknown()),
  row_version: z.string(),
  deleted: z.boolean(),
  remote_id: z.string().nullable(),
});

async function syncedItems(tenantId = tenant) {
  const { calendarsDatabaseId, eventsDatabaseId } = await ids(tenantId);
  return inTenant(async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT i.id, i.properties, i.xmin::text AS row_version, (i.deleted_at IS NOT NULL) AS deleted,
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

async function syncTokens(): Promise<Record<string, string | null>> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{ remote_id: string; sync_token: string | null }>(
      "SELECT remote_id, sync_token FROM calendar_remote_state ORDER BY remote_id",
    );
    return Object.fromEntries(rows.map((row) => [row.remote_id, row.sync_token]));
  });
}

async function baseSnapshot(remoteId: string): Promise<unknown> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{ base_snapshot: unknown }>(
      "SELECT base_snapshot FROM event_remote_state WHERE remote_id = $1",
      [remoteId],
    );
    return rows[0]?.base_snapshot;
  });
}

const syncStateRow = z.object({ status: z.string(), last_error_code: z.string().nullable() });

async function syncState(accountId: string) {
  return inTenant(async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      "SELECT status, last_error_code FROM calendar_account_sync_state WHERE account_item_id = $1",
      [accountId],
    );
    return rows[0] === undefined ? null : syncStateRow.parse(rows[0]);
  });
}

async function renameEvent(eventItemId: string, name: string) {
  const { eventsDatabaseId } = await ids();
  return runInTenant(tenant, () =>
    createChokePoint(runtime).updateItem(
      { databaseId: eventsDatabaseId, itemId: eventItemId, propertiesPatch: { name } },
      userId,
      userId,
      USER_WRITER,
    ),
  );
}

describe("Google Calendar adapter", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "alldots_data");
  });

  afterAll(async () => {
    await runtime.end();
  });

  beforeEach(async () => {
    // The sync window is a year back and two ahead of today; the recorded events sit in late 2026.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-20T09:00:00Z") });
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) {
      const user = await createUser(admin, {
        tenantId: id,
        email: `${randomUUID()}@example.test`,
        passwordHash: "unused",
        locale: "en",
      });
      if (id === tenant) userId = user.id;
      await runInTenant(id, () => seedSystem(runtime));
    }
    google = new FakeGoogle();
    setGoogleCalendarSyncRuntime(googleRuntime());
  });

  afterEach(() => {
    setGoogleCalendarSyncRuntime(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("the first pass lists the calendars and maps an all-day multi-day event and a zoned recurring series", async () => {
    const warn = vi.spyOn(calendarLogger, "warn");
    firstPassRoutes(google);
    const accountId = await createGoogleAccount(GRANT);

    const result = await runPass(accountId);
    expect(result?.kind === "applied" ? result.added.map((event) => event.remoteId).sort() : null).toEqual([
      "20270101_newyear",
      "conf2026",
      "lateshow",
      "standup",
      "standup_20261125T140000Z",
    ]);

    expect((await itemByRemoteId(PRIMARY)).properties).toMatchObject({
      kind: "account",
      remoteName: PRIMARY,
      remoteColor: "#9FE1E7",
      readOnly: false,
    });
    expect((await itemByRemoteId(HOLIDAYS)).properties).toMatchObject({
      kind: "account",
      remoteName: "Czech holidays",
      remoteColor: "#16A765",
      readOnly: true,
    });

    const conference = (await itemByRemoteId("conf2026")).properties;
    expect(conference).toMatchObject({ name: "Conference", place: "Brno", date: "2026-12-07", endDate: "2026-12-09" });
    // An empty field is not stored.
    expect([conference.timeFrom, conference.timeTo, conference.alertMinutes, conference.timeZone]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const standup = await itemByRemoteId("standup");
    // Listed as 15:00 Prague time; stored as the 09:00 New York wall clock it was entered in.
    expect(standup.properties).toMatchObject({
      name: "Standup",
      date: "2026-11-18",
      timeFrom: "09:00",
      timeTo: "09:30",
      timeZone: "America/New_York",
      recurrenceRule: "FREQ=WEEKLY;BYDAY=WE;COUNT=10",
      exceptionDates: ["2026-12-02T09:00", "2026-12-09T09:00"],
      alertMinutes: 10,
    });
    expect((await itemByRemoteId("standup_20261125T140000Z")).properties).toMatchObject({
      name: "Standup (late)",
      seriesId: standup.id,
      recurrenceId: "2026-11-25T09:00",
      timeFrom: "10:00",
      timeTo: "10:30",
      timeZone: "America/New_York",
      alertMinutes: 5,
    });
    expect((await itemByRemoteId("lateshow")).properties).toMatchObject({
      date: "2026-11-27",
      timeFrom: "22:00",
      timeTo: "24:00",
      timeZone: "Europe/Prague",
      url: "https://tickets.example.test/42",
      alertMinutes: 10,
    });
    expect(await baseSnapshot("standup")).toMatchObject({
      seriesRemoteId: null,
      organizer: { email: "boss@example.test", name: "Boss", role: null, status: null },
      attendees: [
        { email: "boss@example.test", name: "Boss", role: "required", status: "accepted" },
        { email: PRIMARY, name: null, role: "required", status: "needsAction" },
        { email: "guest@example.test", name: null, role: "optional", status: "tentative" },
      ],
    });

    expect(await syncTokens()).toEqual({
      [HOLIDAYS]: "CMDQwfiFx5EDEMDQwfiFx5EDGAEgwP7g",
      [PRIMARY]: "CPDAlvWFx5EDEPDAlvWFx5EDGAUggICA",
    });
    expect(await syncState(accountId)).toEqual({ status: "ok", last_error_code: null });

    const listings = google.eventRequests(PRIMARY);
    expect(listings).toHaveLength(2);
    for (const listing of listings) {
      expect(Object.fromEntries(listing.query)).toMatchObject({
        singleEvents: "false",
        showDeleted: "true",
        timeMin: "2025-11-19T00:00:00Z",
        timeMax: "2028-11-22T00:00:00Z",
      });
      expect(listing.headers.get("authorization")).toBe("Bearer access-1");
    }
    // One refresh for the pass, and the stored credential is still the refresh token: no access token is kept.
    expect(google.tokenRequests).toBe(1);
    const stored = await inTenant((client) =>
      getDecryptedCredential(client, { itemId: accountId, actorType: "sync_worker", purpose: "test" }),
    );
    expect(stored).toBe(REFRESH_TOKEN);
    expect(warn).toHaveBeenCalledWith(
      { accountItemId: accountId, tag: "googleUnsupportedRecurrenceLine", property: "RDATE" },
      expect.any(String),
    );
  });

  it("leaves out an event of a page that is no readable Google event and syncs the rest of the calendar", async () => {
    const warn = vi.spyOn(calendarLogger, "warn");
    const withMalformed = z
      .object({ items: z.array(z.unknown()) })
      .loose()
      .parse(fixture("primaryEventsPage1"));
    google
      .on("GET", "/users/me/calendarList", () => ({ status: 200, body: fixture("calendarList") }))
      .on("GET", `/calendars/${PRIMARY}/events`, (request) => {
        if (request.query.has("syncToken")) return undefined;
        if (request.query.has("pageToken")) return { status: 200, body: fixture("primaryEventsPage2") };
        const malformed = [
          {
            id: "fractional-reminder",
            reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 1.5 }] },
          },
          { id: "negative-sequence", sequence: -1, summary: "Broken" },
          { summary: "No id" },
        ];
        return { status: 200, body: { ...withMalformed, items: [...withMalformed.items, ...malformed] } };
      })
      .on("GET", `/calendars/${HOLIDAYS}/events`, (request) =>
        request.query.has("syncToken") ? undefined : { status: 200, body: fixture("holidaysEvents") },
      );
    const accountId = await createGoogleAccount(GRANT);

    const result = await runPass(accountId);

    expect(result?.kind === "applied" ? result.added.map((event) => event.remoteId).sort() : null).toEqual([
      "20270101_newyear",
      "conf2026",
      "lateshow",
      "standup",
      "standup_20261125T140000Z",
    ]);
    const skipped = warn.mock.calls.filter(([fields]) => JSON.stringify(fields).includes("unreadableEvent"));
    expect(skipped).toHaveLength(3);
    // The log names the account and the tag only, never what the item held.
    expect(JSON.stringify(skipped)).not.toMatch(/Broken|fractional|negative/);
  });

  it("an Event of a reader calendar is read-only in the app while one of an owned calendar is editable", async () => {
    firstPassRoutes(google);
    const accountId = await createGoogleAccount(GRANT);
    await runPass(accountId);

    const holiday = await itemByRemoteId("20270101_newyear");
    const refused = await renameEvent(holiday.id, "Day off").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect(refused).toMatchObject({ code: "calendar_read_only" });
    expect((await itemByRemoteId("20270101_newyear")).properties.name).toBe("New Year's Day");

    await renameEvent((await itemByRemoteId("conf2026")).id, "Conference (talk)");
    expect((await itemByRemoteId("conf2026")).properties.name).toBe("Conference (talk)");
  });

  it("a 410 on a sync token lists that calendar again in full and leaves the other calendar incremental", async () => {
    firstPassRoutes(google);
    const accountId = await createGoogleAccount(GRANT);
    await runPass(accountId);
    const holidayBefore = await itemByRemoteId("20270101_newyear");
    const lateShowId = (await itemByRemoteId("lateshow")).id;

    // The late show is gone from the new full listing; a full fetch trashes what it no longer lists.
    const secondPage = z
      .object({ items: z.array(z.object({ id: z.string() }).loose()) })
      .loose()
      .parse(fixture("primaryEventsPage2"));
    const withoutLateShow = { ...secondPage, items: secondPage.items.filter((item) => item.id !== "lateshow") };
    google
      .reset()
      .on("GET", "/users/me/calendarList", () => ({ status: 200, body: fixture("calendarList") }))
      .on("GET", `/calendars/${PRIMARY}/events`, (request) => {
        if (request.query.has("syncToken")) return { status: 410, body: fixture("syncTokenGone") };
        return { status: 200, body: request.query.has("pageToken") ? withoutLateShow : fixture("primaryEventsPage1") };
      })
      .on("GET", `/calendars/${HOLIDAYS}/events`, (request) =>
        request.query.get("syncToken") === "CMDQwfiFx5EDEMDQwfiFx5EDGAEgwP7g"
          ? { status: 200, body: fixture("holidaysIncrementalEmpty") }
          : undefined,
      );
    const before = google.requests.length;

    const result = await runPass(accountId);
    expect(result).toMatchObject({ kind: "applied", added: [], changed: [] });
    expect(result?.kind === "applied" ? result.cancelled.map((event) => event.remoteId) : null).toEqual(["lateshow"]);
    expect((await syncedItems()).find((item) => item.id === lateShowId)).toMatchObject({
      deleted: true,
      remote_id: null,
    });
    expect(await itemByRemoteId("20270101_newyear")).toEqual(holidayBefore);

    const primary = google.eventRequests(PRIMARY).filter((request) => google.requests.indexOf(request) >= before);
    expect(primary.map((request) => [request.query.has("syncToken"), request.query.has("timeMin")])).toEqual([
      [true, false],
      [false, true],
      [false, true],
    ]);
    const holidays = google.eventRequests(HOLIDAYS).filter((request) => google.requests.indexOf(request) >= before);
    expect(holidays.map((request) => request.query.has("timeMin"))).toEqual([false]);
    expect(await syncTokens()).toEqual({
      [HOLIDAYS]: "CMDQwfiFx5EDEMDQwfiFx5EDGAEgwP7h",
      [PRIMARY]: "CPDAlvWFx5EDEPDAlvWFx5EDGAUggICA",
    });
    expect(await syncState(accountId)).toEqual({ status: "ok", last_error_code: null });
  });

  it("an incremental cancellation of one instance adds its start to the master's exception dates", async () => {
    firstPassRoutes(google);
    const accountId = await createGoogleAccount(GRANT);
    await runPass(accountId);
    const before = await itemByRemoteId("standup");

    google
      .reset()
      .on("GET", "/users/me/calendarList", () => ({ status: 200, body: fixture("calendarList") }))
      .on("GET", `/calendars/${PRIMARY}/events`, () => ({
        status: 200,
        body: fixture("primaryIncrementalCancelledInstance"),
      }))
      .on("GET", `/calendars/${PRIMARY}/events/standup`, () => ({ status: 200, body: standupMaster() }))
      .on("GET", `/calendars/${PRIMARY}/events/standup/instances`, (request) =>
        request.query.get("showDeleted") === "true" ? { status: 200, body: fixture("standupInstances") } : undefined,
      )
      .on("GET", `/calendars/${HOLIDAYS}/events`, () => ({ status: 200, body: fixture("holidaysIncrementalEmpty") }));

    const result = await runPass(accountId);
    expect(result?.kind === "applied" ? result.changed.map((event) => event.remoteId) : null).toEqual(["standup"]);
    const after = await itemByRemoteId("standup");
    expect(after.id).toBe(before.id);
    expect(after.properties).toMatchObject({
      name: "Standup",
      recurrenceRule: "FREQ=WEEKLY;BYDAY=WE;COUNT=10",
      exceptionDates: ["2026-12-02T09:00", "2026-12-09T09:00", "2026-12-16T09:00"],
    });
    expect((await itemByRemoteId("standup_20261125T140000Z")).deleted).toBe(false);
    expect((await syncTokens())[PRIMARY]).toBe("CPDAlvWFx5EDEPDAlvWFx5EDGAUggICB");
  });

  it.each([
    {
      name: "a missing calendar scope",
      reply: { status: 403, body: fixture("insufficientScope") },
      expected: { status: "needsConsent", last_error_code: "consentRequired" },
    },
    {
      name: "a scope challenge without a body",
      reply: { status: 403, headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope"' } },
      expected: { status: "needsConsent", last_error_code: "consentRequired" },
    },
    {
      name: "a rate limit answered with 403",
      reply: { status: 403, body: fixture("rateLimited") },
      expected: { status: "error", last_error_code: "rateLimited" },
    },
    {
      name: "a server failure",
      reply: { status: 503 },
      expected: { status: "error", last_error_code: "providerUnavailable" },
    },
  ])("$name on the calendar list records $expected.status and writes nothing", async ({ reply, expected }) => {
    google.on("GET", "/users/me/calendarList", () => reply);
    const accountId = await createGoogleAccount(GRANT);

    const pass = runPass(accountId);
    if (expected.status === "error") await expect(pass).rejects.toThrow();
    else expect(await pass).toBeNull();
    expect(await syncState(accountId)).toEqual(expected);
    expect(await syncedItems()).toEqual([]);
  });

  it("a 401 refreshes once and retries; a second 401 sets needsReauthorization", async () => {
    let refusals = 1;
    firstPassRoutes(google.on("GET", "/users/me/calendarList", () => (refusals-- > 0 ? { status: 401 } : undefined)));
    const recovered = await createGoogleAccount(GRANT);
    expect((await runPass(recovered))?.kind).toBe("applied");
    expect(google.tokenRequests).toBe(2);

    google.reset().on("GET", "/users/me/calendarList", () => ({ status: 401 }));
    const revoked = await createGoogleAccount(GRANT, foreign);
    expect(await runPass(revoked, foreign)).toBeNull();
    const state = await runInTenant(foreign, () =>
      withTransaction(runtime, async (client) => {
        const { rows } = await client.query<{ status: string }>(
          "SELECT status FROM calendar_account_sync_state WHERE account_item_id = $1",
          [revoked],
        );
        return rows[0]?.status;
      }),
    );
    expect(state).toBe("needsReauthorization");
  });

  it("a refused refresh token sets needsReauthorization without calling the Calendar API", async () => {
    google.tokenStatus = 400;
    const accountId = await createGoogleAccount(GRANT);
    expect(await runPass(accountId)).toBeNull();
    expect(await syncState(accountId)).toEqual({
      status: "needsReauthorization",
      last_error_code: "reauthorizationRequired",
    });
    expect(google.requests).toEqual([]);
  });

  describe("writes", () => {
    const calendar: RemoteCalendar = {
      remoteId: PRIMARY,
      url: null,
      name: PRIMARY,
      color: null,
      readOnly: false,
      ctag: null,
    };
    const fields: RemoteEventFields = {
      name: "Standup",
      date: "2026-11-18",
      endDate: null,
      timeFrom: "09:00",
      timeTo: "09:30",
      timeZone: "America/New_York",
      recurrenceRule: "FREQ=WEEKLY;BYDAY=WE",
      exceptionDates: ["2026-12-02T09:00"],
      recurrenceId: null,
      place: "Room 4",
      description: null,
      url: null,
      alertMinutes: 15,
    };
    const signal = () => AbortSignal.timeout(10_000);

    function adapterIn(accountId: string, tenantId = tenant) {
      const adapter = new GoogleCalendarAdapter(googleRuntime(), accountId);
      return <T>(fn: (adapter: GoogleCalendarAdapter) => Promise<T>) => runInTenant(tenantId, () => fn(adapter));
    }

    it("a new Event is inserted with its iCalendar UID and no guest notification", async () => {
      google.on("POST", `/calendars/${PRIMARY}/events`, () => ({
        status: 200,
        body: { kind: "calendar#event", id: "newid", etag: '"e-new"', status: "confirmed", iCalUID: "0f4c@alldots" },
      }));
      const run = adapterIn(await createGoogleAccount(GRANT));

      const ref = await run((adapter) =>
        adapter.putEvent(calendar, { ref: null, fields, icalUid: "0f4c@alldots" }, signal()),
      );
      expect(ref).toEqual({ remoteId: "newid", href: null, etag: '"e-new"' });
      const [insert] = google.requests;
      expect(insert?.query.get("sendUpdates")).toBe("none");
      expect(insert?.headers.get("if-match")).toBeNull();
      expect(insert?.body).toEqual({
        iCalUID: "0f4c@alldots",
        summary: "Standup",
        location: "Room 4",
        description: null,
        start: { dateTime: "2026-11-18T09:00:00", timeZone: "America/New_York" },
        end: { dateTime: "2026-11-18T09:30:00", timeZone: "America/New_York" },
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE", "EXDATE;TZID=America/New_York:20261202T090000"],
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] },
        source: null,
      });
    });

    it("a create for a local Event names the Google event after it, so a repeat writes onto the first one", async () => {
      const eventItemId = randomUUID();
      const first = googleEventIdOf(PRIMARY, eventItemId, 0);
      const second = googleEventIdOf(PRIMARY, eventItemId, 1);
      expect(first).toMatch(/^[0-9a-v]{32}$/);
      expect(googleEventIdOf(PRIMARY, randomUUID(), 0)).not.toBe(first);
      const live = new Set<string>();
      const cancelled = new Set<string>([first]);
      google.on("POST", `/calendars/${PRIMARY}/events`, (request) => {
        const id = z.object({ id: z.string() }).parse(request.body).id;
        if (live.has(id) || cancelled.has(id)) return { status: 409 };
        live.add(id);
        return { status: 200, body: { id, etag: '"e-1"', status: "confirmed" } };
      });
      for (const id of [first, second]) {
        google.on("GET", `/calendars/${PRIMARY}/events/${id}`, () => ({
          status: 200,
          body: { id, etag: '"e-1"', status: cancelled.has(id) ? "cancelled" : "confirmed" },
        }));
        google.on("PATCH", `/calendars/${PRIMARY}/events/${id}`, (request) =>
          request.headers.get("if-match") === '"e-1"' ? { status: 200, body: { id, etag: '"e-2"' } } : { status: 412 },
        );
      }
      const run = adapterIn(await createGoogleAccount(GRANT));
      const create = () =>
        run((adapter) => adapter.putEvent(calendar, { ref: null, fields, createKey: eventItemId }, signal()));

      // The first id names an event deleted in this calendar: the next generation's is used.
      expect(await create()).toEqual({ remoteId: second, href: null, etag: '"e-1"' });
      google.requests.length = 0;
      // A repeat (its answer lost) finds that event and writes the fields onto it, conditional on its etag.
      expect(await create()).toEqual({ remoteId: second, href: null, etag: '"e-2"' });
      expect(google.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        `POST /calendars/${PRIMARY}/events`,
        `GET /calendars/${PRIMARY}/events/${first}`,
        `POST /calendars/${PRIMARY}/events`,
        `GET /calendars/${PRIMARY}/events/${second}`,
        `PATCH /calendars/${PRIMARY}/events/${second}`,
      ]);
      expect(google.requests.at(-1)?.body).toMatchObject({ summary: "Standup", location: "Room 4" });
      expect(live.size).toBe(1);
    });

    it("a create with both an iCalendar UID and a local key names only the UID, and restores its own deleted event", async () => {
      const icalUid = `${randomUUID()}@alldots`;
      const createKey = randomUUID();
      let taken: { status: "confirmed" | "cancelled"; createKey: string | undefined } | null = null;
      google.on("POST", `/calendars/${PRIMARY}/events`, (request) => {
        const sent = z
          .object({
            id: z.string().optional(),
            iCalUID: z.string().optional(),
            extendedProperties: z.object({ private: z.record(z.string(), z.string()) }).optional(),
          })
          .parse(request.body);
        // Google's rule: an insert naming both is refused; it derives the id from the iCalUID.
        if (sent.id !== undefined && sent.iCalUID !== undefined) return { status: 400 };
        if (taken !== null) return { status: 409 };
        taken = { status: "confirmed", createKey: sent.extendedProperties?.private.alldotsCreateKey };
        return { status: 200, body: { id: "uidid", etag: '"e-1"', status: "confirmed", iCalUID: icalUid } };
      });
      google.on("GET", `/calendars/${PRIMARY}/events`, (request) => ({
        status: 200,
        body: {
          items:
            taken !== null && request.query.get("iCalUID") === icalUid && request.query.get("showDeleted") === "true"
              ? [
                  {
                    id: "uidid",
                    etag: '"e-1"',
                    status: taken.status,
                    iCalUID: icalUid,
                    ...(taken.createKey
                      ? { extendedProperties: { private: { alldotsCreateKey: taken.createKey } } }
                      : {}),
                  },
                ]
              : [],
        },
      }));
      google.on("PATCH", `/calendars/${PRIMARY}/events/uidid`, (request) =>
        request.headers.get("if-match") === '"e-1"'
          ? { status: 200, body: { id: "uidid", etag: '"e-2"' } }
          : { status: 412 },
      );
      const run = adapterIn(await createGoogleAccount(GRANT));
      const create = (key: string) =>
        run((adapter) => adapter.putEvent(calendar, { ref: null, fields, icalUid, createKey: key }, signal()));

      expect(await create(createKey)).toEqual({ remoteId: "uidid", href: null, etag: '"e-1"' });
      expect(google.requests[0]?.body).toMatchObject({
        iCalUID: icalUid,
        summary: "Standup",
        extendedProperties: { private: { alldotsCreateKey: createKey } },
      });
      expect(google.requests[0]?.body).not.toHaveProperty("id");

      // Deleted at Google: a repeat for the same local Event restores it.
      taken = { status: "cancelled", createKey };
      google.requests.length = 0;
      expect(await create(createKey)).toEqual({ remoteId: "uidid", href: null, etag: '"e-2"' });
      expect(google.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        `POST /calendars/${PRIMARY}/events`,
        `GET /calendars/${PRIMARY}/events`,
        `PATCH /calendars/${PRIMARY}/events/uidid`,
      ]);
      expect(google.requests.at(-1)?.body).toMatchObject({ summary: "Standup", status: "confirmed" });

      // The UID taken by an event this Event did not create (another client's, or another local Event's): refused.
      for (const other of [
        { status: "confirmed" as const, createKey: undefined },
        { status: "confirmed" as const, createKey: randomUUID() },
      ]) {
        taken = other;
        google.requests.length = 0;
        await expect(create(createKey)).rejects.toThrow("Google Calendar refused the request with status 409");
        expect(google.requests.map((request) => request.method)).toEqual(["POST", "GET"]);
      }
    });

    it("an all-day Event without a zone is written with an exclusive end day", async () => {
      google.on("POST", `/calendars/${PRIMARY}/events`, () => ({ status: 200, body: { id: "conf", etag: '"e1"' } }));
      const run = adapterIn(await createGoogleAccount(GRANT));
      await run((adapter) =>
        adapter.putEvent(
          calendar,
          {
            ref: null,
            fields: {
              ...fields,
              date: "2026-12-07",
              endDate: "2026-12-09",
              timeFrom: null,
              timeTo: null,
              timeZone: null,
              recurrenceRule: null,
              exceptionDates: null,
              alertMinutes: null,
            },
          },
          signal(),
        ),
      );
      expect(google.requests[0]?.body).toMatchObject({
        start: { date: "2026-12-07" },
        end: { date: "2026-12-10" },
        recurrence: [],
        reminders: { useDefault: false, overrides: [] },
      });
    });

    it("an update is a patch conditional on the etag; a 412 is reported as a conflict", async () => {
      let current = '"e-1"';
      google.on("PATCH", `/calendars/${PRIMARY}/events/standup`, (request) => {
        if (request.headers.get("if-match") !== current) return { status: 412 };
        current = '"e-2"';
        return { status: 200, body: { id: "standup", etag: current } };
      });
      const run = adapterIn(await createGoogleAccount(GRANT));

      const updated = await run((adapter) =>
        adapter.putEvent(calendar, { ref: { remoteId: "standup", href: null, etag: '"e-1"' }, fields }, signal()),
      );
      expect(updated).toEqual({ remoteId: "standup", href: null, etag: '"e-2"' });
      await expect(
        run((adapter) =>
          adapter.putEvent(calendar, { ref: { remoteId: "standup", href: null, etag: '"e-1"' }, fields }, signal()),
        ),
      ).rejects.toBeInstanceOf(CalendarSyncEventConflictError);
      expect(google.requests.map((request) => request.query.get("sendUpdates"))).toEqual(["none", "none"]);
    });

    it.each([404, 410])(
      "an update of an event Google no longer has (%i) is a conflict, and reading it back finds it gone",
      async (status) => {
        google
          .on("PATCH", `/calendars/${PRIMARY}/events/standup`, () => ({ status }))
          .on("GET", `/calendars/${PRIMARY}/events/standup`, () => ({ status }));
        const run = adapterIn(await createGoogleAccount(GRANT));
        const ref = { remoteId: "standup", href: null, etag: '"e-1"' };

        await expect(run((adapter) => adapter.putEvent(calendar, { ref, fields }, signal()))).rejects.toBeInstanceOf(
          CalendarSyncEventConflictError,
        );
        expect(
          await run((adapter) =>
            adapter.getEvent(calendar, ref, { window: { start: "2026-11-01", end: "2026-12-31" }, signal: signal() }),
          ),
        ).toBeNull();
      },
    );

    it("an override is patched without recurrence lines", async () => {
      google.on("PATCH", `/calendars/${PRIMARY}/events/standup_20261125T140000Z`, () => ({
        status: 200,
        body: { id: "standup_20261125T140000Z", etag: '"o2"' },
      }));
      const run = adapterIn(await createGoogleAccount(GRANT));
      await run((adapter) =>
        adapter.putEvent(
          calendar,
          {
            ref: { remoteId: "standup_20261125T140000Z", href: null, etag: '"o1"' },
            fields: { ...fields, recurrenceRule: null, exceptionDates: null, recurrenceId: "2026-11-25T09:00" },
          },
          signal(),
        ),
      );
      expect(google.requests[0]?.body).not.toHaveProperty("recurrence");
    });

    it("a new override patches the series' instance at its original start", async () => {
      google.on("GET", `/calendars/${PRIMARY}/events/standup/instances`, () => ({
        status: 200,
        body: {
          items: [
            {
              id: "standup_20261125T140000Z",
              etag: '"o1"',
              status: "confirmed",
              recurringEventId: "standup",
              originalStartTime: { dateTime: "2026-11-25T09:00:00-05:00", timeZone: "America/New_York" },
              start: { dateTime: "2026-11-25T09:00:00-05:00", timeZone: "America/New_York" },
              end: { dateTime: "2026-11-25T09:30:00-05:00", timeZone: "America/New_York" },
            },
          ],
        },
      }));
      google.on("PATCH", `/calendars/${PRIMARY}/events/standup_20261125T140000Z`, () => ({
        status: 200,
        body: { id: "standup_20261125T140000Z", etag: '"o2"' },
      }));
      const run = adapterIn(await createGoogleAccount(GRANT));
      const ref = await run((adapter) =>
        adapter.putEvent(
          calendar,
          {
            ref: null,
            fields: { ...fields, recurrenceRule: null, exceptionDates: null, recurrenceId: "2026-11-25T09:00" },
            seriesRef: { remoteId: "standup", href: null, etag: '"e-1"' },
          },
          signal(),
        ),
      );
      expect(ref).toEqual({ remoteId: "standup_20261125T140000Z", href: null, etag: '"o2"' });
      expect(google.requests.map((request) => `${request.method} ${request.headers.get("if-match")}`)).toEqual([
        "GET null",
        'PATCH "o1"',
      ]);
    });

    it("moves an event with Google's move, and reads one event back", async () => {
      google.on("POST", `/calendars/${PRIMARY}/events/lateshow/move`, () => ({
        status: 200,
        body: { id: "lateshow", etag: '"moved"' },
      }));
      google.on("GET", `/users/me/calendarList/${HOLIDAYS}`, () => ({
        status: 200,
        body: { timeZone: "Europe/Prague", defaultReminders: [{ method: "popup", minutes: 10 }] },
      }));
      google.on("GET", `/calendars/${HOLIDAYS}/events/lateshow`, () => ({
        status: 200,
        body: {
          id: "lateshow",
          etag: '"moved"',
          status: "confirmed",
          summary: "Late show",
          start: { dateTime: "2026-11-21T22:00:00+01:00", timeZone: "Europe/Prague" },
          end: { dateTime: "2026-11-22T00:00:00+01:00", timeZone: "Europe/Prague" },
        },
      }));
      google.on("GET", `/calendars/${HOLIDAYS}/events/gone`, () => ({ status: 404 }));
      const run = adapterIn(await createGoogleAccount(GRANT));
      const reader = { ...calendar, remoteId: HOLIDAYS };
      const moved = await run((adapter) =>
        adapter.moveEvent(calendar, reader, { remoteId: "lateshow", href: null, etag: '"e-late-1"' }, signal()),
      );
      expect(moved).toEqual({ remoteId: "lateshow", href: null, etag: '"moved"' });
      expect(google.requests[0]?.query.get("destination")).toBe(HOLIDAYS);
      const options = { window: { start: "2026-11-01", end: "2026-12-31" }, signal: signal() };
      expect(await run((adapter) => adapter.getEvent(reader, moved, options))).toMatchObject({
        remoteId: "lateshow",
        fields: { name: "Late show", timeFrom: "22:00", timeTo: "24:00", timeZone: "Europe/Prague", alertMinutes: 10 },
      });
      expect(
        await run((adapter) => adapter.getEvent(reader, { remoteId: "gone", href: null, etag: null }, options)),
      ).toBeNull();
    });

    it("a delete is conditional on the etag, an event already gone counts as deleted, and a 412 is a conflict", async () => {
      const replies = [{ status: 204 }, { status: 410 }, { status: 412 }];
      google.on("DELETE", `/calendars/${PRIMARY}/events/lateshow`, () => replies.shift());
      const run = adapterIn(await createGoogleAccount(GRANT));
      const ref = { remoteId: "lateshow", href: null, etag: '"e-late-1"' };

      await run((adapter) => adapter.deleteEvent(calendar, ref, signal()));
      await run((adapter) => adapter.deleteEvent(calendar, ref, signal()));
      await expect(run((adapter) => adapter.deleteEvent(calendar, ref, signal()))).rejects.toBeInstanceOf(
        CalendarSyncEventConflictError,
      );
      expect(google.requests.map((request) => request.headers.get("if-match"))).toEqual([
        '"e-late-1"',
        '"e-late-1"',
        '"e-late-1"',
      ]);
    });

    it("answers an invitation by patching only the account's attendee with guest notification", async () => {
      const meeting = {
        id: "review",
        etag: '"e-review-1"',
        iCalUID: "review@google.com",
        sequence: 2,
        status: "confirmed",
        summary: "Design review",
        start: { dateTime: "2026-11-27T10:00:00+01:00", timeZone: "Europe/Prague" },
        end: { dateTime: "2026-11-27T11:00:00+01:00", timeZone: "Europe/Prague" },
        organizer: { email: "olga@example.test", displayName: "Olga" },
        attendees: [
          { email: "olga@example.test", responseStatus: "accepted" },
          { email: "me.alias@example.test", self: true, responseStatus: "needsAction" },
        ],
      };
      google.on("GET", `/calendars/${PRIMARY}/events/review`, () => ({ status: 200, body: meeting }));
      google.on("PATCH", `/calendars/${PRIMARY}/events/review`, () => ({
        status: 200,
        body: { ...meeting, etag: '"e-review-2"' },
      }));
      google.on("GET", `/users/me/calendarList/${PRIMARY}`, () => ({
        status: 200,
        body: { timeZone: "Europe/Prague", defaultReminders: [] },
      }));
      google.on("GET", `/calendars/${PRIMARY}/events/gone`, () => ({ status: 404 }));
      const run = adapterIn(await createGoogleAccount(GRANT));
      const ref = { remoteId: "review", href: null, etag: '"e-review-1"' };
      const options = { window: { start: "2026-11-01", end: "2026-12-31" }, signal: signal() };

      expect(await run((adapter) => adapter.getEvent(calendar, ref, options))).toMatchObject({
        icalUid: "review@google.com",
        sequence: 2,
        selfStatus: "needsAction",
      });
      const answer = { response: "tentative", attendeeEmails: [PRIMARY] } as const;
      expect(await run((adapter) => adapter.respondToInvitation(calendar, ref, answer, signal()))).toBe("answered");
      const patch = google.requests.find((request) => request.method === "PATCH");
      expect(patch?.query.get("sendUpdates")).toBe("all");
      expect(patch?.body).toEqual({
        attendees: [{ email: "me.alias@example.test", responseStatus: "tentative" }],
        attendeesOmitted: true,
      });
      expect(
        await run((adapter) =>
          adapter.respondToInvitation(calendar, { remoteId: "gone", href: null, etag: null }, answer, signal()),
        ),
      ).toBe("gone");
    });

    it("an adapter running in another tenant cannot use the account's credential", async () => {
      const run = adapterIn(await createGoogleAccount(GRANT), foreign);
      await expect(run((adapter) => adapter.listCalendars(signal()))).rejects.toThrow(/No OAuth credential/);
      expect(google.tokenRequests).toBe(0);
      expect(google.requests).toEqual([]);
    });
  });
});
