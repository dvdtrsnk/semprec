// The calendar sync adapter of iCloud and generic CalDAV accounts (sync mode `imap`): the account's stored password
// over Basic authentication, discovery from iCloud's CalDAV root or the account's CalDAV address, changes by
// sync-collection with a ctag fallback, and conditional writes.
import { randomUUID } from "node:crypto";
import type { OutboundAddressPolicy } from "../../../../net/outboundAddressPolicy.js";
import { logger } from "../../../logger.js";
import {
  CalendarSyncEventConflictError,
  type CalendarChanges,
  type CalendarSyncAccount,
  type CalendarSyncAdapter,
  type CalendarSyncCursor,
  type CalendarSyncWindow,
  type RemoteCalendar,
  type RemoteEvent,
  type RemoteEventRef,
} from "../../adapter.js";
import {
  collectionVersion,
  createResource,
  deleteResource,
  discoverCalendarHome,
  fetchResources,
  invalidResponse,
  listCalendarCollections,
  listEventHrefs,
  replaceResource,
  syncChanges,
  type CalendarResourceText,
} from "./caldavClient.js";
import { withCalDavSession, type CalDavLogin, type CalDavSession } from "./caldavHttp.js";
import {
  CalendarResourceUnreadableError,
  parseCalendarResource,
  parseOverrideRemoteId,
  removeOccurrence,
  serializeNewResource,
  updateResource,
  type ParsedResource,
} from "./caldavIcal.js";

const ICLOUD_CALDAV_URL = "https://caldav.icloud.com/";

/** Where discovery starts: iCloud's root, the account's CalDAV address, or the well-known address of its domain. */
function caldavStartUrl(input: { provider: string | null; caldavUrl: string | null; address: string }): URL {
  if (input.provider === "icloud") return new URL(ICLOUD_CALDAV_URL);
  if (input.caldavUrl !== null) return new URL(input.caldavUrl);
  const domain = input.address.slice(input.address.lastIndexOf("@") + 1);
  return new URL(`https://${domain}/.well-known/caldav`);
}

export interface CalDavAdapterOptions {
  /** The outbound policy every request is held to; the process's policy when absent. */
  policy?: OutboundAddressPolicy;
}

function calendarUrl(calendar: RemoteCalendar): URL {
  if (calendar.url === null) throw new Error(`CalDAV calendar ${calendar.remoteId} has no address`);
  const url = new URL(calendar.url);
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

function eventHref(ref: RemoteEventRef): URL {
  if (ref.href === null) throw new Error(`CalDAV Event ${ref.remoteId} has no address`);
  return new URL(ref.href);
}

function parseResources(resources: readonly CalendarResourceText[]): ParsedResource[] {
  const parsed: ParsedResource[] = [];
  let unreadable = 0;
  for (const resource of resources) {
    const result = parseCalendarResource(resource.text, { href: resource.href.href, etag: resource.etag });
    if (result === null) unreadable += 1;
    else parsed.push(result);
  }
  // A task, a journal or a resource ical.js cannot read is not an Event of the calendar.
  if (unreadable > 0) logger.info({ unreadable }, "CalDAV resources left out of the calendar sync");
  return parsed;
}

function eventsOf(resources: readonly ParsedResource[]): RemoteEvent[] {
  return resources.flatMap((resource) => resource.events);
}

async function fullFetch(session: CalDavSession, url: URL, window: CalendarSyncWindow): Promise<CalendarChanges> {
  // Read before the listing, so a change made during it comes again with the next fetch.
  const version = await collectionVersion(session, url);
  const hrefs = await listEventHrefs(session, url, window);
  const resources = parseResources(await fetchResources(session, url, hrefs));
  return { full: true, upserts: eventsOf(resources), deletions: [], nextSyncState: version };
}

/**
 * Incremental when the delta names every Event it touches: sync-collection gives addresses only, so a deleted
 * resource, or a changed series whose overrides may have gone, is re-read by a full fetch instead. A server without
 * sync-collection is compared by its ctag; the adapter keeps no ETags of its own, so a changed ctag means a full fetch.
 */
async function fetchChanges(
  session: CalDavSession,
  calendar: RemoteCalendar,
  cursor: CalendarSyncCursor | null,
  window: CalendarSyncWindow,
): Promise<CalendarChanges> {
  const url = calendarUrl(calendar);
  if (cursor?.syncToken) {
    const delta = await syncChanges(session, url, cursor.syncToken);
    if (delta.kind === "changes" && delta.deleted === 0) {
      const resources = parseResources(await fetchResources(session, url, delta.changed));
      if (!resources.some((resource) => resource.recurring)) {
        return {
          full: false,
          upserts: eventsOf(resources),
          deletions: [],
          nextSyncState: { syncToken: delta.syncToken, ctag: calendar.ctag },
        };
      }
    }
    return fullFetch(session, url, window);
  }
  if (cursor !== null && cursor.ctag !== null && cursor.ctag === calendar.ctag) {
    return { full: false, upserts: [], deletions: [], nextSyncState: { syncToken: null, ctag: calendar.ctag } };
  }
  return fullFetch(session, url, window);
}

/** The resource as the server has it now, `null` when it is gone. */
async function currentResource(session: CalDavSession, calendar: URL, href: URL): Promise<CalendarResourceText | null> {
  const [resource] = await fetchResources(session, calendar, [href]);
  return resource ?? null;
}

function edited<T>(edit: () => T): T {
  try {
    return edit();
  } catch (error) {
    if (error instanceof CalendarResourceUnreadableError) throw invalidResponse("The CalDAV resource is unreadable");
    throw error;
  }
}

/**
 * `account.serverSettings` must be set: an `imap` account has its user name there. Every method opens its own session
 * (HTTP clients closed when it settles) under the pass's `signal`.
 */
export function createCalDavAdapter(
  account: CalendarSyncAccount,
  options: CalDavAdapterOptions = {},
): CalendarSyncAdapter {
  const settings = account.serverSettings;
  if (settings === null) throw new Error(`Account ${account.accountItemId} has no mail server settings`);
  const login: CalDavLogin = { username: settings.username, password: account.credential };
  const start = caldavStartUrl({
    provider: account.provider,
    caldavUrl: settings.caldavUrl,
    address: account.primaryAddress ?? settings.username,
  });
  const session = <T>(signal: AbortSignal, fn: (session: CalDavSession) => Promise<T>): Promise<T> =>
    withCalDavSession(login, { signal, ...(options.policy ? { policy: options.policy } : {}) }, fn);

  return {
    listCalendars: (signal) =>
      session(signal, async (s) => listCalendarCollections(s, await discoverCalendarHome(s, start))),

    fetchChanges: (calendar, cursor, { window, signal }) =>
      session(signal, (s) => fetchChanges(s, calendar, cursor, window)),

    putEvent: (calendar, { ref, fields, icalUid }, signal) =>
      session(signal, async (s) => {
        const url = calendarUrl(calendar);
        if (ref === null) {
          if (fields.recurrenceId !== null) {
            throw new Error("An override is written into its series' resource, which needs the series' address");
          }
          // The resource's name is always generated: a UID may hold characters no path segment should.
          const uid = icalUid || randomUUID();
          const href = new URL(`${randomUUID()}.ics`, url);
          const outcome = await createResource(s, href, serializeNewResource(uid, fields));
          if (outcome.kind !== "written") throw new CalendarSyncEventConflictError();
          return { remoteId: uid, href: href.href, etag: outcome.etag };
        }
        const href = eventHref(ref);
        const current = await currentResource(s, url, href);
        if (current === null || (ref.etag !== null && current.etag !== ref.etag)) {
          throw new CalendarSyncEventConflictError();
        }
        const { text, remoteId } = edited(() => updateResource(current.text, fields));
        const outcome = await replaceResource(s, href, text, current.etag);
        if (outcome.kind !== "written") throw new CalendarSyncEventConflictError();
        return { remoteId, href: href.href, etag: outcome.etag };
      }),

    deleteEvent: (calendar, ref, signal) =>
      session(signal, async (s) => {
        const href = eventHref(ref);
        const occurrence = parseOverrideRemoteId(ref.remoteId);
        if (occurrence === null) {
          const outcome = await deleteResource(s, href, ref.etag);
          if (outcome.kind === "conflict") throw new CalendarSyncEventConflictError();
          return;
        }
        // An override lives in its series' resource: the occurrence is cancelled there, not the resource deleted.
        const current = await currentResource(s, calendarUrl(calendar), href);
        if (current === null) return;
        if (ref.etag !== null && current.etag !== ref.etag) throw new CalendarSyncEventConflictError();
        const text = edited(() => removeOccurrence(current.text, occurrence[1]));
        const outcome = await replaceResource(s, href, text, current.etag);
        if (outcome.kind === "conflict") throw new CalendarSyncEventConflictError();
      }),
  };
}
