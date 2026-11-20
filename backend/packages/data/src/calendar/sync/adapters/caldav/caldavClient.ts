// The CalDAV requests of the sync, through `tsdav`'s request builders and its multistatus parser. Every call passes the
// session's fetch, and every answer is validated here before the adapter reads it.
import {
  calendarMultiGet,
  calendarQuery,
  createObject,
  deleteObject,
  propfind,
  syncCollection,
  updateObject,
} from "tsdav";
import { z } from "zod";
import {
  CalendarSyncProviderError,
  CalendarSyncReauthorizationRequiredError,
  type CalendarSyncCursor,
  type RemoteCalendar,
} from "../../adapter.js";
import type { CalDavSession } from "./caldavHttp.js";

const MAX_HREF_LENGTH = 2048;
const MAX_RESPONSES = 25_000;
/** Hrefs per calendar-multiget; a resource is a few KiB, so a batch stays far below the response cap. */
const MULTIGET_BATCH = 50;
/** RFC 6578 lets a server split a long change list; more rounds than this is read as a broken server. */
const MAX_SYNC_ROUNDS = 20;

const davResponseSchema = z.object({
  href: z.string().max(MAX_HREF_LENGTH).optional(),
  status: z.number().int(),
  ok: z.boolean(),
  props: z.record(z.string(), z.unknown()).optional(),
  raw: z.unknown().optional(),
});
type DavResponse = z.infer<typeof davResponseSchema>;

const multistatusSchema = z.object({ multistatus: z.object({ syncToken: z.unknown().optional() }) });

export function invalidResponse(message = "The CalDAV server's answer is invalid"): CalendarSyncProviderError {
  return new CalendarSyncProviderError("invalidResponse", message);
}

/** The error for an HTTP status the request could not succeed with. */
function statusFailure(status: number): Error {
  if (status === 401) return new CalendarSyncReauthorizationRequiredError("The CalDAV server refused the login");
  if (status === 429) return new CalendarSyncProviderError("rateLimited", "The CalDAV server is rate limiting");
  if (status >= 500) return new CalendarSyncProviderError("providerUnavailable", "The CalDAV server failed");
  return invalidResponse(`The CalDAV server answered ${status}`);
}

/**
 * `tsdav` reports a request that failed as a whole, or answered no multistatus, as one entry whose `href` is the
 * response's URL, which a response built by the session's fetch leaves empty: such an entry gets no `href`.
 */
function parseResponses(value: unknown): DavResponse[] {
  const parsed = z.array(davResponseSchema).max(MAX_RESPONSES).safeParse(value);
  if (!parsed.success) throw invalidResponse();
  return parsed.data.map((response) => (response.href === "" ? { ...response, href: undefined } : response));
}

/** The members of a multistatus answer; a request that failed as a whole is turned into its status's error. */
function members(responses: DavResponse[]): DavResponse[] {
  const [first] = responses;
  if (responses.length === 1 && first !== undefined && first.href === undefined && !first.ok) {
    throw statusFailure(first.status);
  }
  return responses.filter((response) => response.href !== undefined);
}

/** A text value as `tsdav` parses it: a string, a number, or an element with text or CDATA. */
function davText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value !== "object" || value === null) return null;
  if ("_cdata" in value && typeof value._cdata === "string") return value._cdata;
  if ("_text" in value && typeof value._text === "string") return value._text.trim();
  return null;
}

/** The first `<href>` inside a property element. */
function davHref(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("href" in value)) return null;
  const href: unknown = Array.isArray(value.href) ? value.href[0] : value.href;
  const text = davText(href);
  return text === null || text.length > MAX_HREF_LENGTH ? null : text;
}

function elementNames(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.keys(value);
}

function listOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function resolve(href: string, base: URL): URL {
  try {
    return new URL(href, base);
  } catch {
    throw invalidResponse("The CalDAV server sent an unreadable address");
  }
}

function sameCollection(a: URL, b: URL): boolean {
  const path = (url: URL): string => (url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`);
  return a.origin === b.origin && path(a) === path(b);
}

function baseOf(session: CalDavSession, requested: URL): URL {
  return session.lastResponseUrl() ?? requested;
}

/** One property of the resource at `url` (`Depth: 0`). */
async function propfindOne(
  session: CalDavSession,
  url: URL,
  props: Record<string, object>,
): Promise<{ response: DavResponse; base: URL }> {
  const responses = parseResponses(await propfind({ url: url.href, props, depth: "0", fetch: session.fetch }));
  const base = baseOf(session, url);
  const [response] = members(responses);
  if (response === undefined) throw invalidResponse("The CalDAV server answered no property");
  if (!response.ok) throw statusFailure(response.status);
  return { response, base };
}

/** `current-user-principal` from `start` (iCloud's root or a well-known address), then its `calendar-home-set`. */
export async function discoverCalendarHome(session: CalDavSession, start: URL): Promise<URL> {
  const principal = await propfindOne(session, start, { "d:current-user-principal": {} });
  const principalHref = davHref(principal.response.props?.currentUserPrincipal);
  if (principalHref === null) throw invalidResponse("The CalDAV server named no principal");
  const principalUrl = resolve(principalHref, principal.base);
  const home = await propfindOne(session, principalUrl, { "c:calendar-home-set": {} });
  const homeHref = davHref(home.response.props?.calendarHomeSet);
  if (homeHref === null) throw invalidResponse("The CalDAV server named no calendar home");
  return resolve(homeHref, home.base);
}

/** `#RRGGBB` from Apple's `#RRGGBB` or `#RRGGBBAA`. */
function normalizeColor(value: string | null): string | null {
  const match = value === null ? null : /^#([0-9A-Fa-f]{6})(?:[0-9A-Fa-f]{2})?$/.exec(value.trim());
  return match?.[1] === undefined ? null : `#${match[1].toUpperCase()}`;
}

const WRITE_PRIVILEGES = new Set(["write", "writeContent", "all"]);

/** Without a privilege set the calendar counts as writable; a refused write shows that later. */
function isReadOnly(props: Record<string, unknown>): boolean {
  const set: unknown = props.currentUserPrivilegeSet;
  if (typeof set !== "object" || set === null || !("privilege" in set)) return false;
  const granted = listOf(set.privilege).flatMap(elementNames);
  return !granted.some((name) => WRITE_PRIVILEGES.has(name));
}

/** True when the server lists no component set, which RFC 4791 reads as any component. */
function holdsEvents(props: Record<string, unknown>): boolean {
  const set: unknown = props.supportedCalendarComponentSet;
  if (typeof set !== "object" || set === null || !("comp" in set)) return true;
  return listOf(set.comp).some((comp) => {
    if (typeof comp !== "object" || comp === null || !("_attributes" in comp)) return false;
    const attributes: unknown = comp._attributes;
    if (typeof attributes !== "object" || attributes === null || !("name" in attributes)) return false;
    return typeof attributes.name === "string" && attributes.name.toUpperCase() === "VEVENT";
  });
}

/** The calendar collections under `home` that hold Events. Their path is the remote id. */
export async function listCalendarCollections(session: CalDavSession, home: URL): Promise<RemoteCalendar[]> {
  const responses = parseResponses(
    await propfind({
      url: home.href,
      props: {
        "d:resourcetype": {},
        "d:displayname": {},
        "ca:calendar-color": {},
        "cs:getctag": {},
        "d:current-user-privilege-set": {},
        "c:supported-calendar-component-set": {},
      },
      depth: "1",
      fetch: session.fetch,
    }),
  );
  const base = baseOf(session, home);
  const calendars: RemoteCalendar[] = [];
  for (const response of members(responses)) {
    const props = response.props ?? {};
    if (!response.ok || response.href === undefined) continue;
    if (!elementNames(props.resourcetype).includes("calendar") || !holdsEvents(props)) continue;
    const url = resolve(response.href, base);
    if (sameCollection(url, home)) continue;
    calendars.push({
      remoteId: url.pathname,
      url: url.href,
      name: davText(props.displayname),
      color: normalizeColor(davText(props.calendarColor)),
      readOnly: isReadOnly(props),
      ctag: davText(props.getctag),
    });
  }
  return calendars;
}

/** The collection's current `sync-token` and `getctag`; either is `null` when the server has none. */
export async function collectionVersion(session: CalDavSession, calendar: URL): Promise<CalendarSyncCursor> {
  const responses = parseResponses(
    await propfind({
      url: calendar.href,
      props: { "d:sync-token": {}, "cs:getctag": {} },
      depth: "0",
      fetch: session.fetch,
    }),
  );
  const [response] = members(responses);
  if (response === undefined) throw invalidResponse("The CalDAV server answered no property");
  // Both properties unknown makes `tsdav` report the member as failed; that is a server without either.
  return { syncToken: davText(response.props?.syncToken), ctag: davText(response.props?.getctag) };
}

/** A `YYYY-MM-DD` day as the UTC start of a time-range bound. */
function rangeBound(day: string, shiftDays: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + shiftDays);
  return `${date.toISOString().slice(0, 10).replaceAll("-", "")}T000000Z`;
}

/**
 * The Event resources overlapping `window` (a series when any occurrence does), by a calendar-query for their ETags.
 * The window is widened by a day each side, since its days are in the tenant's zone.
 */
export async function listEventHrefs(
  session: CalDavSession,
  calendar: URL,
  window: { start: string; end: string },
): Promise<URL[]> {
  const responses = parseResponses(
    await calendarQuery({
      url: calendar.href,
      props: { "d:getetag": {} },
      filters: {
        "comp-filter": {
          _attributes: { name: "VCALENDAR" },
          "comp-filter": {
            _attributes: { name: "VEVENT" },
            "time-range": { _attributes: { start: rangeBound(window.start, -1), end: rangeBound(window.end, 2) } },
          },
        },
      },
      depth: "1",
      fetch: session.fetch,
    }),
  );
  const base = baseOf(session, calendar);
  return members(responses)
    .filter((response) => response.ok && response.href !== undefined)
    .map((response) => resolve(response.href ?? "", base))
    .filter((url) => !sameCollection(url, calendar));
}

export interface CalendarResourceText {
  href: URL;
  etag: string | null;
  text: string;
}

/** The resources at `hrefs`, by calendar-multiget in batches; a resource gone meanwhile is left out. */
export async function fetchResources(
  session: CalDavSession,
  calendar: URL,
  hrefs: readonly URL[],
): Promise<CalendarResourceText[]> {
  const resources: CalendarResourceText[] = [];
  for (let index = 0; index < hrefs.length; index += MULTIGET_BATCH) {
    const batch = hrefs.slice(index, index + MULTIGET_BATCH);
    const responses = parseResponses(
      await calendarMultiGet({
        url: calendar.href,
        props: { "d:getetag": {}, "c:calendar-data": {} },
        objectUrls: batch.map((href) => href.pathname),
        depth: "1",
        fetch: session.fetch,
      }),
    );
    const base = baseOf(session, calendar);
    for (const response of members(responses)) {
      if (!response.ok || response.href === undefined) continue;
      const text = davText(response.props?.calendarData);
      if (text === null) continue;
      resources.push({ href: resolve(response.href, base), etag: davText(response.props?.getetag), text });
    }
  }
  return resources;
}

/** One resource by a plain GET; `null` when the server no longer has it (404, 410). */
export async function fetchResource(session: CalDavSession, href: URL): Promise<CalendarResourceText | null> {
  const response = await session.fetch(href.href, { method: "GET", headers: { Accept: ICALENDAR_TYPE } });
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw statusFailure(response.status);
  }
  return { href, etag: response.headers.get("etag"), text: await response.text() };
}

export type SyncDelta =
  | { kind: "changes"; syncToken: string; changed: URL[]; deleted: number }
  /** The token is no longer valid, or the server has no sync-collection: a full fetch follows. */
  | { kind: "restart" };

/** RFC 6578 answers to a token the server no longer accepts or a report it does not support. */
const RESTART_STATUSES = new Set([400, 403, 404, 405, 409, 410, 412, 501]);

/** The changes after `syncToken` by sync-collection (RFC 6578), following a truncated answer to its end. */
export async function syncChanges(session: CalDavSession, calendar: URL, syncToken: string): Promise<SyncDelta> {
  const changed = new Map<string, URL>();
  let deleted = 0;
  let token = syncToken;
  for (let round = 0; round < MAX_SYNC_ROUNDS; round += 1) {
    const responses = parseResponses(
      await syncCollection({
        url: calendar.href,
        props: { "d:getetag": {} },
        syncLevel: 1,
        syncToken: token,
        fetch: session.fetch,
      }),
    );
    const [first] = responses;
    if (first !== undefined && first.href === undefined && !first.ok && RESTART_STATUSES.has(first.status)) {
      return { kind: "restart" };
    }
    const listed = members(responses);
    const multistatus = multistatusSchema.safeParse(first?.raw);
    const next = multistatus.success ? davText(multistatus.data.multistatus.syncToken) : null;
    if (next === null || next.length > MAX_HREF_LENGTH) throw invalidResponse("The CalDAV server sent no sync token");
    const base = baseOf(session, calendar);
    let truncated = false;
    for (const response of listed) {
      const url = resolve(response.href ?? "", base);
      if (sameCollection(url, calendar)) {
        if (response.status === 507) truncated = true;
        continue;
      }
      if (response.status === 404) {
        deleted += 1;
        changed.delete(url.href);
      } else if (response.ok) {
        changed.set(url.href, url);
      }
    }
    token = next;
    if (!truncated) return { kind: "changes", syncToken: token, changed: [...changed.values()], deleted };
  }
  return { kind: "restart" };
}

export type WriteOutcome = { kind: "written"; etag: string | null } | { kind: "conflict" } | { kind: "gone" };

function writeOutcome(response: Response): WriteOutcome {
  if (response.status === 412) return { kind: "conflict" };
  if (response.status === 404 || response.status === 410) return { kind: "gone" };
  if (!response.ok) throw statusFailure(response.status);
  const etag = response.headers.get("etag");
  return { kind: "written", etag: etag !== null && etag.length <= MAX_HREF_LENGTH ? etag : null };
}

const ICALENDAR_TYPE = "text/calendar; charset=utf-8";

/** A PUT that fails with 412 when a resource already exists at `href`. */
export async function createResource(session: CalDavSession, href: URL, text: string): Promise<WriteOutcome> {
  return writeOutcome(
    await createObject({
      url: href.href,
      data: text,
      headers: { "Content-Type": ICALENDAR_TYPE, "If-None-Match": "*" },
      fetch: session.fetch,
    }),
  );
}

/** A PUT conditional on `etag`. */
export async function replaceResource(
  session: CalDavSession,
  href: URL,
  text: string,
  etag: string | null,
): Promise<WriteOutcome> {
  return writeOutcome(
    await updateObject({
      url: href.href,
      data: text,
      ...(etag === null ? {} : { etag }),
      headers: { "Content-Type": ICALENDAR_TYPE },
      fetch: session.fetch,
    }),
  );
}

/** A DELETE conditional on `etag`. */
export async function deleteResource(session: CalDavSession, href: URL, etag: string | null): Promise<WriteOutcome> {
  return writeOutcome(await deleteObject({ url: href.href, ...(etag === null ? {} : { etag }), fetch: session.fetch }));
}
