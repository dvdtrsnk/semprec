// The calendar sync adapter of iCloud and generic CalDAV accounts (sync mode `imap`): the account's stored password
// over Basic authentication, discovery from iCloud's CalDAV root or the account's CalDAV address, changes by
// sync-collection or, on a server without a sync-token, by the ctag and the resources' ETags, and conditional writes.
import { createHash, randomUUID } from "node:crypto";
import type { OutboundAddressPolicy } from "../../../../net/outboundAddressPolicy.js";
import { logger } from "../../../logger.js";
import {
  CalendarSyncEventConflictError,
  CalendarSyncWriteUnsupportedError,
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
  fetchResource,
  fetchResources,
  invalidResponse,
  listCalendarCollections,
  listEventHrefs,
  listResourceEtags,
  replaceResource,
  syncChanges,
  type CalendarResourceText,
} from "./caldavClient.js";
import { ICLOUD_CALDAV_URL } from "./caldavConnectVerification.js";
import { withCalDavSession, type CalDavLogin, type CalDavSession } from "./caldavHttp.js";
import {
  CalendarResourceUnreadableError,
  parseCalendarResource,
  parseOverrideRemoteId,
  removeOccurrence,
  serializeNewResource,
  setAttendeeParticipation,
  updateResource,
  type ParsedResource,
} from "./caldavIcal.js";

const PARTSTATS = { accepted: "ACCEPTED", tentative: "TENTATIVE", declined: "DECLINED" } as const;

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

/** The name of the resource made for a local Event: the same for every create of it. */
function createdResourceName(createKey: string): string {
  return createHash("sha256").update(createKey).digest("hex").slice(0, 32);
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

/** The address an href is compared by: a server may percent-encode a path differently from one answer to the next. */
function resourceKey(href: URL): string {
  try {
    return `${href.origin}${decodeURIComponent(href.pathname)}`;
  } catch (error) {
    // A stray `%` that is no escape: the path is compared as sent.
    if (error instanceof URIError) return href.href;
    throw error;
  }
}

interface KnownResource {
  etags: Set<string | null>;
  remoteIds: string[];
}

/** The stored Events by their resource; one resource holds a series' master and its overrides. */
function knownResources(known: readonly RemoteEventRef[]): Map<string, KnownResource> {
  const resources = new Map<string, KnownResource>();
  for (const ref of known) {
    if (ref.href === null) continue;
    const key = resourceKey(new URL(ref.href));
    const resource = resources.get(key) ?? { etags: new Set(), remoteIds: [] };
    resource.etags.add(ref.etag);
    resource.remoteIds.push(ref.remoteId);
    resources.set(key, resource);
  }
  return resources;
}

/**
 * The changes of a calendar whose server has no sync-token, by its ETags: every resource is listed with its ETag, only
 * a new resource or one whose ETag differs from the stored Events' is fetched, and a stored Event whose resource is no
 * longer listed, or no longer holds it, is deleted. A resource that holds no Event (a task, one ical.js cannot read)
 * is never stored, so it is fetched again by every pass.
 */
async function reconcileByEtags(
  session: CalDavSession,
  url: URL,
  known: readonly RemoteEventRef[],
  version: CalendarSyncCursor,
): Promise<CalendarChanges> {
  const stored = knownResources(known);
  const listed = await listResourceEtags(session, url);
  const listedKeys = new Set<string>();
  const changed: URL[] = [];
  for (const resource of listed) {
    const key = resourceKey(resource.href);
    listedKeys.add(key);
    const previous = stored.get(key);
    const unchanged =
      previous !== undefined &&
      resource.etag !== null &&
      previous.etags.size === 1 &&
      previous.etags.has(resource.etag);
    if (!unchanged) changed.push(resource.href);
  }
  const upserts = eventsOf(parseResources(await fetchResources(session, url, changed)));
  const upserted = new Set(upserts.map((event) => event.remoteId));
  const refetched = new Set(changed.map(resourceKey));
  const deletions = new Set<string>();
  for (const [key, resource] of stored) {
    if (listedKeys.has(key) && !refetched.has(key)) continue;
    for (const remoteId of resource.remoteIds) if (!upserted.has(remoteId)) deletions.add(remoteId);
  }
  return { full: false, upserts, deletions: [...deletions], nextSyncState: version };
}

/** A server with a sync-token lists the window's Events by a calendar-query; one without one is compared by ETags. */
async function fullFetch(
  session: CalDavSession,
  url: URL,
  window: CalendarSyncWindow,
  known: readonly RemoteEventRef[],
): Promise<CalendarChanges> {
  // Read before the listing, so a change made during it comes again with the next fetch.
  const version = await collectionVersion(session, url);
  if (version.syncToken === null) return reconcileByEtags(session, url, known, version);
  const hrefs = await listEventHrefs(session, url, window);
  const resources = parseResources(await fetchResources(session, url, hrefs));
  return { full: true, upserts: eventsOf(resources), deletions: [], nextSyncState: version };
}

/**
 * Incremental when the delta names every Event it touches: sync-collection gives addresses only, so a deleted
 * resource, or a changed series whose overrides may have gone, is re-read by a full fetch instead. A server without a
 * sync-token is skipped while its ctag stays the same, and otherwise compared by its resources' ETags.
 */
async function fetchChanges(
  session: CalDavSession,
  calendar: RemoteCalendar,
  cursor: CalendarSyncCursor | null,
  options: { window: CalendarSyncWindow; known: readonly RemoteEventRef[] },
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
    return fullFetch(session, url, options.window, options.known);
  }
  if (cursor !== null && cursor.ctag !== null && cursor.ctag === calendar.ctag) {
    return { full: false, upserts: [], deletions: [], nextSyncState: { syncToken: null, ctag: calendar.ctag } };
  }
  return fullFetch(session, url, options.window, options.known);
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

    fetchChanges: (calendar, cursor, { window, signal, known }) =>
      session(signal, (s) => fetchChanges(s, calendar, cursor, { window, known })),

    putEvent: (calendar, { ref: eventRef, fields, icalUid, seriesRef, createKey }, signal) =>
      session(signal, async (s) => {
        const url = calendarUrl(calendar);
        // A new override is written into its series' resource, which then holds it as one more VEVENT.
        const ref = eventRef ?? (fields.recurrenceId !== null ? (seriesRef ?? null) : null);
        if (ref === null) {
          if (fields.recurrenceId !== null) {
            throw new Error("An override is written into its series' resource, which needs the series' address");
          }
          // The resource's name is always generated (a UID may hold characters no path segment should), from the
          // local Event when there is one, so that a repeated create meets the resource the first one made.
          const name = createKey ? createdResourceName(createKey) : randomUUID();
          const uid = icalUid || name;
          const href = new URL(`${name}.ics`, url);
          const outcome = await createResource(s, href, serializeNewResource(uid, fields));
          if (outcome.kind === "written") return { remoteId: uid, href: href.href, etag: outcome.etag };
          if (!createKey) throw new CalendarSyncEventConflictError();
          // The resource of an earlier attempt: these fields are written onto it.
          const existing = await fetchResource(s, href);
          if (existing === null) throw new CalendarSyncEventConflictError();
          const { text, remoteId } = edited(() => updateResource(existing.text, fields));
          const replaced = await replaceResource(s, href, text, existing.etag);
          if (replaced.kind !== "written") throw new CalendarSyncEventConflictError();
          return { remoteId, href: href.href, etag: replaced.etag };
        }
        const href = eventHref(ref);
        const current = await fetchResource(s, href);
        if (current === null || (ref.etag !== null && current.etag !== ref.etag)) {
          throw new CalendarSyncEventConflictError();
        }
        const { text, remoteId } = edited(() => updateResource(current.text, fields));
        const outcome = await replaceResource(s, href, text, current.etag);
        if (outcome.kind !== "written") throw new CalendarSyncEventConflictError();
        return { remoteId, href: href.href, etag: outcome.etag };
      }),

    getEvent: (_calendar, ref, { signal }) =>
      session(signal, async (s) => {
        const current = await fetchResource(s, eventHref(ref));
        if (current === null) return null;
        const parsed = parseCalendarResource(current.text, { href: current.href.href, etag: current.etag });
        if (parsed === null) throw invalidResponse("The CalDAV resource is unreadable");
        return parsed.events.find((event) => event.remoteId === ref.remoteId) ?? null;
      }),

    // The attendee's PARTSTAT written to the resource: a server with scheduling (RFC 6638) sends the organizer the
    // reply itself.
    respondToInvitation: (_calendar, ref, { response, attendeeEmails }, signal) =>
      session(signal, async (s) => {
        const href = eventHref(ref);
        const current = await fetchResource(s, href);
        if (current === null) return "gone";
        const addresses = new Set(attendeeEmails.map((email) => email.toLowerCase()));
        const text = edited(() => setAttendeeParticipation(current.text, addresses, PARTSTATS[response]));
        if (text === null)
          throw new CalendarSyncWriteUnsupportedError("The account is no attendee of the CalDAV Event");
        const outcome = await replaceResource(s, href, text, current.etag);
        if (outcome.kind === "conflict") throw new CalendarSyncEventConflictError();
        return outcome.kind === "gone" ? "gone" : "answered";
      }),

    deleteEvent: (_calendar, ref, signal) =>
      session(signal, async (s) => {
        const href = eventHref(ref);
        const occurrence = parseOverrideRemoteId(ref.remoteId);
        if (occurrence === null) {
          const outcome = await deleteResource(s, href, ref.etag);
          if (outcome.kind === "conflict") throw new CalendarSyncEventConflictError();
          return;
        }
        // An override lives in its series' resource: the occurrence is cancelled there, not the resource deleted.
        const current = await fetchResource(s, href);
        if (current === null) return;
        if (ref.etag !== null && current.etag !== ref.etag) throw new CalendarSyncEventConflictError();
        const text = edited(() => removeOccurrence(current.text, occurrence[1]));
        const outcome = await replaceResource(s, href, text, current.etag);
        if (outcome.kind === "conflict") throw new CalendarSyncEventConflictError();
      }),
  };
}
