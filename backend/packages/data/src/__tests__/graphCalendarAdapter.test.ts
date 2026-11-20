// The Microsoft Graph calendar adapter against recorded Graph responses (`fixtures/graphCalendar/`) served by an
// injected fetch, and once through the production registry and a real sync pass on Postgres.
import "../domainWriteHooks.js";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createUser } from "../auth/usersStore.js";
import {
  CalendarSyncConsentRequiredError,
  CalendarSyncEventConflictError,
  CalendarSyncProviderError,
  CalendarSyncReauthorizationRequiredError,
  type CalendarSyncWindow,
  type RemoteCalendar,
  type RemoteEventFields,
} from "../calendar/sync/adapter.js";
import {
  GraphCalendarAdapter,
  setGraphCalendarSyncRuntime,
} from "../calendar/sync/adapters/graph/graphCalendarAdapter.js";
import { GraphCalendarRequestError } from "../calendar/sync/adapters/graph/graphCalendarHttp.js";
import {
  GraphCalendarWriteUnsupportedError,
  graphRecurrenceOfRrule,
  rruleOfGraphRecurrence,
  type GraphRecurrence,
} from "../calendar/sync/adapters/graph/graphRecurrence.js";
import { graphZoneOfIanaZone, ianaZoneOfGraphZone } from "../calendar/sync/adapters/graph/graphTimeZones.js";
import { handleCalendarAccountSyncTask } from "../calendar/sync/calendarAccountSyncJob.js";
import { resolveCalendarSyncIds, type CalendarSyncIds } from "../calendar/sync/calendarSyncStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getDecryptedCredential, storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { ensureMailAccountSyncState, recordGrantedOauthScopes } from "../mail/mailAccountSyncStateStore.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { MICROSOFT_TOKEN_URL } from "../mail/oauthTokenExchange.js";
import { seedSystem } from "../seed/seedSystem.js";
import { remoteFields } from "../testSupport/fakeCalendarSyncAdapter.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const WINDOW: CalendarSyncWindow = { start: "2026-11-01", end: "2026-12-31" };
const WORK: RemoteCalendar = {
  remoteId: "AAMkCal-work",
  url: null,
  name: "Calendar",
  color: "#3A87AD",
  readOnly: false,
  ctag: null,
};

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/graphCalendar/${name}.json`, import.meta.url), "utf8"));
}

interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

type Route = (url: URL, recorded: Recorded) => Response | Promise<Response>;

/**
 * A Graph stand-in: routes are `METHOD /path` (below `/v1.0`) to a handler. Every request is recorded; one with no
 * route fails the test through a 599 the adapter cannot mistake for a Graph answer.
 */
class FakeGraph {
  readonly requests: Recorded[] = [];
  readonly routes = new Map<string, Route>();

  constructor(routes: Record<string, Route> = {}) {
    for (const [key, route] of Object.entries(routes)) this.routes.set(key, route);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const recorded: Recorded = {
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : (init?.body ?? null),
    };
    this.requests.push(recorded);
    if (url.href === MICROSOFT_TOKEN_URL) {
      return Response.json({ access_token: "graph-access", expires_in: 3600, refresh_token: "rotated-refresh" });
    }
    const route = this.routes.get(`${recorded.method} ${url.pathname.replace(/^\/v1\.0/, "")}`);
    if (!route || url.host !== "graph.microsoft.com") return new Response(null, { status: 599 });
    return route(url, recorded);
  };

  graphRequests(): Recorded[] {
    return this.requests.filter((request) => request.url.host === "graph.microsoft.com");
  }
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers });
}

/** The work calendar's recorded delta: two pages for a new round, then `token-1` → changes, `token-2` → a removal. */
function workRoutes(): Record<string, Route> {
  return {
    "GET /me/calendars": () => json(fixture("calendars")),
    "GET /me/calendars/AAMkCal-work/calendarView/delta": (url) => {
      const deltaToken = url.searchParams.get("$deltatoken");
      if (deltaToken === "token-1") return json(fixture("deltaIncremental"));
      if (deltaToken === "token-2") return json(fixture("deltaRemoved"));
      if (deltaToken === "expired") return json(fixture("syncStateNotFound"), 410);
      if (url.searchParams.get("$skiptoken") === "page-2") return json(fixture("deltaInitialPage2"));
      return json(fixture("deltaInitialPage1"));
    },
    "GET /me/calendars/AAMkCal-holidays/calendarView/delta": () => json(fixture("holidaysDelta")),
    "GET /me/events/AAMkSeries-standup": () => json(fixture("standupMaster")),
    "GET /me/events/AAMkSeries-standup/instances": () => json(fixture("standupInstances")),
  };
}

function adapterOn(graph: FakeGraph): GraphCalendarAdapter {
  return new GraphCalendarAdapter({
    getAccessToken: async () => "graph-access",
    tenantTimeZone: "Europe/Prague",
    fetchImpl: graph.fetch,
  });
}

const signal = () => AbortSignal.timeout(60_000);

function cursorFor(deltaLink: string, window = WINDOW) {
  return { syncToken: JSON.stringify({ v: 1, start: window.start, end: window.end, deltaLink }), ctag: null };
}

const STANDUP_RULE = "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261130T225959Z";

describe("Microsoft Graph calendar adapter", () => {
  describe("calendars", () => {
    it("lists name, colour and a calendar without canEdit as read-only", async () => {
      const graph = new FakeGraph(workRoutes());
      expect(await adapterOn(graph).listCalendars(signal())).toEqual([
        { remoteId: "AAMkCal-work", url: null, name: "Calendar", color: "#3A87AD", readOnly: false, ctag: null },
        {
          remoteId: "AAMkCal-holidays",
          url: null,
          name: "Czech holidays",
          color: "#70AD47",
          readOnly: true,
          ctag: null,
        },
      ]);
      const [request] = graph.graphRequests();
      expect(request?.headers.get("authorization")).toBe("Bearer graph-access");
      expect(request?.headers.get("prefer")).toContain('outlook.timezone="UTC"');
    });
  });

  describe("a full fetch", () => {
    it("maps singles, the series master with its RRULE and exception dates, and its override", async () => {
      const graph = new FakeGraph(workRoutes());
      const changes = await adapterOn(graph).fetchChanges(WORK, null, { window: WINDOW, signal: signal() });

      expect(changes.full).toBe(true);
      expect(changes.deletions).toEqual([]);
      const byId = new Map(changes.upserts.map((event) => [event.remoteId, event]));
      expect([...byId.keys()].sort()).toEqual(
        [
          "AAMkEv-call",
          "AAMkEv-christmas",
          "AAMkEv-party",
          "AAMkEv-review",
          "AAMkEv-trip",
          "AAMkSeries-standup",
          "AAMkSeries-standup-exc-1104",
        ].sort(),
      );

      expect(byId.get("AAMkEv-review")).toEqual({
        remoteId: "AAMkEv-review",
        href: null,
        etag: 'W/"ZlnW4RIAV06KYYwlrfNZvQAAAAAHAQ=="',
        seriesRemoteId: null,
        fields: remoteFields({
          name: "Quarterly review",
          date: "2026-11-20",
          timeFrom: "14:00",
          timeTo: "15:30",
          timeZone: "Europe/Prague",
          place: "Room 4",
          description: "Agenda attached",
          url: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc",
          alertMinutes: 15,
        }),
        organizer: { email: "me@example.test", name: "Me", role: null, status: null },
        attendees: [
          { email: "alex@example.test", name: "Alex Doe", role: "required", status: "tentativelyAccepted" },
          { email: "sam@example.test", name: "Sam Roe", role: "optional", status: "none" },
        ],
      });

      // A removed occurrence (16 Nov, no instance) and a cancelled one (18 Nov) are exceptions of the series.
      expect(byId.get("AAMkSeries-standup")?.fields).toEqual(
        remoteFields({
          name: "Standup",
          date: "2026-11-02",
          timeFrom: "09:00",
          timeTo: "09:15",
          timeZone: "Europe/Prague",
          recurrenceRule: STANDUP_RULE,
          exceptionDates: ["2026-11-16T09:00", "2026-11-18T09:00"],
          place: "Room 2",
          description: "Daily sync",
          alertMinutes: 5,
        }),
      );
      expect(byId.get("AAMkSeries-standup-exc-1104")).toMatchObject({
        seriesRemoteId: "AAMkSeries-standup",
        fields: { name: "Standup (moved)", date: "2026-11-04", timeFrom: "10:00", recurrenceId: "2026-11-04T09:00" },
      });
    });

    it.each([
      ["an unconverted all-day span", "AAMkEv-trip", { date: "2026-12-10", endDate: "2026-12-12" }],
      ["an all-day day converted to UTC", "AAMkEv-christmas", { date: "2026-12-24", endDate: null }],
      ["a timed Event ending at midnight", "AAMkEv-party", { date: "2026-11-27", timeFrom: "21:00", timeTo: "24:00" }],
      ["an unknown zone kept in UTC", "AAMkEv-call", { timeZone: "Etc/UTC", timeFrom: "16:00", timeTo: "16:30" }],
    ])("maps %s", async (_case, remoteId, expected) => {
      const graph = new FakeGraph(workRoutes());
      const changes = await adapterOn(graph).fetchChanges(WORK, null, { window: WINDOW, signal: signal() });
      expect(changes.upserts.find((event) => event.remoteId === remoteId)?.fields).toMatchObject(expected);
    });

    it("asks the window a day wider in UTC, follows nextLink and stores the deltaLink with its window", async () => {
      const graph = new FakeGraph(workRoutes());
      const changes = await adapterOn(graph).fetchChanges(WORK, null, { window: WINDOW, signal: signal() });

      const first = graph.graphRequests().find((request) => request.url.pathname.endsWith("/calendarView/delta"));
      expect(first?.url.searchParams.get("startDateTime")).toBe("2026-10-31T00:00:00Z");
      expect(first?.url.searchParams.get("endDateTime")).toBe("2027-01-02T00:00:00Z");
      expect(first?.headers.get("prefer")).toContain("odata.maxpagesize=100");
      expect(JSON.parse(changes.nextSyncState.syncToken ?? "")).toEqual({
        v: 1,
        start: WINDOW.start,
        end: WINDOW.end,
        deltaLink: `${GRAPH}/me/calendars/AAMkCal-work/calendarView/delta?$deltatoken=token-1`,
      });
    });
  });

  describe("an incremental fetch", () => {
    it("follows the stored deltaLink and sends the changed series whole", async () => {
      const graph = new FakeGraph(workRoutes());
      const changes = await adapterOn(graph).fetchChanges(
        WORK,
        cursorFor(`${GRAPH}/me/calendars/AAMkCal-work/calendarView/delta?$deltatoken=token-1`),
        { window: WINDOW, signal: signal() },
      );
      expect(changes.full).toBe(false);
      expect(changes.upserts.map((event) => event.remoteId).sort()).toEqual(
        ["AAMkEv-review", "AAMkSeries-standup", "AAMkSeries-standup-exc-1104"].sort(),
      );
      expect(changes.upserts.find((event) => event.remoteId === "AAMkEv-review")?.fields.date).toBe("2026-11-21");
      expect(changes.deletions).toEqual(["AAMkSeries-standup-occ-1130"]);
      expect(JSON.parse(changes.nextSyncState.syncToken ?? "").deltaLink).toContain("$deltatoken=token-2");
    });

    it.each([
      [
        "a removal, which names no series",
        cursorFor(`${GRAPH}/me/calendars/AAMkCal-work/calendarView/delta?$deltatoken=token-2`),
      ],
      [
        "an expired sync state (410)",
        cursorFor(`${GRAPH}/me/calendars/AAMkCal-work/calendarView/delta?$deltatoken=expired`),
      ],
      [
        "a cursor of an earlier window",
        cursorFor(`${GRAPH}/me/calendars/AAMkCal-work/calendarView/delta?$deltatoken=token-1`, {
          start: "2026-10-31",
          end: "2026-12-30",
        }),
      ],
      ["a cursor this adapter did not write", { syncToken: "opaque", ctag: null }],
      ["a cursor for another host", cursorFor("https://evil.example.test/v1.0/delta")],
    ])("resyncs the window in full after %s", async (_case, cursor) => {
      const graph = new FakeGraph(workRoutes());
      const changes = await adapterOn(graph).fetchChanges(WORK, cursor, { window: WINDOW, signal: signal() });
      expect(changes.full).toBe(true);
      expect(changes.upserts.find((event) => event.remoteId === "AAMkSeries-standup")?.fields.exceptionDates).toEqual([
        "2026-11-16T09:00",
        "2026-11-18T09:00",
      ]);
      expect(graph.requests.every((request) => request.url.host === "graph.microsoft.com")).toBe(true);
    });
  });

  describe("recurrence", () => {
    const series = { start: "2026-11-02", allDay: false, zone: "Europe/Prague" };
    const graphSeries = { startDate: "2026-11-02", zone: "Europe/Prague", graphZone: "Central Europe Standard Time" };

    it("maps every 2 weeks on Mon and Wed until a date to the RRULE and back", () => {
      const recurrence: GraphRecurrence = {
        pattern: { type: "weekly", interval: 2, daysOfWeek: ["wednesday", "monday"], firstDayOfWeek: "sunday" },
        range: {
          type: "endDate",
          startDate: "2026-11-02",
          endDate: "2026-11-30",
          recurrenceTimeZone: "Central Europe Standard Time",
        },
      };
      const rule = rruleOfGraphRecurrence(recurrence, series);
      expect(rule).toBe(STANDUP_RULE);
      expect(graphRecurrenceOfRrule(rule!, graphSeries)).toEqual({
        pattern: { type: "weekly", interval: 2, daysOfWeek: ["monday", "wednesday"], firstDayOfWeek: "monday" },
        range: {
          type: "endDate",
          startDate: "2026-11-02",
          endDate: "2026-11-30",
          recurrenceTimeZone: "Central Europe Standard Time",
        },
      });
    });

    it.each<[string, GraphRecurrence["pattern"], GraphRecurrence["range"]["type"], string]>([
      ["daily, every 3 days, 10 times", { type: "daily", interval: 3 }, "numbered", "FREQ=DAILY;INTERVAL=3;COUNT=10"],
      [
        "monthly on the 15th",
        { type: "absoluteMonthly", interval: 1, dayOfMonth: 15 },
        "noEnd",
        "FREQ=MONTHLY;BYMONTHDAY=15",
      ],
      [
        "monthly on the last Friday",
        { type: "relativeMonthly", interval: 1, daysOfWeek: ["friday"], index: "last" },
        "noEnd",
        "FREQ=MONTHLY;BYDAY=-1FR",
      ],
      [
        "every 2 months on the first weekday",
        {
          type: "relativeMonthly",
          interval: 2,
          daysOfWeek: ["monday", "tuesday", "wednesday", "thursday", "friday"],
          index: "first",
        },
        "noEnd",
        "FREQ=MONTHLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1",
      ],
      [
        "yearly on 2 November",
        { type: "absoluteYearly", interval: 1, month: 11, dayOfMonth: 2 },
        "noEnd",
        "FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=2",
      ],
      [
        "yearly on the second Tuesday of March",
        { type: "relativeYearly", interval: 1, month: 3, daysOfWeek: ["tuesday"], index: "second" },
        "numbered",
        "FREQ=YEARLY;BYMONTH=3;BYDAY=2TU;COUNT=10",
      ],
    ])("maps %s both ways", (_case, pattern, rangeType, expected) => {
      const range: GraphRecurrence["range"] =
        rangeType === "numbered"
          ? {
              type: "numbered",
              startDate: "2026-11-02",
              numberOfOccurrences: 10,
              recurrenceTimeZone: "Central Europe Standard Time",
            }
          : { type: "noEnd", startDate: "2026-11-02", recurrenceTimeZone: "Central Europe Standard Time" };
      expect(rruleOfGraphRecurrence({ pattern, range }, series)).toBe(expected);
      const back = graphRecurrenceOfRrule(expected, graphSeries);
      expect(back.range).toEqual(range);
      expect(back.pattern).toMatchObject({ ...pattern, interval: pattern.interval ?? 1 });
    });

    it("writes WKST only when the week start changes the days, and an all-day UNTIL as a day", () => {
      const sundayAndMonday: GraphRecurrence = {
        pattern: { type: "weekly", interval: 2, daysOfWeek: ["sunday", "monday"], firstDayOfWeek: "sunday" },
        range: { type: "noEnd", startDate: "2026-11-01" },
      };
      expect(rruleOfGraphRecurrence(sundayAndMonday, { ...series, start: "2026-11-01" })).toBe(
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;WKST=SU",
      );
      expect(
        graphRecurrenceOfRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;WKST=SU", graphSeries).pattern.firstDayOfWeek,
      ).toBe("sunday");
      const allDay: GraphRecurrence = {
        pattern: { type: "daily", interval: 1 },
        range: { type: "endDate", startDate: "2026-11-02", endDate: "2026-11-09" },
      };
      expect(rruleOfGraphRecurrence(allDay, { ...series, allDay: true })).toBe("FREQ=DAILY;UNTIL=20261109");
    });

    it.each(["FREQ=DAILY;BYHOUR=9", "FREQ=MONTHLY;BYMONTHDAY=1,15", "FREQ=MONTHLY;BYDAY=5MO", "FREQ=SECONDLY"])(
      "refuses %s, which no Graph pattern expresses",
      (rule) => {
        expect(() => graphRecurrenceOfRrule(rule, graphSeries)).toThrow(GraphCalendarWriteUnsupportedError);
      },
    );
  });

  describe("zones", () => {
    it.each([
      ["Central Europe Standard Time", "Europe/Budapest"],
      ["Pacific Standard Time", "America/Los_Angeles"],
      ["UTC", "Etc/UTC"],
      ["Europe/Prague", "Europe/Prague"],
      ["Customized Time Zone", null],
      ["tzone://Microsoft/Custom", null],
      ["", null],
    ])("reads %s as %s", (graphZone, iana) => {
      expect(ianaZoneOfGraphZone(graphZone)).toBe(iana);
    });

    it.each([
      ["Central Europe Standard Time", "Europe/Prague", "Europe/Prague"],
      ["Central Europe Standard Time", "Europe/Vienna", "Europe/Budapest"],
      ["W. Europe Standard Time", "Europe/Vienna", "Europe/Vienna"],
      ["Eastern Standard Time", "Europe/Prague", "America/New_York"],
      ["America/Chicago", "Europe/Prague", "America/Chicago"],
    ])("reads %s for a tenant in %s as %s", (graphZone, tenantZone, iana) => {
      expect(ianaZoneOfGraphZone(graphZone, tenantZone)).toBe(iana);
    });

    it.each([
      ["Europe/Prague", "Central Europe Standard Time"],
      ["Etc/GMT+2", "UTC-02"],
      ["Antarctica/Troll", "Antarctica/Troll"],
    ])("writes %s as %s", (iana, graphZone) => {
      expect(graphZoneOfIanaZone(iana)).toBe(graphZone);
    });
  });

  describe("writes", () => {
    const fields: RemoteEventFields = remoteFields({
      name: "Planning",
      date: "2026-11-23",
      timeFrom: "10:00",
      timeTo: "11:00",
      timeZone: "Europe/Prague",
      place: "Room 1",
      description: "Bring numbers",
      alertMinutes: 10,
    });
    const saved = (id: string, etag: string) => json({ id, "@odata.etag": etag, type: "singleInstance" });

    it("creates in the calendar with a transactionId that a retried create repeats", async () => {
      const graph = new FakeGraph({
        "POST /me/calendars/AAMkCal-work/events": () => saved("AAMkEv-new", 'W/"n1"'),
      });
      const adapter = adapterOn(graph);
      expect(await adapter.putEvent(WORK, { ref: null, fields }, signal())).toEqual({
        remoteId: "AAMkEv-new",
        href: null,
        etag: 'W/"n1"',
      });
      await adapter.putEvent(WORK, { ref: null, fields }, signal());
      const [first, second] = graph.graphRequests();
      expect(first?.body).toEqual({
        subject: "Planning",
        body: { contentType: "text", content: "Bring numbers" },
        location: { displayName: "Room 1" },
        start: { dateTime: "2026-11-23T10:00:00", timeZone: "Central Europe Standard Time" },
        end: { dateTime: "2026-11-23T11:00:00", timeZone: "Central Europe Standard Time" },
        isAllDay: false,
        isReminderOn: true,
        reminderMinutesBeforeStart: 10,
        transactionId: expect.stringMatching(/^[0-9a-f]{32}$/),
      });
      expect(z.object({ transactionId: z.string() }).parse(second?.body).transactionId).toBe(
        z.object({ transactionId: z.string() }).parse(first?.body).transactionId,
      );
    });

    it("replaces an Event with If-Match, and a changed Event (412) is a conflict", async () => {
      let status = 200;
      const graph = new FakeGraph({
        "PATCH /me/events/AAMkEv-review": () => (status === 200 ? saved("AAMkEv-review", 'W/"r2"') : json({}, status)),
      });
      const adapter = adapterOn(graph);
      const ref = { remoteId: "AAMkEv-review", href: null, etag: 'W/"r1"' };
      expect(await adapter.putEvent(WORK, { ref, fields }, signal())).toMatchObject({ etag: 'W/"r2"' });
      expect(graph.graphRequests()[0]?.headers.get("if-match")).toBe('W/"r1"');
      status = 412;
      await expect(adapter.putEvent(WORK, { ref, fields }, signal())).rejects.toBeInstanceOf(
        CalendarSyncEventConflictError,
      );
    });

    it("writes a timed Event without a zone of its own in the tenant's zone", async () => {
      const graph = new FakeGraph({
        "POST /me/calendars/AAMkCal-work/events": () => saved("AAMkEv-new", 'W/"n1"'),
      });
      await adapterOn(graph).putEvent(
        WORK,
        { ref: null, fields: remoteFields({ date: "2026-11-23", timeFrom: "10:00", timeTo: "11:00" }) },
        signal(),
      );
      expect(graph.graphRequests()[0]?.body).toMatchObject({
        start: { dateTime: "2026-11-23T10:00:00", timeZone: "Central Europe Standard Time" },
        end: { dateTime: "2026-11-23T11:00:00", timeZone: "Central Europe Standard Time" },
      });
    });

    it("writes a series with its recurrence and deletes the occurrences its exception dates name", async () => {
      const graph = new FakeGraph({
        "POST /me/calendars/AAMkCal-work/events": () => json(fixture("standupMaster"), 201),
        "GET /me/events/AAMkSeries-standup/instances": () => json(fixture("standupInstances")),
        "DELETE /me/events/AAMkSeries-standup-occ-1130": () => new Response(null, { status: 204 }),
        "GET /me/events/AAMkSeries-standup": () =>
          json({ ...z.record(z.string(), z.unknown()).parse(fixture("standupMaster")), "@odata.etag": 'W/"m2"' }),
      });
      const ref = await adapterOn(graph).putEvent(
        WORK,
        {
          ref: null,
          fields: remoteFields({
            name: "Standup",
            date: "2026-11-02",
            timeFrom: "09:00",
            timeTo: "09:15",
            timeZone: "Europe/Prague",
            recurrenceRule: STANDUP_RULE,
            exceptionDates: ["2026-11-30T09:00"],
          }),
        },
        signal(),
      );
      expect(ref).toEqual({ remoteId: "AAMkSeries-standup", href: null, etag: 'W/"m2"' });
      const [create] = graph.graphRequests();
      expect(z.object({ recurrence: z.unknown() }).parse(create?.body).recurrence).toEqual({
        pattern: { type: "weekly", interval: 2, daysOfWeek: ["monday", "wednesday"], firstDayOfWeek: "monday" },
        range: {
          type: "endDate",
          startDate: "2026-11-02",
          endDate: "2026-11-30",
          recurrenceTimeZone: "Central Europe Standard Time",
        },
      });
      expect(
        graph
          .graphRequests()
          .filter((request) => request.method === "DELETE")
          .map((request) => request.url.pathname),
      ).toEqual(["/v1.0/me/events/AAMkSeries-standup-occ-1130"]);
    });

    it.each([
      [
        "a new override",
        remoteFields({
          date: "2026-11-23",
          timeFrom: "10:00",
          timeZone: "Europe/Prague",
          recurrenceId: "2026-11-23T09:00",
        }),
        null,
      ],
    ])("refuses %s before any request", async (_case, refused) => {
      const graph = new FakeGraph();
      await expect(adapterOn(graph).putEvent(WORK, { ref: null, fields: refused }, signal())).rejects.toBeInstanceOf(
        GraphCalendarWriteUnsupportedError,
      );
      expect(graph.graphRequests()).toEqual([]);
    });

    it("deletes with If-Match, and an Event already gone is deleted", async () => {
      const graph = new FakeGraph({ "DELETE /me/events/AAMkEv-review": () => json({}, 404) });
      await adapterOn(graph).deleteEvent(WORK, { remoteId: "AAMkEv-review", href: null, etag: 'W/"r1"' }, signal());
      expect(graph.graphRequests()[0]?.headers.get("if-match")).toBe('W/"r1"');
    });
  });

  describe("failures", () => {
    it.each<[string, () => Response, (error: unknown) => boolean]>([
      ["401", () => json({}, 401), (error) => error instanceof CalendarSyncReauthorizationRequiredError],
      ["403", () => json({}, 403), (error) => error instanceof CalendarSyncConsentRequiredError],
      [
        "429 asking for minutes",
        () => json({}, 429, { "Retry-After": "120" }),
        (error) => error instanceof CalendarSyncProviderError && error.code === "rateLimited",
      ],
      [
        "500",
        () => json({}, 500),
        (error) => error instanceof CalendarSyncProviderError && error.code === "providerUnavailable",
      ],
      ["400", () => json({}, 400), (error) => error instanceof GraphCalendarRequestError && error.status === 400],
      [
        "a body that is no JSON",
        () => new Response("<html>", { status: 200 }),
        (error) => error instanceof CalendarSyncProviderError && error.code === "invalidResponse",
      ],
      [
        "a body over the cap",
        () => new Response(new Uint8Array(16 * 1024 * 1024 + 1), { status: 200 }),
        (error) => error instanceof CalendarSyncProviderError && error.code === "invalidResponse",
      ],
    ])("maps %s", async (_case, answer, matches) => {
      const graph = new FakeGraph({ "GET /me/calendars": answer });
      const error = await adapterOn(graph)
        .listCalendars(signal())
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(matches(error)).toBe(true);
      // No error text carries what Graph sent.
      expect(error instanceof Error ? error.message : "").not.toMatch(/html|graph\.microsoft\.com/);
    });

    it("waits out a short Retry-After and retries", async () => {
      let calls = 0;
      const graph = new FakeGraph({
        "GET /me/calendars": () => (++calls === 1 ? json({}, 429, { "Retry-After": "0" }) : json({ value: [] })),
      });
      expect(await adapterOn(graph).listCalendars(signal())).toEqual([]);
      expect(calls).toBe(2);
    });

    it("gives up on a throttled request after three attempts", async () => {
      const graph = new FakeGraph({ "GET /me/calendars": () => json({}, 503, { "Retry-After": "0" }) });
      await expect(adapterOn(graph).listCalendars(signal())).rejects.toMatchObject({ code: "providerUnavailable" });
      expect(graph.graphRequests()).toHaveLength(3);
    });

    it("never follows a nextLink off Graph", async () => {
      const graph = new FakeGraph({
        "GET /me/calendars": () =>
          json({ value: [], "@odata.nextLink": "https://evil.example.test/v1.0/me/calendars" }),
      });
      await expect(adapterOn(graph).listCalendars(signal())).rejects.toMatchObject({ code: "invalidResponse" });
      expect(graph.requests.map((request) => request.url.host)).toEqual(["graph.microsoft.com"]);
    });

    it.each([
      ["an unreachable Graph", new TypeError("fetch failed"), "providerUnavailable"],
      ["an aborted pass", new DOMException("aborted", "AbortError"), "timeout"],
    ])("maps %s", async (_case, thrown, code) => {
      const controller = new AbortController();
      const failing: typeof fetch = async () => {
        if (code === "timeout") controller.abort();
        throw thrown;
      };
      const adapter = new GraphCalendarAdapter({
        getAccessToken: async () => "graph-access",
        tenantTimeZone: "Europe/Prague",
        fetchImpl: failing,
      });
      await expect(adapter.listCalendars(controller.signal)).rejects.toMatchObject({ code });
    });
  });
});

describe("Microsoft Graph calendar sync pass", () => {
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

  /** A Microsoft account with Calendars on, its refresh token stored and the calendar scope granted. */
  async function createMicrosoftAccount(): Promise<string> {
    const { mailboxesDatabaseId } = await ids();
    const accountId = await inTenant(async (client) => {
      const mailbox = await createChokePoint(runtime).createItem({
        databaseId: mailboxesDatabaseId,
        properties: { name: "Work account", provider: "outlook", mailEnabled: true, calendarsEnabled: false },
      });
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId,
        mailboxItemId: mailbox.id,
        address: "me@example.test",
      });
      await storeCredential(client, {
        itemId: mailbox.id,
        credentialType: "oauth2_refresh_token",
        plaintext: "refresh-1",
      });
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "graph_api" });
      await recordGrantedOauthScopes(client, mailbox.id, ["Mail.ReadWrite", "Calendars.ReadWrite", "offline_access"]);
      return mailbox.id;
    });
    await runInTenant(tenant, () =>
      createChokePoint(runtime).updateItem(
        { databaseId: mailboxesDatabaseId, itemId: accountId, propertiesPatch: { calendarsEnabled: true } },
        userId,
        userId,
        { writerKind: "user" },
      ),
    );
    return accountId;
  }

  const row = z.object({ properties: z.record(z.string(), z.unknown()), remote_id: z.string() });

  async function syncedRows(databaseId: string, table: "calendar_remote_state" | "event_remote_state") {
    const join = table === "calendar_remote_state" ? "s.calendar_item_id = i.id" : "s.event_item_id = i.id";
    return inTenant(async (client) => {
      // `table` and `join` are one of the two literals above.
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT i.properties, s.remote_id FROM items i JOIN ${table} s ON ${join}
          WHERE i.database_id = $1 AND i.deleted_at IS NULL ORDER BY s.remote_id`,
        [databaseId],
      );
      return z.array(row).parse(rows);
    });
  }

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  afterAll(async () => {
    await runtime.end();
  });

  beforeEach(async () => {
    // The pass derives its window from today; only `Date` is faked, so timers and the pool run normally.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-20T10:00:00Z") });
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

  afterEach(() => {
    setGraphCalendarSyncRuntime(null);
    vi.useRealTimers();
  });

  it("syncs through the production registry: calendars, the series with its exception dates and override", async () => {
    const graph = new FakeGraph(workRoutes());
    setGraphCalendarSyncRuntime({ pool: runtime, clientId: "client", clientSecret: "secret", fetchImpl: graph.fetch });
    const accountId = await createMicrosoftAccount();

    const result = await runInTenant(tenant, () =>
      handleCalendarAccountSyncTask(runtime, { accountItemId: accountId }),
    );
    expect(result?.kind).toBe("applied");

    const { calendarsDatabaseId, eventsDatabaseId } = await ids();
    const calendars = await syncedRows(calendarsDatabaseId, "calendar_remote_state");
    expect(calendars.map((calendar) => [calendar.remote_id, calendar.properties.readOnly])).toEqual([
      ["AAMkCal-holidays", true],
      ["AAMkCal-work", false],
    ]);
    const events = new Map(
      (await syncedRows(eventsDatabaseId, "event_remote_state")).map((event) => [event.remote_id, event]),
    );
    expect(events.get("AAMkSeries-standup")?.properties).toMatchObject({
      recurrenceRule: STANDUP_RULE,
      exceptionDates: ["2026-11-16T09:00", "2026-11-18T09:00"],
      timeZone: "Europe/Prague",
    });
    const master = await inTenant(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        "SELECT event_item_id AS id FROM event_remote_state WHERE remote_id = $1",
        ["AAMkSeries-standup"],
      );
      return rows[0]?.id;
    });
    expect(events.get("AAMkSeries-standup-exc-1104")?.properties).toMatchObject({
      seriesId: master,
      recurrenceId: "2026-11-04T09:00",
    });
    expect([...events.keys()]).toContain("AAMkEv-newyear");
    expect([...events.keys()]).not.toContain("AAMkEv-cancelled");

    // The refresh rotated the refresh token, which is stored for the next caller.
    expect(
      await runInTenant(tenant, () =>
        getDecryptedCredential(runtime, { itemId: accountId, actorType: "sync_worker", purpose: "test_read" }),
      ),
    ).toBe("rotated-refresh");
    const token = graph.requests.find((request) => request.url.href === MICROSOFT_TOKEN_URL);
    expect(token?.body instanceof URLSearchParams && token.body.get("refresh_token")).toBe("refresh-1");
    // One refreshed token serves the whole pass.
    expect(graph.requests.filter((request) => request.url.href === MICROSOFT_TOKEN_URL)).toHaveLength(1);
  });

  it("fails the pass as unexpected, with nothing fetched, when the process has no Graph OAuth client", async () => {
    const graph = new FakeGraph(workRoutes());
    const accountId = await createMicrosoftAccount();
    await expect(
      runInTenant(tenant, () => handleCalendarAccountSyncTask(runtime, { accountItemId: accountId })),
    ).rejects.toThrow("No Microsoft Graph OAuth client");
    const status = await inTenant(async (client) => {
      const { rows } = await client.query<{ status: string; last_error_code: string }>(
        "SELECT status, last_error_code FROM calendar_account_sync_state WHERE account_item_id = $1",
        [accountId],
      );
      return rows[0];
    });
    expect(status).toEqual({ status: "error", last_error_code: "unexpected" });
    expect(graph.requests).toEqual([]);
  });
});
