// Turns a downloaded ICS feed into `subscribedEvents` items. The subscription sweep hands it a changed feed inside
// a transaction of the calendar's tenant (`CalendarFeedConsumer`).
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
import { parseRecurrenceRule } from "./recurrenceExpansion.js";

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** All system-owned by the calendar module. */
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

const CALENDAR_PROPERTY_KEY = "calendar";

/** Nothing of the feed was stored, and it is requested in full again. */
export class CalendarFeedParseError extends Error {
  constructor(cause: unknown) {
    // Constant message: the parser's own text quotes feed content.
    super("The calendar feed is not a valid iCalendar document", { cause });
    this.name = "CalendarFeedParseError";
  }
}

interface FeedEvent {
  uid: string;
  title: string | null;
  startsAt: string;
  endsAt: string | null;
  timeZone: string | null;
  allDay: boolean;
  place: string | null;
  /** See `ruleText`; `null` for an override. */
  recurrenceRule: string | null;
  /** JSON array of excluded original starts, as tenant wall-clock `YYYY-MM-DDTHH:mm`. */
  exceptionDates: string | null;
  /** The original start an override replaces; `null` for a master. */
  recurrenceId: string | null;
}

interface ParsedFeed {
  /** One per `(uid, recurrenceId)`; the first wins when a pair repeats. */
  events: FeedEvent[];
  /** Their stored rows stay as they are. */
  unreadableKeys: Set<string>;
  unreadableCount: number;
  /** Events whose `RRULE` is not expanded; they are stored and shown once. */
  unsupportedRuleCount: number;
}

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

function textOf(component: ICAL.Component, name: string): string | null {
  const value = component.getFirstPropertyValue(name);
  return hasText(value) ? value : null;
}

function zoneNameOf(component: ICAL.Component, name: string): string | null {
  const parameter: unknown = component.getFirstProperty(name)?.getParameter("tzid");
  return hasText(parameter) ? parameter : null;
}

/** A floating time is already tenant wall clock. `null` for a zone this server does not know. */
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

/** For `EXDATE` and `RECURRENCE-ID`. A date is the start of that day, as an all-day event starts. */
function occurrenceStart(time: ICAL.Time, zoneName: string | null, tenantZone: string): string | null {
  if (time.isDate) return `${isoDate(time)}T00:00`;
  const converted = toTenantWallClock(time, zoneName, tenantZone);
  return converted === null ? null : wallClockText(converted.wall);
}

function overrideStart(component: ICAL.Component, tenantZone: string): string | null {
  const property = component.getFirstProperty("recurrence-id");
  if (property === null) return null;
  let time: unknown;
  try {
    // ical.js hydrates on access and throws a plain Error for an unreadable value, which `ICAL.parse` lets by.
    time = property.getFirstValue();
  } catch {
    return null;
  }
  if (!(time instanceof ICAL.Time)) return null;
  const zone: unknown = property.getParameter("tzid");
  return occurrenceStart(time, hasText(zone) ? zone : null, tenantZone);
}

function eventKey(uid: string, recurrenceId: string | null): string {
  return JSON.stringify([uid, recurrenceId]);
}

function dayBefore(time: ICAL.Time): string {
  const previous = time.clone();
  previous.adjust(-1, 0, 0, 0);
  return isoDate(previous);
}

/**
 * An all-day `endsAt` is the last day inclusive (the feed's `DTEND` is exclusive), `null` for a single day. A timed
 * `endsAt` is `null` when the end is not after the start.
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
 * The parts `ICAL.Recur.toString()` writes back. Every other part (`RSCALE`, `SKIP`, `X-`, a misspelt one) is kept
 * only as a `Recur` field that `toString()` leaves out.
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
 * Unmodelled parts are appended so `parseRecurrenceRule` finds the rule unsupported; `toString()` alone would turn
 * `RSCALE=HEBREW;FREQ=YEARLY` into `FREQ=YEARLY` and show the event on dates the feed does not mean. A rule ical.js
 * cannot hydrate is stored as its raw jCal parts, which are rejected too, so the event is shown once.
 */
function ruleText(property: ICAL.Property): string | null {
  // The jCal value holds every part of the feed's text by lower-case name.
  const given: unknown = property.jCal[3];
  if (typeof given !== "object" || given === null) return null;
  let rule: unknown;
  try {
    // ical.js hydrates on access and throws a plain Error for an unreadable value, which `ICAL.parse` lets by.
    rule = property.getFirstValue();
  } catch {
    return jcalRuleParts(given, () => true).join(";");
  }
  if (!(rule instanceof ICAL.Recur)) return null;
  return [rule.toString(), ...jcalRuleParts(given, (name) => !WRITTEN_BACK_RULE_PARTS.has(name))].join(";");
}

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
      // ical.js hydrates on access and throws a plain Error for an unreadable value.
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

function readEvent(component: ICAL.Component, uid: string, tenantZone: string): FeedEvent | null {
  // Without an empty exception list ical.js relates every RECURRENCE-ID sibling to every event, which is quadratic
  // and pointless here, because overrides are read as events of their own.
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
 * Completes before anything is written, so a malformed or truncated feed changes nothing. An override is an event of
 * its own; an `RRULE` is kept as text and expanded by the timeline.
 */
function parseFeed(body: string, tenantZone: string): ParsedFeed {
  let root: ICAL.Component;
  try {
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

/** Oldest first. */
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

function storedKey(row: StoredEvent): string | null {
  const { uid, recurrenceId } = row.properties;
  if (typeof uid !== "string") return null;
  return eventKey(uid, typeof recurrenceId === "string" && recurrenceId !== "" ? recurrenceId : null);
}

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
 * Rows match by `(calendar, uid, recurrenceId)`; an unchanged row is not written (no `updated_at` change, no
 * invalidation). Unmatched rows are trashed, never deleted; duplicates of one key keep the oldest. The calendar row
 * is locked `FOR UPDATE` first, so two imports of one calendar do not both create an event.
 *
 * Runs in the sweep's single transaction because the consumer contract hands over its client; the 5 MiB body cap
 * and a linear parse keep it bounded. A failure rolls everything back and the sweep keeps the old validators, so the
 * feed is applied again.
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
  // Logged after commit, so a rolled-back import logs nothing; the copy keeps later changes of `result` out.
  const logged = { calendarItemId: calendar.id, ...result };
  runAfterCommit(client, () => logger.info(logged, "Subscribed calendar feed imported"));
  return result;
}
