// The consumer that turns a downloaded ICS feed into `subscribedEvents` items (issue gh-2004). The hourly sweep of
// issue gh-1960 hands it the body of a changed feed of one subscription calendar inside a transaction of the calendar's
// tenant (`CalendarFeedConsumer`); `domainWriteHooks.ts` registers it with `registerCalendarFeedConsumer`.
// Constrained by: docs/adr/2026-09-10-choke-point-api-for-state-writes.md,
// docs/adr/2026-09-10-single-writer-ownership-model.md
import ICAL from "ical.js";
import { IANAZone } from "luxon";
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { getCalendarClock, instantToWallClock, wallClockToInstant, type WallClock } from "../calendarTime.js";
import { runAfterCommit } from "../db/pool.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { CALENDARS_MODULE_ID, SUBSCRIBED_EVENTS_MODULE_ID } from "../seed/calendarsKeys.js";
import type { CalendarFeedInput } from "./calendarSubscriptionSweep.js";
import type { PropertyRow } from "../types.js";
import { CALENDAR_MODULE_ID } from "./calendarModuleId.js";
import { logger } from "./logger.js";
import { parseRecurrenceRule } from "./subscribedEventRecurrence.js";

/** The character a UTF-8 text may start with to say it is UTF-8 (U+FEFF). */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** The property keys the import writes, all system-owned by the calendar module (`seed/seedSubscribedEvents.ts`). */
const SUBSCRIBED_EVENT_KEYS = [
  "uid",
  "title",
  "startsAt",
  "endsAt",
  "timeZone",
  "allDay",
  "place",
  "recurrenceRule",
  "exceptionDates",
  "recurrenceId",
] as const;

/** The key of the property of `SubscribedEvents` that holds the edge to the calendar (`seed/seedSubscribedEvents.ts`). */
const CALENDAR_PROPERTY_KEY = "calendar";

/** The feed is not an iCalendar document: nothing of it was stored, and the feed is requested in full again. */
export class CalendarFeedParseError extends Error {
  constructor(cause: unknown) {
    // A constant message: the parser's own text quotes the line it stopped at, which is feed content.
    super("The calendar feed is not a valid iCalendar document", { cause });
    this.name = "CalendarFeedParseError";
  }
}

/** The values one feed event gives a stored subscribed event. `null` is a value the feed does not carry. */
interface FeedEvent {
  uid: string;
  title: string | null;
  startsAt: string;
  endsAt: string | null;
  timeZone: string | null;
  allDay: boolean;
  place: string | null;
  /**
   * The `RRULE` of a master, as ical.js writes it back with the parts it does not model appended (`ruleText`); `null`
   * for an override and for an event without one.
   */
  recurrenceRule: string | null;
  /** The JSON array text of the original starts that `EXDATE` excludes, as tenant wall-clock `YYYY-MM-DDTHH:mm`. */
  exceptionDates: string | null;
  /** The tenant wall-clock `YYYY-MM-DDTHH:mm` of the occurrence an override replaces; `null` for a master. */
  recurrenceId: string | null;
}

/** What the VEVENTs of a feed amount to: the events that can be stored, and the ones that cannot. */
interface ParsedFeed {
  /** One event per `(uid, recurrenceId)`, the first of the feed when a pair repeats, in feed order. */
  events: FeedEvent[];
  /** The `eventKey`s of events that were read but cannot be stored: their stored rows stay as they are. */
  unreadableKeys: Set<string>;
  /** The VEVENTs that have no UID or no readable time or `RECURRENCE-ID`; counted for the log. */
  unreadableCount: number;
  /** The events whose `RRULE` is not expanded (`parseRecurrenceRule`); they are stored and shown once. */
  unsupportedRuleCount: number;
}

/** What one import did, by the number of events. */
export interface SubscribedEventsImportResult {
  created: number;
  updated: number;
  unchanged: number;
  trashed: number;
  unreadable: number;
  unsupportedRules: number;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function isoDate(time: ICAL.Time): string {
  return `${pad(time.year, 4)}-${pad(time.month, 2)}-${pad(time.day, 2)}`;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** The text of the first property `name` of the component, or `null` when it is absent or empty. */
function textOf(component: ICAL.Component, name: string): string | null {
  const value = component.getFirstPropertyValue(name);
  return hasText(value) ? value : null;
}

/** The `TZID` parameter of the first property `name`, or `null` when the property has none. */
function zoneNameOf(component: ICAL.Component, name: string): string | null {
  const parameter: unknown = component.getFirstProperty(name)?.getParameter("tzid");
  return hasText(parameter) ? parameter : null;
}

/**
 * The tenant wall-clock time of a feed time that has a time of day. A `Z` time is UTC and a `TZID` time is in that
 * zone, both converted with the calendar time module (`calendarTime.ts`); a time with neither is floating and
 * already the tenant's wall-clock time. Returns the zone name the feed gave (`null` for a floating time), or `null`
 * for the whole result when the time names a zone this server does not know.
 */
function toTenantWallClock(
  time: ICAL.Time,
  zoneName: string | null,
  tenantZone: string,
): { wall: WallClock; timeZone: string | null } | null {
  const zone = time.zone === ICAL.Timezone.utcTimezone ? "UTC" : zoneName;
  const clock = `${pad(time.hour, 2)}:${pad(time.minute, 2)}`;
  if (zone === null) return { wall: { date: isoDate(time), time: clock }, timeZone: null };
  // `IANAZone` takes only a zone name: luxon's own parser would also take `system` and fixed offsets.
  if (!IANAZone.isValidZone(zone)) return null;
  const instant = wallClockToInstant(isoDate(time), clock, zone).toJSDate();
  return { wall: instantToWallClock(instant, tenantZone), timeZone: zone };
}

function wallClockText(wall: WallClock): string {
  return `${wall.date}T${wall.time}`;
}

/**
 * The tenant wall-clock text `YYYY-MM-DDTHH:mm` of a time that names an original occurrence (`EXDATE`, `RECURRENCE-ID`),
 * or `null` when it names a zone this server does not know. A date is the start of that day, as an all-day event
 * starts (`readTimes`).
 */
function occurrenceStart(time: ICAL.Time, zoneName: string | null, tenantZone: string): string | null {
  if (time.isDate) return `${isoDate(time)}T00:00`;
  const converted = toTenantWallClock(time, zoneName, tenantZone);
  return converted === null ? null : wallClockText(converted.wall);
}

/**
 * The original start that the `RECURRENCE-ID` of an override names (`occurrenceStart`), or `null` when it has none that
 * can be read: no value, a value that is not a date or time, or a zone this server does not know.
 */
function overrideStart(component: ICAL.Component, tenantZone: string): string | null {
  const property = component.getFirstProperty("recurrence-id");
  if (property === null) return null;
  let time: unknown;
  try {
    // ical.js hydrates the value on access and reports one it cannot read with a plain Error, which `ICAL.parse` lets by.
    time = property.getFirstValue();
  } catch {
    return null;
  }
  if (!(time instanceof ICAL.Time)) return null;
  const zone: unknown = property.getParameter("tzid");
  return occurrenceStart(time, hasText(zone) ? zone : null, tenantZone);
}

/** The identity of a row of a calendar: the feed's UID and, for an override, the occurrence it replaces. */
function eventKey(uid: string, recurrenceId: string | null): string {
  return JSON.stringify([uid, recurrenceId]);
}

/** The date of the day before `time`. */
function dayBefore(time: ICAL.Time): string {
  const previous = time.clone();
  previous.adjust(-1, 0, 0, 0);
  return isoDate(previous);
}

/**
 * The start and the end of a feed event as stored values. An all-day event (`VALUE=DATE`) has `startsAt` at midnight
 * of its first day, and `endsAt` at midnight of its last day, the day before the feed's exclusive `DTEND`, or `null`
 * for a single day. A timed event is converted to the tenant's wall-clock time (`toTenantWallClock`); its `endsAt`
 * is `null` when the feed has no end or the end is not after the start.
 */
function readTimes(
  component: ICAL.Component,
  start: ICAL.Time,
  end: ICAL.Time,
  tenantZone: string,
): Pick<FeedEvent, "startsAt" | "endsAt" | "timeZone" | "allDay"> | null {
  if (start.isDate) {
    const firstDay = isoDate(start);
    const lastDay = dayBefore(end);
    return {
      startsAt: `${firstDay}T00:00`,
      endsAt: lastDay > firstDay ? `${lastDay}T00:00` : null,
      timeZone: null,
      allDay: true,
    };
  }
  const startZone = zoneNameOf(component, "dtstart");
  const from = toTenantWallClock(start, startZone, tenantZone);
  // An end derived from a `DURATION` is in the zone of the start.
  const to = toTenantWallClock(
    end,
    component.hasProperty("dtend") ? zoneNameOf(component, "dtend") : startZone,
    tenantZone,
  );
  if (from === null || to === null) return null;
  const startsAt = wallClockText(from.wall);
  const endsAt = wallClockText(to.wall);
  return { startsAt, endsAt: endsAt > startsAt ? endsAt : null, timeZone: from.timeZone, allDay: false };
}

/**
 * The names of the parts of an `RRULE` that `ICAL.Recur.toString()` writes back (`Recur._stringToData`: the options
 * `FREQ`, `COUNT`, `INTERVAL`, `UNTIL`, `WKST` and the `BY...` parts it models). ical.js keeps every other part (`RSCALE`,
 * `SKIP`, an `X-` part, a misspelt one) only as a field of the `Recur`, which `toString()` leaves out.
 */
const WRITTEN_BACK_RULE_PARTS = new Set([
  "freq",
  "count",
  "interval",
  "until",
  "wkst",
  "bysecond",
  "byminute",
  "byhour",
  "byday",
  "bymonthday",
  "byyearday",
  "byweekno",
  "bymonth",
  "bysetpos",
]);

/** `NAME=value` for each part of the jCal value of an `RRULE` that `include` accepts, in the feed's order. */
function jcalRuleParts(given: unknown, include: (name: string) => boolean): string[] {
  if (typeof given !== "object" || given === null) return [];
  return Object.entries(given)
    .filter(([name]) => name !== "" && include(name))
    .map(([name, value]: [string, unknown]) => {
      // A part is a string, a number or a list of them; a part without `=` has no value.
      const text = Array.isArray(value)
        ? value.join(",")
        : typeof value === "string" || typeof value === "number"
          ? String(value)
          : "";
      return `${name.toUpperCase()}=${text}`;
    });
}

/**
 * The text of an `RRULE` property to store: what ical.js writes back for the parts it models, and every other part
 * the feed gave appended as `NAME=value`. A rule with a part that is not modelled is thereby stored with it, and
 * `parseRecurrenceRule` finds it unsupported, where the text of `toString()` alone would read as a rule without it
 * (`RSCALE=HEBREW;FREQ=YEARLY` as `FREQ=YEARLY`) and the event would be shown on dates the feed does not mean. A rule
 * ical.js cannot hydrate (`UNTIL=garbage`) is stored as the parts of its jCal value, which `parseRecurrenceRule`
 * does not accept either, so the event is shown once. `null` when the property holds no recurrence value.
 */
function ruleText(property: ICAL.Property): string | null {
  // The jCal value holds the parts of the feed's text by lower-case name, those ical.js does not model included.
  const given: unknown = property.jCal[3];
  if (typeof given !== "object" || given === null) return null;
  let rule: unknown;
  try {
    // ical.js hydrates the value on access and reports one it cannot read with a plain Error, which `ICAL.parse` lets by.
    rule = property.getFirstValue();
  } catch {
    return jcalRuleParts(given, () => true).join(";");
  }
  if (!(rule instanceof ICAL.Recur)) return null;
  return [rule.toString(), ...jcalRuleParts(given, (name) => !WRITTEN_BACK_RULE_PARTS.has(name))].join(";");
}

/**
 * The recurrence values of one VEVENT: its `RRULE` (`ruleText`) and its `EXDATE`s, for a master, and the
 * `RECURRENCE-ID` for an override. `null` when an `EXDATE` or `RECURRENCE-ID` value cannot be read or names a zone this
 * server does not know.
 */
function readRecurrence(
  component: ICAL.Component,
  tenantZone: string,
): Pick<FeedEvent, "recurrenceRule" | "exceptionDates" | "recurrenceId"> | null {
  if (component.hasProperty("recurrence-id")) {
    const original = overrideStart(component, tenantZone);
    return original === null ? null : { recurrenceRule: null, exceptionDates: null, recurrenceId: original };
  }
  const ruleProperty = component.getFirstProperty("rrule");
  const recurrenceRule = ruleProperty === null ? null : ruleText(ruleProperty);
  const excluded = new Set<string>();
  for (const property of component.getAllProperties("exdate")) {
    const zone: unknown = property.getParameter("tzid");
    let values: unknown[];
    try {
      // ical.js hydrates the values on access and reports one it cannot read with a plain Error, which `ICAL.parse` lets by.
      values = property.getValues();
    } catch {
      return null;
    }
    for (const value of values) {
      const original =
        value instanceof ICAL.Time ? occurrenceStart(value, hasText(zone) ? zone : null, tenantZone) : null;
      if (original === null) return null;
      excluded.add(original);
    }
  }
  return {
    recurrenceRule,
    exceptionDates: excluded.size === 0 ? null : JSON.stringify([...excluded].sort()),
    recurrenceId: null,
  };
}

/**
 * The event of one VEVENT, or `null` when it has no readable start, an end the parser cannot read, a zone this
 * server does not know or a recurrence value that cannot be read.
 */
function readEvent(component: ICAL.Component, uid: string, tenantZone: string): FeedEvent | null {
  // An empty exception list: without it ical.js relates every RECURRENCE-ID sibling of the feed to every event, which
  // is quadratic in the feed and pointless here, because the overrides are read as events of their own.
  const event = new ICAL.Event(component, { exceptions: [] });
  let start: ICAL.Time | null;
  let end: ICAL.Time | null;
  try {
    // ical.js reports a value it cannot read with a plain Error, thrown by these accessors alone.
    start = event.startDate;
    end = start === null ? null : event.endDate;
  } catch {
    return null;
  }
  if (start === null || end === null) return null;
  const times = readTimes(component, start, end, tenantZone);
  const recurrence = readRecurrence(component, tenantZone);
  if (times === null || recurrence === null) return null;
  return { uid, title: textOf(component, "summary"), place: textOf(component, "location"), ...times, ...recurrence };
}

/**
 * Parses the feed text into the events to store. The parse is complete before anything is written, so a feed that
 * is malformed or cut off throws `CalendarFeedParseError` and changes nothing. A component with `RECURRENCE-ID` is an
 * override and an event of its own, keyed by its UID and the occurrence it replaces; a component with `RRULE` keeps the
 * rule as text, and the timeline expands it (issue gh-1966).
 */
function parseFeed(body: string, tenantZone: string): ParsedFeed {
  let root: ICAL.Component;
  try {
    // A byte order mark before `BEGIN` is a feed's own, not a parse error.
    const jcal: unknown = ICAL.parse(body.startsWith(BYTE_ORDER_MARK) ? body.slice(1) : body);
    // An empty text parses to nothing, and several calendars in one text to a list of them.
    if (!Array.isArray(jcal) || jcal[0] !== "vcalendar") throw new Error("The text is not a single VCALENDAR");
    root = new ICAL.Component(jcal);
  } catch (err) {
    throw new CalendarFeedParseError(err);
  }
  const byKey = new Map<string, FeedEvent>();
  const unreadableKeys = new Set<string>();
  let unreadableCount = 0;
  let unsupportedRuleCount = 0;
  for (const component of root.getAllSubcomponents("vevent")) {
    const uid = textOf(component, "uid");
    const event = uid === null ? null : readEvent(component, uid, tenantZone);
    if (event === null) {
      unreadableCount += 1;
      // An override whose `RECURRENCE-ID` cannot be read has no key, and keeps no row.
      const original = component.hasProperty("recurrence-id") ? overrideStart(component, tenantZone) : null;
      if (uid !== null && (original !== null || !component.hasProperty("recurrence-id"))) {
        unreadableKeys.add(eventKey(uid, original));
      }
      continue;
    }
    const key = eventKey(event.uid, event.recurrenceId);
    if (byKey.has(key)) continue;
    byKey.set(key, event);
    if (event.recurrenceRule !== null && parseRecurrenceRule(event.recurrenceRule) === null) unsupportedRuleCount += 1;
  }
  return { events: [...byKey.values()], unreadableKeys, unreadableCount, unsupportedRuleCount };
}

interface StoredEvent {
  id: string;
  properties: Record<string, unknown>;
}

/** The live subscribed events on the edges of `calendarItemId`, oldest first; `calendarProperty` is `SubscribedEvents.calendar`. */
async function listStoredEvents(
  client: PoolClient,
  calendarProperty: PropertyRow,
  calendarItemId: string,
): Promise<StoredEvent[]> {
  const definition = await relationsStore.getRelationDefinitionByPropertyId(client, calendarProperty.id);
  if (!definition) throw new Error("The subscribedEvents 'calendar' relation has no definition");
  const { rows } = await client.query<StoredEvent>(
    `SELECT i.id, i.properties
       FROM item_relations r
       JOIN items i ON i.id = r.item_b
      WHERE r.relation_definition_id = $1 AND r.item_a = $2
        AND i.database_id = $3 AND i.deleted_at IS NULL
      ORDER BY i.created_at, i.id`,
    [definition.id, calendarItemId, calendarProperty.databaseId],
  );
  return rows;
}

/** The `eventKey` of a stored row, or `null` for a row without a UID, which no feed event matches. */
function storedKey(row: StoredEvent): string | null {
  const { uid, recurrenceId } = row.properties;
  if (typeof uid !== "string") return null;
  return eventKey(uid, typeof recurrenceId === "string" && recurrenceId !== "" ? recurrenceId : null);
}

/** The values a feed event gives its row, without the UID, by property key. */
function storedValues(event: FeedEvent): Record<string, string | boolean | null> {
  return {
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timeZone: event.timeZone,
    allDay: event.allDay,
    place: event.place,
    recurrenceRule: event.recurrenceRule,
    exceptionDates: event.exceptionDates,
    recurrenceId: event.recurrenceId,
  };
}

/**
 * Writes the events of one downloaded feed into the `subscribedEvents` database for the calendar
 * `feed.calendarItemId`, in the caller's transaction (the sweep's, scoped to the calendar's tenant):
 *
 * - an event is matched to a live row of the calendar by `(calendar, uid, recurrenceId)`, the `recurrenceId` being
 *   `null` for a master and the replaced occurrence's original start for an override; a new key is created with the
 *   calendar's edge, a row whose values differ gets only the changed values, and a row that already holds the values
 *   is not written (no `updated_at` change, no invalidation);
 * - a live row of the calendar that no event of the feed matches is moved to the Trash with `itemDeleteWithClient`,
 *   never deleted permanently; a key that returns later has no live row and is created as a new item. A VEVENT that
 *   was read but cannot be stored (`ParsedFeed.unreadableKeys`) keeps its row as it is;
 * - all writes go through the choke point as the calendar module's system owner process, so the ownership check
 *   keeps refusing every other writer;
 * - the feed is parsed completely before the first write, and the calendar row is locked `FOR UPDATE` before the
 *   first write too (the sweep holds that lock already), so two imports of one calendar do not both create an event;
 * - when several live rows of the calendar hold one key, the oldest is the event and the others are trashed.
 *
 * Throws `CalendarFeedParseError` for a feed that is not an iCalendar document, and an `Error` when the tenant has no
 * calendar or no `subscribedEvents` database; the sweep records either as a failed consumer and stores nothing.
 * The transaction is the sweep's one per calendar and feed, not chunks, because the consumer contract of issue gh-1960
 * hands the consumer the sweep's client (`CalendarFeedConsumer`): this function cannot commit part of its writes, and
 * a chunked import needs that contract changed to give the consumer a pool or a per-chunk transaction runner. The
 * work stays bounded by the 5 MiB cap of the downloaded body, and it is linear in the feed (the parse relates no
 * exceptions, `readEvent`). A failure rolls the whole import back and the sweep keeps the old validators, so the feed
 * is requested and applied again.
 */
export async function importSubscribedEvents(
  client: PoolClient,
  feed: Pick<CalendarFeedInput, "calendarItemId" | "body">,
): Promise<SubscribedEventsImportResult> {
  const { zone: tenantZone } = await getCalendarClock(client);
  const parsed = parseFeed(feed.body, tenantZone);
  const calendars = await getDatabaseByModuleId(client, CALENDARS_MODULE_ID);
  const subscribedEvents = await getDatabaseByModuleId(client, SUBSCRIBED_EVENTS_MODULE_ID);
  if (!calendars || !subscribedEvents) throw new Error("The tenant has no Calendars or subscribedEvents database");
  const calendar = await itemsStore.lockItemById(client, calendars.id, feed.calendarItemId);
  if (calendar === null || calendar.deletedAt !== null) throw new Error("The feed's calendar is not a live calendar");
  const calendarProperty = await propertiesStore.getPropertyByKey(client, subscribedEvents.id, CALENDAR_PROPERTY_KEY);
  if (!calendarProperty) throw new Error("The subscribedEvents database has no 'calendar' property");

  const stored = await listStoredEvents(client, calendarProperty, calendar.id);
  const rowOfKey = new Map<string, StoredEvent>();
  for (const row of stored) {
    const key = storedKey(row);
    if (key !== null && !rowOfKey.has(key)) rowOfKey.set(key, row);
  }
  const options = { allowedSystemKeys: SUBSCRIBED_EVENT_KEYS, systemOwnerProcess: CALENDAR_MODULE_ID };
  const result: SubscribedEventsImportResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    trashed: 0,
    unreadable: parsed.unreadableCount,
    unsupportedRules: parsed.unsupportedRuleCount,
  };
  const kept = new Set<string>();

  for (const event of parsed.events) {
    const values = storedValues(event);
    const row = rowOfKey.get(eventKey(event.uid, event.recurrenceId));
    if (row === undefined) {
      const created = await createItemWithClient(
        client,
        {
          databaseId: subscribedEvents.id,
          properties: {
            uid: event.uid,
            ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)),
          },
        },
        options,
      );
      await createRelationWithClient(
        client,
        { relationPropertyId: calendarProperty.id, callerItemId: created.id, targetItemId: calendar.id },
        { ownerProcess: CALENDAR_MODULE_ID },
      );
      result.created += 1;
      continue;
    }
    kept.add(row.id);
    const patch = Object.fromEntries(
      Object.entries(values).filter(([key, value]) => (row.properties[key] ?? null) !== value),
    );
    if (Object.keys(patch).length === 0) {
      result.unchanged += 1;
      continue;
    }
    await updateItemWithClient(
      client,
      { databaseId: subscribedEvents.id, itemId: row.id, propertiesPatch: patch },
      options,
    );
    result.updated += 1;
  }

  for (const row of stored) {
    const key = storedKey(row);
    if (kept.has(row.id) || (key !== null && parsed.unreadableKeys.has(key))) continue;
    await itemDeleteWithClient(client, subscribedEvents.id, row.id, { queueAffinity: createActionQueueAffinity() });
    result.trashed += 1;
  }
  // The sweep stores the validators and commits after this returns, and either can fail: the line follows the commit,
  // so an import that is rolled back logs nothing. The copy keeps a later change of `result` out of the line.
  const logged = { calendarItemId: calendar.id, ...result };
  runAfterCommit(client, () => logger.info(logged, "Subscribed calendar feed imported"));
  return result;
}
