import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUser } from "../auth/usersStore.js";
import {
  CalendarSyncEventConflictError,
  CalendarSyncProviderError,
  CalendarSyncReauthorizationRequiredError,
  CalendarSyncWriteUnsupportedError,
  type CalendarSyncAccount,
  type CalendarSyncAdapter,
  type RemoteCalendar,
  type RemoteEvent,
  type RemoteEventRef,
} from "../calendar/sync/adapter.js";
import { CALENDAR_SYNC_ADAPTERS } from "../calendar/sync/adapters/index.js";
import { createCalDavAdapter } from "../calendar/sync/adapters/caldav/caldavAdapter.js";
import { verifyCalDavServer } from "../calendar/sync/adapters/caldav/caldavConnectVerification.js";
import {
  CalDavAuthFailedError,
  CalDavServerInvalidError,
  CalDavServerUnreachableError,
} from "../calendar/sync/adapters/caldav/caldavErrors.js";
import { caldavCredentialScope } from "../calendar/sync/adapters/caldav/caldavHttp.js";
import { handleCalendarAccountSyncTask } from "../calendar/sync/calendarAccountSyncJob.js";
import {
  listEventRemoteStates,
  listSyncedAccountCalendars,
  resolveCalendarSyncIds,
  type CalendarSyncIds,
} from "../calendar/sync/calendarSyncStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { upsertMailServerSettings } from "../mail/mailServerSettingsStore.js";
import type { OutboundAddressPolicy } from "../net/outboundAddressPolicy.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeCalDavServer } from "../testSupport/fakeCalDavServer.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const LOGIN = { username: "owner@example.test", password: "app-specific-password" };

/**
 * Plain `http:` to the IP literal 127.0.0.1 only: every DNS name is refused, so a redirect to `localhost` is refused
 * although a server listens there, which `tsdav`'s own fetch would reach.
 */
const LOOPBACK_LITERAL_POLICY: OutboundAddressPolicy = {
  isTestPolicy: true,
  protocols: ["http:"],
  allowsIpLiteral: (address) => address === "127.0.0.1",
  allowsResolvedAddress: () => false,
};

const WINDOW = { start: "2025-11-20", end: "2028-11-20" };

const lines = (...rows: string[]): string => `${rows.join("\r\n")}\r\n`;

const PRAGUE_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Prague",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

/** A weekly series in Prague with an excluded week, an override, an alarm, an organizer and an attendee. */
const STANDUP_ICS = lines(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example//Calendar//EN",
  ...PRAGUE_VTIMEZONE,
  "BEGIN:VEVENT",
  "UID:standup-uid",
  "DTSTAMP:20261101T080000Z",
  "SUMMARY:Standup",
  "LOCATION:Room 4",
  "DESCRIPTION:Daily notes",
  "DTSTART;TZID=Europe/Prague:20261118T090000",
  "DTEND;TZID=Europe/Prague:20261118T091500",
  "RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=10",
  "EXDATE;TZID=Europe/Prague:20261202T090000",
  "ORGANIZER;CN=Boss:mailto:boss@example.test",
  "ATTENDEE;CN=Owner;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:owner@example.test",
  "X-CUSTOM-FLAG:kept",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "DESCRIPTION:Standup",
  "TRIGGER:-PT15M",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup-uid",
  "DTSTAMP:20261101T080000Z",
  "RECURRENCE-ID;TZID=Europe/Prague:20261125T090000",
  "SUMMARY:Standup (late)",
  "DTSTART;TZID=Europe/Prague:20261125T100000",
  "DTEND;TZID=Europe/Prague:20261125T101500",
  "END:VEVENT",
  "END:VCALENDAR",
);

const NEW_YEAR_ICS = lines(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example//Calendar//EN",
  "BEGIN:VEVENT",
  "UID:new-year-uid",
  "DTSTAMP:20261101T080000Z",
  "SUMMARY:New Year",
  "DTSTART;VALUE=DATE:20270101",
  "DTEND;VALUE=DATE:20270102",
  "END:VEVENT",
  "END:VCALENDAR",
);

const singleIcs = (uid: string, summary: string): string =>
  lines(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Example//Calendar//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20261101T080000Z",
    `SUMMARY:${summary}`,
    "DTSTART:20261126T110000Z",
    "DTEND:20261126T120000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  );

const TODO_ICS = lines(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example//Calendar//EN",
  "BEGIN:VTODO",
  "UID:todo-uid",
  "SUMMARY:Buy milk",
  "END:VTODO",
  "END:VCALENDAR",
);

const STANDUP_FIELDS = {
  name: "Standup",
  date: "2026-11-18",
  endDate: null,
  timeFrom: "09:00",
  timeTo: "09:15",
  timeZone: "Europe/Prague",
  recurrenceRule: "FREQ=WEEKLY;COUNT=10;BYDAY=WE",
  exceptionDates: ["2026-12-02T09:00"],
  recurrenceId: null,
  place: "Room 4",
  description: "Daily notes",
  url: null,
  alertMinutes: 15,
};

const LATE_STANDUP_FIELDS = {
  name: "Standup (late)",
  date: "2026-11-25",
  endDate: null,
  timeFrom: "10:00",
  timeTo: "10:15",
  timeZone: "Europe/Prague",
  recurrenceRule: null,
  exceptionDates: null,
  recurrenceId: "2026-11-25T09:00",
  place: null,
  description: null,
  url: null,
  alertMinutes: null,
};

let server: FakeCalDavServer;

function account(caldavUrl: string, overrides: Partial<CalendarSyncAccount> = {}): CalendarSyncAccount {
  return {
    accountItemId: "00000000-0000-4000-8000-000000000001",
    provider: "generic",
    syncMode: "imap",
    primaryAddress: LOGIN.username,
    credential: LOGIN.password,
    serverSettings: { username: LOGIN.username, caldavUrl },
    tenantTimeZone: "Europe/Prague",
    ...overrides,
  };
}

function adapter(overrides: Partial<CalendarSyncAccount> = {}, caldavUrl = `${server.origin}/.well-known/caldav`) {
  return createCalDavAdapter(account(caldavUrl, overrides), { policy: LOOPBACK_LITERAL_POLICY });
}

const signal = (): AbortSignal => AbortSignal.timeout(30_000);

const fetchOptions = (known: readonly RemoteEventRef[] = []) => ({ window: WINDOW, signal: signal(), known });

async function calendarNamed(caldav: CalendarSyncAdapter, name: string): Promise<RemoteCalendar> {
  const found = (await caldav.listCalendars(signal())).find((calendar) => calendar.name === name);
  if (!found) throw new Error(`no calendar ${name}`);
  return found;
}

function byRemoteId(events: RemoteEvent[]): Map<string, RemoteEvent> {
  return new Map(events.map((event) => [event.remoteId, event]));
}

function eventNamed(events: RemoteEvent[], name: string): RemoteEvent {
  const found = events.find((event) => event.fields.name === name);
  if (!found) throw new Error(`no event ${name}`);
  return found;
}

/** The resource's content lines with the given names, unfolded. */
function propertyLines(text: string, names: string[]): string[] {
  return text
    .replace(/\r\n[ \t]/g, "")
    .split("\r\n")
    .filter((line) => names.some((name) => line.startsWith(`${name}:`) || line.startsWith(`${name};`)));
}

/** The resource without its last VEVENT, which in `STANDUP_ICS` is the override. */
function withoutLastVevent(text: string): string {
  const start = text.lastIndexOf("BEGIN:VEVENT\r\n");
  const end = text.indexOf("END:VEVENT\r\n", start) + "END:VEVENT\r\n".length;
  return text.slice(0, start) + text.slice(end);
}

function refsOf(events: readonly RemoteEvent[]): RemoteEventRef[] {
  return events.map(({ remoteId, href, etag }) => ({ remoteId, href, etag }));
}

function multigetHrefsSince(index: number): string[] {
  return server.requests.slice(index).flatMap((request) => request.hrefs);
}

function requestsSince(index: number): string[] {
  return server.requests.slice(index).map((request) => `${request.method} ${request.report ?? request.path}`);
}

async function listen(handler: () => void): Promise<{ server: Server; port: number }> {
  const listening = createServer((_req, res) => {
    handler();
    res.end();
  });
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
  const address = listening.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { server: listening, port: address.port };
}

async function closeServer(listening: Server): Promise<void> {
  listening.closeAllConnections();
  await new Promise<void>((resolve) => listening.close(() => resolve()));
}

beforeEach(async () => {
  server = new FakeCalDavServer(LOGIN);
  await server.start();
  server.addCalendar("work", {
    displayName: "Work",
    color: "#FF2968FF",
    privileges: ["read", "write"],
    components: ["VEVENT", "VTODO"],
  });
  server.addCalendar("holidays", { displayName: "Holidays", color: "#1BADF8", privileges: ["read"], components: [] });
  server.addCalendar("tasks", { displayName: "Tasks", color: null, privileges: ["all"], components: ["VTODO"] });
  server.putResource("work", "standup.ics", STANDUP_ICS);
  server.putResource("work", "lunch.ics", singleIcs("lunch-uid", "Lunch"));
  server.putResource("work", "todo.ics", TODO_ICS);
  server.putResource("holidays", "new-year.ics", NEW_YEAR_ICS);
});

afterEach(async () => {
  await server.close();
});

describe("CalDAV adapter against a fake server", () => {
  it("is the production adapter of password accounts", () => {
    expect(CALENDAR_SYNC_ADAPTERS.imap).toBeTypeOf("function");
  });

  it("discovers the calendar home through the well-known redirect and lists Event calendars", async () => {
    const calendars = await adapter().listCalendars(signal());
    expect(calendars).toEqual([
      {
        remoteId: "/calendars/owner/work/",
        url: `${server.origin}/calendars/owner/work/`,
        name: "Work",
        color: "#FF2968",
        readOnly: false,
        ctag: expect.any(String),
      },
      {
        remoteId: "/calendars/owner/holidays/",
        url: `${server.origin}/calendars/owner/holidays/`,
        name: "Holidays",
        color: "#1BADF8",
        readOnly: true,
        ctag: expect.any(String),
      },
    ]);
    expect(server.requests.slice(0, 2).map((request) => request.path)).toEqual(["/.well-known/caldav", "/"]);
  });

  it("reads a full calendar: the series with its zone, exclusions, alarm and people, its override, an all-day Event", async () => {
    const caldav = adapter();
    const work = await calendarNamed(caldav, "Work");
    const changes = await caldav.fetchChanges(work, null, fetchOptions());
    expect(changes.full).toBe(true);
    expect(changes.deletions).toEqual([]);
    expect(changes.nextSyncState).toEqual({ syncToken: expect.stringContaining("/sync/"), ctag: work.ctag });
    const events = byRemoteId(changes.upserts);
    expect([...events.keys()].sort()).toEqual(['["standup-uid","2026-11-25T09:00"]', "lunch-uid", "standup-uid"]);
    expect(events.get("standup-uid")).toEqual({
      remoteId: "standup-uid",
      href: `${server.origin}/calendars/owner/work/standup.ics`,
      etag: server.resource("work", "standup.ics")?.etag,
      seriesRemoteId: null,
      fields: STANDUP_FIELDS,
      organizer: { email: "boss@example.test", name: "Boss", role: null, status: null },
      attendees: [{ email: "owner@example.test", name: "Owner", role: "REQ-PARTICIPANT", status: "NEEDS-ACTION" }],
      icalUid: "standup-uid",
      sequence: null,
    });
    expect(events.get('["standup-uid","2026-11-25T09:00"]')).toMatchObject({
      seriesRemoteId: "standup-uid",
      fields: LATE_STANDUP_FIELDS,
    });
    expect(events.get("lunch-uid")?.fields).toMatchObject({
      date: "2026-11-26",
      timeFrom: "11:00",
      timeTo: "12:00",
      timeZone: "UTC",
    });

    const holidays = await calendarNamed(caldav, "Holidays");
    const allDay = await caldav.fetchChanges(holidays, null, fetchOptions());
    expect(allDay.upserts.map((event) => event.fields)).toEqual([
      expect.objectContaining({ name: "New Year", date: "2027-01-01", endDate: null, timeFrom: null, timeZone: null }),
    ]);
  });

  it("fetches a changed Event through sync-collection and multiget only", async () => {
    const caldav = adapter();
    const work = await calendarNamed(caldav, "Work");
    const first = await caldav.fetchChanges(work, null, fetchOptions());
    server.putResource("work", "lunch.ics", singleIcs("lunch-uid", "Lunch with Peter"));
    const before = server.requests.length;
    const changes = await caldav.fetchChanges(work, first.nextSyncState, fetchOptions());
    expect(changes.full).toBe(false);
    expect(changes.deletions).toEqual([]);
    expect(changes.upserts.map((event) => [event.remoteId, event.fields.name])).toEqual([
      ["lunch-uid", "Lunch with Peter"],
    ]);
    expect(changes.nextSyncState.syncToken).not.toBe(first.nextSyncState.syncToken);
    expect(requestsSince(before)).toEqual(["REPORT sync-collection", "REPORT calendar-multiget"]);
  });

  it.each([
    ["a deleted resource", () => server.deleteResource("work", "lunch.ics"), ["standup-uid"]],
    [
      "a changed series",
      () => server.putResource("work", "standup.ics", STANDUP_ICS.replace("SUMMARY:Standup\r\n", "SUMMARY:Sync\r\n")),
      ["lunch-uid", "standup-uid"],
    ],
    ["an expired token", () => server.expireSyncTokens("work"), ["lunch-uid", "standup-uid"]],
  ])("reads the whole calendar again after %s", async (_label, change, masters) => {
    const caldav = adapter();
    const work = await calendarNamed(caldav, "Work");
    const first = await caldav.fetchChanges(work, null, fetchOptions());
    change();
    const changes = await caldav.fetchChanges(work, first.nextSyncState, fetchOptions());
    expect(changes.full).toBe(true);
    expect(
      changes.upserts
        .filter((event) => event.seriesRemoteId === null)
        .map((event) => event.remoteId)
        .sort(),
    ).toEqual(masters);
  });

  it("falls back to the ctag and the resources' ETags on a server without sync-collection", async () => {
    server.syncCollectionSupported = false;
    const caldav = adapter();
    const work = await calendarNamed(caldav, "Work");
    const first = await caldav.fetchChanges(work, null, fetchOptions());
    expect(first.nextSyncState).toEqual({ syncToken: null, ctag: work.ctag });
    expect(first.upserts.map((event) => event.remoteId).sort()).toEqual([
      '["standup-uid","2026-11-25T09:00"]',
      "lunch-uid",
      "standup-uid",
    ]);

    let before = server.requests.length;
    const unchanged = await caldav.fetchChanges(work, first.nextSyncState, fetchOptions(refsOf(first.upserts)));
    expect(unchanged).toEqual({ full: false, upserts: [], deletions: [], nextSyncState: first.nextSyncState });
    expect(requestsSince(before)).toEqual([]);

    server.putResource("work", "lunch.ics", singleIcs("lunch-uid", "Lunch moved"));
    const relisted = await calendarNamed(caldav, "Work");
    expect(relisted.ctag).not.toBe(work.ctag);
    before = server.requests.length;
    const changed = await caldav.fetchChanges(relisted, first.nextSyncState, fetchOptions(refsOf(first.upserts)));
    expect(changed).toMatchObject({
      full: false,
      deletions: [],
      nextSyncState: { syncToken: null, ctag: relisted.ctag },
    });
    expect(changed.upserts.map((event) => [event.remoteId, event.fields.name])).toEqual([["lunch-uid", "Lunch moved"]]);
    expect(requestsSince(before)).toEqual([
      "PROPFIND /calendars/owner/work/",
      "PROPFIND /calendars/owner/work/",
      "REPORT calendar-multiget",
    ]);
    // The task holds no Event and is stored nowhere, so it is read again with the changed resource.
    expect(multigetHrefsSince(before)).toEqual(["/calendars/owner/work/lunch.ics", "/calendars/owner/work/todo.ics"]);
  });

  describe("on a server like Purelymail: no ctag, no sync-token, no VEVENT filter without a time-range", () => {
    beforeEach(() => {
      server.behaveLikePurelymail();
      server.deleteResource("work", "todo.ics");
    });

    const SERIES_AND_LUNCH = ['["standup-uid","2026-11-25T09:00"]', "lunch-uid", "standup-uid"];

    it("lists every resource by PROPFIND and reads it by multiget, asking the server to filter nothing", async () => {
      const caldav = adapter();
      const work = await calendarNamed(caldav, "Work");
      expect(work.ctag).toBeNull();
      const before = server.requests.length;
      const first = await caldav.fetchChanges(work, null, fetchOptions());
      expect(first).toMatchObject({ full: false, deletions: [], nextSyncState: { syncToken: null, ctag: null } });
      expect(first.upserts.map((event) => event.remoteId).sort()).toEqual(SERIES_AND_LUNCH);
      expect(requestsSince(before)).toEqual([
        "PROPFIND /calendars/owner/work/",
        "PROPFIND /calendars/owner/work/",
        "REPORT calendar-multiget",
      ]);
    });

    it("reads no resource again while every ETag is unchanged", async () => {
      const caldav = adapter();
      const work = await calendarNamed(caldav, "Work");
      const first = await caldav.fetchChanges(work, null, fetchOptions());
      const before = server.requests.length;
      const again = await caldav.fetchChanges(work, first.nextSyncState, fetchOptions(refsOf(first.upserts)));
      expect(again).toEqual({ full: false, upserts: [], deletions: [], nextSyncState: first.nextSyncState });
      expect(requestsSince(before)).toEqual(["PROPFIND /calendars/owner/work/", "PROPFIND /calendars/owner/work/"]);
    });

    it.each([
      [
        "an Event created",
        () => server.putResource("work", "dinner.ics", singleIcs("dinner-uid", "Dinner")),
        { upserts: ["dinner-uid"], deletions: [], read: ["dinner.ics"] },
      ],
      [
        "an Event changed",
        () => server.putResource("work", "lunch.ics", singleIcs("lunch-uid", "Lunch moved")),
        { upserts: ["lunch-uid"], deletions: [], read: ["lunch.ics"] },
      ],
      [
        "an Event deleted",
        () => server.deleteResource("work", "lunch.ics"),
        { upserts: [], deletions: ["lunch-uid"], read: [] },
      ],
      [
        "an override removed from its series",
        () => server.putResource("work", "standup.ics", withoutLastVevent(STANDUP_ICS)),
        { upserts: ["standup-uid"], deletions: ['["standup-uid","2026-11-25T09:00"]'], read: ["standup.ics"] },
      ],
    ])("finds %s on the server and reads only that resource", async (_label, change, expected) => {
      const caldav = adapter();
      const work = await calendarNamed(caldav, "Work");
      const first = await caldav.fetchChanges(work, null, fetchOptions());
      change();
      const before = server.requests.length;
      const changes = await caldav.fetchChanges(work, first.nextSyncState, fetchOptions(refsOf(first.upserts)));
      expect(changes.full).toBe(false);
      expect(changes.upserts.map((event) => event.remoteId)).toEqual(expected.upserts);
      expect(changes.deletions).toEqual(expected.deletions);
      expect(multigetHrefsSince(before)).toEqual(expected.read.map((file) => `/calendars/owner/work/${file}`));
      expect(requestsSince(before).filter((request) => request.startsWith("GET"))).toEqual([]);
    });
  });

  it("round-trips a zoned series with an exclusion and an override unchanged in every modelled field", async () => {
    const caldav = adapter();
    const work = await calendarNamed(caldav, "Work");
    const fetched = (await caldav.fetchChanges(work, null, fetchOptions())).upserts;
    const master = eventNamed(fetched, "Standup");
    const override = eventNamed(fetched, "Standup (late)");

    const written = await caldav.putEvent(work, { ref: master, fields: master.fields }, signal());
    const afterMaster = server.resource("work", "standup.ics");
    expect(written).toEqual({ remoteId: "standup-uid", href: master.href, etag: afterMaster?.etag });
    const overrideRef = { remoteId: override.remoteId, href: override.href, etag: written.etag };
    await caldav.putEvent(work, { ref: overrideRef, fields: override.fields }, signal());

    const stored = server.resource("work", "standup.ics")?.text ?? "";
    const modelled = ["DTSTART", "DTEND", "RRULE", "EXDATE", "RECURRENCE-ID", "SUMMARY", "LOCATION", "TRIGGER"];
    expect(propertyLines(stored, modelled)).toEqual(propertyLines(STANDUP_ICS, modelled));
    expect(propertyLines(stored, ["ATTENDEE", "ORGANIZER", "X-CUSTOM-FLAG", "TZID"])).toEqual(
      propertyLines(STANDUP_ICS, ["ATTENDEE", "ORGANIZER", "X-CUSTOM-FLAG", "TZID"]),
    );

    const refetched = byRemoteId((await caldav.fetchChanges(work, null, fetchOptions())).upserts);
    expect(refetched.get(master.remoteId)?.fields).toEqual(master.fields);
    expect(refetched.get(override.remoteId)?.fields).toEqual(override.fields);
  });

  it("creates a new zoned series with its own VTIMEZONE and an override that read back as written", async () => {
    const caldav = adapter();
    const work = await calendarNamed(caldav, "Work");
    const created = await caldav.putEvent(
      work,
      { ref: null, fields: STANDUP_FIELDS, icalUid: "standup-0f4c@semprec" },
      signal(),
    );
    expect(created.remoteId).toBe("standup-0f4c@semprec");
    expect(created.href).toMatch(new RegExp(`^${work.url}[0-9a-f-]{36}\\.ics$`));
    const file = created.href?.slice(work.url?.length ?? 0) ?? "";
    expect(server.resource("work", file)?.text).toContain("BEGIN:VTIMEZONE");
    expect(server.resource("work", file)?.text).toContain("UID:standup-0f4c@semprec");
    const override = await caldav.putEvent(work, { ref: created, fields: LATE_STANDUP_FIELDS }, signal());
    expect(override.remoteId).toBe(JSON.stringify([created.remoteId, "2026-11-25T09:00"]));

    const events = byRemoteId((await caldav.fetchChanges(work, null, fetchOptions())).upserts);
    expect(events.get(created.remoteId)?.fields).toEqual(STANDUP_FIELDS);
    expect(events.get(override.remoteId)?.fields).toEqual(LATE_STANDUP_FIELDS);
  });

  it("adds a new override to its series' resource and reads single Events back", async () => {
    const caldav = adapter();
    const work = await calendarNamed(caldav, "Work");
    const series = await caldav.putEvent(work, { ref: null, fields: STANDUP_FIELDS }, signal());
    const override = await caldav.putEvent(
      work,
      { ref: null, fields: LATE_STANDUP_FIELDS, seriesRef: series },
      signal(),
    );
    expect(override).toMatchObject({
      remoteId: JSON.stringify([series.remoteId, "2026-11-25T09:00"]),
      href: series.href,
    });

    const options = { window: WINDOW, signal: signal() };
    expect((await caldav.getEvent(work, override, options))?.fields).toEqual(LATE_STANDUP_FIELDS);
    expect(await caldav.getEvent(work, { ...override, etag: null }, options)).toMatchObject({
      seriesRemoteId: series.remoteId,
    });
    await caldav.deleteEvent(work, { ...series, etag: override.etag }, signal());
    expect(await caldav.getEvent(work, series, options)).toBeNull();
  });

  it("creates with If-None-Match and reports a 412 on a write as a conflict, not a failure", async () => {
    const caldav = adapter();
    const work = await calendarNamed(caldav, "Work");
    const lunch = eventNamed((await caldav.fetchChanges(work, null, fetchOptions())).upserts, "Lunch");
    const etagBefore = server.resource("work", "lunch.ics")?.etag;

    server.refuseNextWrite = true;
    const refused = caldav.putEvent(work, { ref: lunch, fields: { ...lunch.fields, name: "Brunch" } }, signal());
    await expect(refused).rejects.toBeInstanceOf(CalendarSyncEventConflictError);
    await expect(refused).rejects.not.toBeInstanceOf(CalendarSyncProviderError);

    server.putResource("work", "lunch.ics", singleIcs("lunch-uid", "Lunch elsewhere"));
    await expect(
      caldav.putEvent(work, { ref: lunch, fields: { ...lunch.fields, name: "Brunch" } }, signal()),
    ).rejects.toBeInstanceOf(CalendarSyncEventConflictError);
    await expect(caldav.deleteEvent(work, { ...lunch, etag: etagBefore ?? null }, signal())).rejects.toBeInstanceOf(
      CalendarSyncEventConflictError,
    );
    expect(server.resource("work", "lunch.ics")?.text).toContain("SUMMARY:Lunch elsewhere");

    const created = await caldav.putEvent(work, { ref: null, fields: lunch.fields }, signal());
    server.refuseNextWrite = true;
    await expect(caldav.putEvent(work, { ref: null, fields: lunch.fields }, signal())).rejects.toBeInstanceOf(
      CalendarSyncEventConflictError,
    );
    expect(server.files("work")).toContain(created.href?.slice(work.url?.length ?? 0));
    expect(server.files("work")).toHaveLength(4);
  });

  it("names a local Event's resource after it, so a repeated create writes onto the first one's resource", async () => {
    const caldav = adapter();
    const work = await calendarNamed(caldav, "Work");
    const lunch = eventNamed((await caldav.fetchChanges(work, null, fetchOptions())).upserts, "Lunch");
    const createKey = randomUUID();
    const before = server.files("work").length;

    const created = await caldav.putEvent(work, { ref: null, fields: lunch.fields, createKey }, signal());
    // Its answer lost, the create is repeated with the fields changed here meanwhile.
    const repeated = await caldav.putEvent(
      work,
      { ref: null, fields: { ...lunch.fields, name: "Brunch" }, createKey },
      signal(),
    );
    expect(repeated).toEqual({ remoteId: created.remoteId, href: created.href, etag: expect.any(String) });
    expect(repeated.etag).not.toBe(created.etag);
    expect(server.files("work")).toHaveLength(before + 1);
    const name = created.href?.slice(work.url?.length ?? 0) ?? "";
    expect(server.resource("work", name)?.text).toContain("SUMMARY:Brunch");

    const other = await caldav.putEvent(work, { ref: null, fields: lunch.fields, createKey: randomUUID() }, signal());
    expect(other.href).not.toBe(created.href);
    expect(other.remoteId).not.toBe(created.remoteId);
  });

  it("deletes a single Event with If-Match and cancels one occurrence inside its series", async () => {
    const caldav = adapter();
    const work = await calendarNamed(caldav, "Work");
    const events = (await caldav.fetchChanges(work, null, fetchOptions())).upserts;
    await caldav.deleteEvent(work, eventNamed(events, "Lunch"), signal());
    expect(server.resource("work", "lunch.ics")).toBeUndefined();

    await caldav.deleteEvent(work, eventNamed(events, "Standup (late)"), signal());
    const after = byRemoteId((await caldav.fetchChanges(work, null, fetchOptions())).upserts);
    expect([...after.keys()]).toEqual(["standup-uid"]);
    expect(after.get("standup-uid")?.fields.exceptionDates).toEqual(["2026-11-25T09:00", "2026-12-02T09:00"]);
  });

  it("answers an invitation by writing the account attendee's PARTSTAT, conditional on the etag", async () => {
    const caldav = adapter();
    const work = await calendarNamed(caldav, "Work");
    const events = (await caldav.fetchChanges(work, null, fetchOptions())).upserts;
    const standup = eventNamed(events, "Standup");
    const etagBefore = server.resource("work", "standup.ics")?.etag;
    const answer = { response: "declined", attendeeEmails: ["OWNER@example.test"] } as const;

    expect(await caldav.respondToInvitation(work, standup, answer, signal())).toBe("answered");

    // Unfolded: iCalendar folds lines longer than 75 octets.
    const text = (server.resource("work", "standup.ics")?.text ?? "").replaceAll("\r\n ", "");
    expect(text).toMatch(/ATTENDEE;CN=Owner;ROLE=REQ-PARTICIPANT;PARTSTAT=DECLINED:mailto:owner@example.test/);
    expect(text).toContain("ORGANIZER;CN=Boss:mailto:boss@example.test");
    expect(server.resource("work", "standup.ics")?.etag).not.toBe(etagBefore);
    const reread = await caldav.getEvent(work, { ...standup, etag: null }, { window: WINDOW, signal: signal() });
    expect(reread?.attendees).toEqual([
      { email: "owner@example.test", name: "Owner", role: "REQ-PARTICIPANT", status: "DECLINED" },
    ]);

    const lunch = eventNamed(events, "Lunch");
    await expect(
      caldav.respondToInvitation(
        work,
        lunch,
        { response: "accepted", attendeeEmails: ["owner@example.test"] },
        signal(),
      ),
    ).rejects.toBeInstanceOf(CalendarSyncWriteUnsupportedError);
    server.refuseNextWrite = true;
    await expect(caldav.respondToInvitation(work, standup, answer, signal())).rejects.toBeInstanceOf(
      CalendarSyncEventConflictError,
    );
    await caldav.deleteEvent(work, lunch, signal());
    expect(await caldav.respondToInvitation(work, lunch, { response: "accepted", attendeeEmails: [] }, signal())).toBe(
      "gone",
    );
  });

  describe("an edit of a resource that holds a value ical.js cannot read", () => {
    const UNREADABLE_STANDUP_ICS = STANDUP_ICS.replace(
      "DTEND;TZID=Europe/Prague:20261118T091500",
      "DTEND;TZID=Europe/Prague:garbage",
    );

    it.each<[string, (caldav: CalendarSyncAdapter, work: RemoteCalendar, ref: RemoteEventRef) => Promise<unknown>]>([
      ["an update", (caldav, work, ref) => caldav.putEvent(work, { ref, fields: STANDUP_FIELDS }, signal())],
      [
        "an invitation answer",
        (caldav, work, ref) =>
          caldav.respondToInvitation(work, ref, { response: "accepted", attendeeEmails: [LOGIN.username] }, signal()),
      ],
      [
        "an occurrence's cancellation",
        (caldav, work, ref) =>
          caldav.deleteEvent(work, { ...ref, remoteId: JSON.stringify(["standup-uid", "2026-11-25T09:00"]) }, signal()),
      ],
    ])("fails %s as an unreadable resource and writes nothing", async (_case, edit) => {
      const caldav = adapter();
      const work = await calendarNamed(caldav, "Work");
      // Changed at the server after the last sync stored the Event.
      const etag = server.putResource("work", "standup.ics", UNREADABLE_STANDUP_ICS);
      const ref = { remoteId: "standup-uid", href: `${server.origin}${server.calendarPath("work")}standup.ics`, etag };
      const requestsBefore = server.requests.length;

      const error = await edit(caldav, work, ref).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(CalendarSyncProviderError);
      expect(error).toMatchObject({ code: "invalidResponse", message: "The CalDAV resource is unreadable" });
      expect(requestsSince(requestsBefore)).toEqual([`GET ${server.calendarPath("work")}standup.ics`]);
      expect(server.resource("work", "standup.ics")).toEqual({ text: UNREADABLE_STANDUP_ICS, etag });
    });
  });

  it("answers a refused login as needing reauthorization", async () => {
    const caldav = adapter({ credential: "wrong" });
    await expect(caldav.listCalendars(signal())).rejects.toBeInstanceOf(CalendarSyncReauthorizationRequiredError);
    await expect(
      verifyCalDavServer(
        { caldavUrl: `${server.origin}/.well-known/caldav`, username: LOGIN.username, password: "wrong" },
        { policy: LOOPBACK_LITERAL_POLICY },
      ),
    ).rejects.toBeInstanceOf(CalDavAuthFailedError);
  });

  it("answers an address the policy refuses and an unreachable server with the same error", async () => {
    const closed = await listen(() => undefined);
    await closeServer(closed.server);
    const outcomes = await Promise.all(
      ["http://10.0.0.1/.well-known/caldav", `http://127.0.0.1:${closed.port}/.well-known/caldav`].map(async (url) => {
        const sync = await adapter({}, url)
          .listCalendars(signal())
          .then(
            () => null,
            (error: unknown) => error,
          );
        const connect = await verifyCalDavServer(
          { caldavUrl: url, ...LOGIN },
          { policy: LOOPBACK_LITERAL_POLICY },
        ).then(
          () => null,
          (error: unknown) => error,
        );
        return { sync, connect };
      }),
    );
    for (const { sync, connect } of outcomes) {
      expect(sync).toBeInstanceOf(CalendarSyncProviderError);
      expect(sync).toMatchObject({ code: "providerUnavailable", message: "The CalDAV server could not be reached" });
      expect(connect).toBeInstanceOf(CalDavServerUnreachableError);
    }
    const [refused, unreachable] = outcomes;
    expect(refused?.sync).toEqual(unreachable?.sync);
    expect(refused?.connect).toEqual(unreachable?.connect);
  });

  it("does not follow a redirect off the account's server, so tsdav never fetches by itself", async () => {
    let hits = 0;
    const target = await listen(() => {
      hits += 1;
    });
    try {
      server.redirects.set("/start/", `http://localhost:${target.port}/`);
      await expect(adapter({}, `${server.origin}/start/`).listCalendars(signal())).rejects.toMatchObject({
        code: "invalidResponse",
      });
      expect(hits).toBe(0);
      expect(server.requests.map((request) => request.path)).toEqual(["/start/"]);
    } finally {
      await closeServer(target.server);
    }
  });

  it("follows at most three redirects", async () => {
    server.redirects.set("/a/", "/b/");
    server.redirects.set("/b/", "/c/");
    server.redirects.set("/c/", "/d/");
    server.redirects.set("/d/", "/");
    await expect(adapter({}, `${server.origin}/a/`).listCalendars(signal())).rejects.toMatchObject({
      code: "invalidResponse",
    });
    server.redirects.delete("/a/");
    await expect(adapter({}, `${server.origin}/b/`).listCalendars(signal())).resolves.toHaveLength(2);
  });

  describe("the login stays with the account's server", () => {
    let other: FakeCalDavServer;

    beforeEach(async () => {
      // Another server that would accept the same login, as one that collects it would.
      other = new FakeCalDavServer(LOGIN);
      await other.start();
      other.addCalendar("work", { displayName: "Elsewhere", color: null, privileges: ["all"], components: [] });
    });

    afterEach(async () => {
      await other.close();
    });

    it("refuses a redirect to another origin before any request reaches it", async () => {
      server.redirects.set("/start/", `${other.origin}/`);
      await expect(adapter({}, `${server.origin}/start/`).listCalendars(signal())).rejects.toMatchObject({
        code: "invalidResponse",
      });
      await expect(
        verifyCalDavServer({ caldavUrl: `${server.origin}/start/`, ...LOGIN }, { policy: LOOPBACK_LITERAL_POLICY }),
      ).rejects.toBeInstanceOf(CalDavServerInvalidError);
      expect(other.requests).toEqual([]);
    });

    it("refuses a calendar home another origin serves and never requests it", async () => {
      server.calendarHomeOrigin = other.origin;
      await expect(adapter().listCalendars(signal())).rejects.toMatchObject({ code: "invalidResponse" });
      expect(other.requests).toEqual([]);
    });

    it("sends the login on every request to its own server", async () => {
      const caldav = adapter();
      const work = await calendarNamed(caldav, "Work");
      await caldav.fetchChanges(work, null, fetchOptions());
      // The well-known address answers its redirect before it asks for a login.
      expect(server.requests.filter((request) => request.path !== "/.well-known/caldav").length).toBeGreaterThan(3);
      expect(
        server.requests.filter((request) => request.path !== "/.well-known/caldav" && !request.withAuthorization),
      ).toEqual([]);
    });
  });

  it.each<[string, string, string, boolean]>([
    ["the start's own origin", "https://dav.example.test/.well-known/caldav", "https://dav.example.test/cal/", true],
    ["another port of the start's host", "https://dav.example.test/", "https://dav.example.test:8443/cal/", false],
    ["another host of a generic start", "https://dav.example.test/", "https://caldav.icloud.com/", false],
    ["iCloud's per-account host", "https://caldav.icloud.com/", "https://p42-caldav.icloud.com/123/principal/", true],
    ["a look-alike of iCloud", "https://caldav.icloud.com/", "https://p42-caldav.icloud.com.example.test/", false],
    ["iCloud over plain http", "https://caldav.icloud.com/", "http://p42-caldav.icloud.com/", false],
    ["iCloud on another port", "https://caldav.icloud.com/", "https://p42-caldav.icloud.com:8443/", false],
    ["an iCloud host from a generic start", "https://dav.example.test/", "https://p42-caldav.icloud.com/", false],
  ])("scopes the login: %s", (_case, start, target, allowed) => {
    expect(caldavCredentialScope(new URL(start)).allows(new URL(target))).toBe(allowed);
  });
});

describe("a calendar sync pass with the CalDAV adapter", () => {
  let admin: Pool;
  let runtime: Pool;
  let tenant: string;

  function inTenant<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runInTenant(tenant, () => withTransaction(runtime, fn));
  }

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await createUser(admin, {
      tenantId: tenant,
      email: "caldav-owner@example.test",
      passwordHash: "unused",
      locale: "en",
    });
    await runInTenant(tenant, () => seedSystem(runtime));
  });

  afterAll(async () => {
    await runtime.end();
  });

  const storedCaldavUrl = "https://caldav.example.test/dav/";

  async function calendarSyncIds(): Promise<CalendarSyncIds> {
    const ids = await inTenant((client) => resolveCalendarSyncIds(client));
    if (ids === null) throw new Error("no calendar databases");
    return ids;
  }

  /** A generic password account with Calendars on, whose stored CalDAV address is `storedCaldavUrl`. */
  async function createPasswordAccount(ids: CalendarSyncIds, name: string): Promise<string> {
    return inTenant(async (client) => {
      const mailbox = await createChokePoint(runtime).createItem({
        databaseId: ids.mailboxesDatabaseId,
        properties: { name, provider: "generic", mailEnabled: true, calendarsEnabled: true },
      });
      const { mailboxesDatabaseId } = ids;
      await writeMailboxAddresses(client, { mailboxesDatabaseId, mailboxItemId: mailbox.id, address: LOGIN.username });
      await storeCredential(client, {
        itemId: mailbox.id,
        credentialType: "plain_password",
        plaintext: LOGIN.password,
      });
      await upsertMailServerSettings(client, mailbox.id, {
        imap: { host: "imap.example.test", port: 993, security: "tls" },
        smtp: { host: "smtp.example.test", port: 465, security: "tls" },
        username: LOGIN.username,
        caldavUrl: storedCaldavUrl,
      });
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" });
      return mailbox.id;
    });
  }

  /** The stored address is https on a public name; the test server is the same login on loopback. */
  function loopbackCalDav(given: CalendarSyncAccount): CalendarSyncAdapter {
    return createCalDavAdapter(
      { ...given, serverSettings: { username: LOGIN.username, caldavUrl: `${server.origin}/` } },
      { policy: LOOPBACK_LITERAL_POLICY },
    );
  }

  it("reads the account's login and CalDAV address and syncs the calendars and Events", async () => {
    const ids = await calendarSyncIds();
    const accountId = await createPasswordAccount(ids, "Fastmail");

    const seen: CalendarSyncAccount[] = [];
    const result = await runInTenant(tenant, () =>
      handleCalendarAccountSyncTask(
        runtime,
        { accountItemId: accountId },
        {
          adapters: {
            imap: (given) => {
              seen.push(given);
              return loopbackCalDav(given);
            },
          },
        },
      ),
    );
    expect(seen.map((given) => given.serverSettings)).toEqual([
      { username: LOGIN.username, caldavUrl: storedCaldavUrl },
    ]);
    expect(seen[0]?.credential).toBe(LOGIN.password);
    expect(result).toMatchObject({ kind: "applied", skippedEvents: 0 });
    expect(result?.kind === "applied" ? result.added.length : 0).toBe(4);

    const rows = await inTenant(async (client) => {
      const { rows: items } = await client.query<Record<string, unknown>>(
        `SELECT i.properties->>'name' AS name, i.properties->>'remoteName' AS remote_name,
                i.properties->>'recurrenceRule' AS rule, i.properties->>'timeZone' AS zone
           FROM items i
          WHERE i.deleted_at IS NULL
            AND ((i.database_id = $1 AND i.properties->>'kind' = 'account') OR i.database_id = $2)
          ORDER BY 1, 2`,
        [ids.calendarsDatabaseId, ids.eventsDatabaseId],
      );
      return z
        .array(
          z.object({
            name: z.string().nullable(),
            remote_name: z.string().nullable(),
            rule: z.string().nullable(),
            zone: z.string().nullable(),
          }),
        )
        .parse(items);
    });
    expect(rows).toEqual([
      { name: "Lunch", remote_name: null, rule: null, zone: "UTC" },
      { name: "New Year", remote_name: null, rule: null, zone: null },
      { name: "Standup", remote_name: null, rule: "FREQ=WEEKLY;COUNT=10;BYDAY=WE", zone: "Europe/Prague" },
      { name: "Standup (late)", remote_name: null, rule: null, zone: "Europe/Prague" },
      { name: null, remote_name: "Holidays", rule: null, zone: null },
      { name: null, remote_name: "Work", rule: null, zone: null },
    ]);
  });

  it("applies Events created and deleted on a server like Purelymail, and reads nothing again when none changed", async () => {
    server.behaveLikePurelymail();
    server.deleteResource("work", "todo.ics");
    const ids = await calendarSyncIds();
    const accountId = await createPasswordAccount(ids, "Purelymail");
    const pass = () =>
      runInTenant(tenant, () =>
        handleCalendarAccountSyncTask(runtime, { accountItemId: accountId }, { adapters: { imap: loopbackCalDav } }),
      );
    const remoteIdsOf = (events: ReadonlyArray<{ remoteId: string }> | undefined) =>
      (events ?? []).map((event) => event.remoteId).sort();

    const first = await pass();
    expect(first?.kind === "applied" ? remoteIdsOf(first.added) : null).toEqual([
      '["standup-uid","2026-11-25T09:00"]',
      "lunch-uid",
      "new-year-uid",
      "standup-uid",
    ]);
    const lunch = await inTenant(async (client) => {
      const calendars = await listSyncedAccountCalendars(client, ids, accountId);
      const work = calendars.find((calendar) => calendar.remoteId === "/calendars/owner/work/");
      if (!work) throw new Error("no Work calendar");
      expect(work).toMatchObject({ syncToken: null, ctag: null });
      return (await listEventRemoteStates(client, work.calendarItemId)).find((event) => event.remoteId === "lunch-uid");
    });
    if (!lunch) throw new Error("no remote state of lunch");

    server.putResource("work", "dinner.ics", singleIcs("dinner-uid", "Dinner"));
    server.deleteResource("work", "lunch.ics");
    const second = await pass();
    expect(second).toMatchObject({ kind: "applied", changed: [] });
    expect(second?.kind === "applied" ? remoteIdsOf(second.added) : null).toEqual(["dinner-uid"]);
    expect(second?.kind === "applied" ? remoteIdsOf(second.cancelled) : null).toEqual(["lunch-uid"]);
    const lunchItem = await inTenant((client) => getItemById(client, ids.eventsDatabaseId, lunch.eventItemId));
    expect(lunchItem?.deletedAt ?? null).not.toBeNull();

    const before = server.requests.length;
    const third = await pass();
    expect(third).toMatchObject({ kind: "applied", added: [], changed: [], cancelled: [] });
    expect(server.requests.slice(before).filter((request) => request.method !== "PROPFIND")).toEqual([]);
  });
});
