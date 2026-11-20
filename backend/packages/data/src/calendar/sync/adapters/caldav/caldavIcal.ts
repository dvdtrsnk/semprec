// iCalendar objects of a CalDAV calendar to and from the sync's Event payload, with ical.js. A resource holds one UID:
// the series (or single Event) and the overrides of its occurrences. Writing back edits only the properties whose
// modelled value changed, so everything else in the resource (attendees, other alarms, X- properties, VTIMEZONE)
// stays as the server sent it.
import ICAL from "ical.js";
import { DateTime, IANAZone } from "luxon";
import { ruleText } from "../../../icalRecurrenceRuleText.js";
import type { RemoteEvent, RemoteEventFields, RemoteParticipant } from "../../adapter.js";

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const PRODUCT_ID = "-//Semprec//Calendar sync//EN";
/** The sync payload's bounds (`calendarSyncApply.ts`); an Event over them is left out rather than failing the pass. */
const MAX_TEXT_LENGTH = 100_000;
const MAX_ID_LENGTH = 2048;
const MAX_PARTICIPANTS = 500;
const MAX_EXCEPTION_DATES = 1000;
/** How far a generated VTIMEZONE lists the zone's transitions around the Event's year. */
const VTIMEZONE_YEARS_BEFORE = 1;
const VTIMEZONE_YEARS_AFTER = 25;

/** A floating time is wall clock in the tenant's zone (`null`); a zone ical.js can only convert reads as `UTC`. */
type SeriesZone = string | null;

/** One calendar object resource as the sync reads it. */
export interface ParsedResource {
  uid: string;
  /** The series or single Event first, then the overrides. */
  events: RemoteEvent[];
  /** A series, or overrides of one: a change to it can drop an override the sync cannot name. */
  recurring: boolean;
}

/** The remote id of an override: the series' UID and the occurrence it replaces, which no plain UID can equal. */
export function overrideRemoteId(uid: string, recurrenceId: string): string {
  return JSON.stringify([uid, recurrenceId]);
}

/** `[uid, recurrenceId]` of an override's remote id, `null` for the remote id of a series or single Event. */
export function parseOverrideRemoteId(remoteId: string): [string, string] | null {
  if (!remoteId.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(remoteId);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const uid: unknown = parsed[0];
  const recurrenceId: unknown = parsed[1];
  return typeof uid === "string" && typeof recurrenceId === "string" ? [uid, recurrenceId] : null;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function isoDate(time: ICAL.Time): string {
  return `${pad(time.year, 4)}-${pad(time.month)}-${pad(time.day)}`;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** `Europe/Prague`, also inside a vendor prefix such as `/mozilla.org/20050126_1/Europe/Prague`; else `null`. */
function ianaZoneOf(tzid: string): string | null {
  if (IANAZone.isValidZone(tzid) && tzid.includes("/")) return tzid;
  if (tzid === "UTC" || tzid === "Etc/UTC") return "UTC";
  const tail = /([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})$/.exec(tzid)?.[1];
  return tail !== undefined && IANAZone.isValidZone(tail) ? tail : null;
}

type OwnZone = { kind: "named"; zone: string } | { kind: "converted"; time: ICAL.Time } | { kind: "floating" };

/** How a value of `property` is anchored: a named zone, a VTIMEZONE only ical.js can apply, or none. */
function ownZone(time: ICAL.Time, property: ICAL.Property): OwnZone {
  if (time.zone === ICAL.Timezone.utcTimezone) return { kind: "named", zone: "UTC" };
  const tzid: unknown = property.getParameter("tzid");
  if (hasText(tzid)) {
    const named = ianaZoneOf(tzid);
    if (named !== null) return { kind: "named", zone: named };
    if (time.zone !== ICAL.Timezone.localTimezone) return { kind: "converted", time };
  }
  return { kind: "floating" };
}

function wallOf(time: ICAL.Time, zone: string): DateTime {
  return DateTime.fromObject(
    { year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute },
    { zone },
  );
}

/** The value as luxon time in `target` (`null`: floating, represented in UTC). */
function inZone(time: ICAL.Time, property: ICAL.Property, target: SeriesZone): DateTime {
  const own = ownZone(time, property);
  const representation = target ?? "UTC";
  if (own.kind === "floating") return wallOf(time, representation);
  if (own.kind === "named") return wallOf(time, own.zone).setZone(representation);
  return DateTime.fromSeconds(own.time.toUnixTime(), { zone: "UTC" }).setZone(representation);
}

function seriesZoneOf(start: ICAL.Time, property: ICAL.Property): SeriesZone {
  if (start.isDate) return null;
  const own = ownZone(start, property);
  if (own.kind === "named") return own.zone;
  return own.kind === "converted" ? "UTC" : null;
}

function localStartText(value: DateTime): string {
  return value.toFormat("yyyy-MM-dd'T'HH:mm");
}

/** An `EXDATE` or `RECURRENCE-ID` value as a local start in the series' zone. */
function occurrenceStart(time: ICAL.Time, property: ICAL.Property, zone: SeriesZone): string {
  return time.isDate ? isoDate(time) : localStartText(inZone(time, property, zone));
}

function firstTime(component: ICAL.Component, name: string): { time: ICAL.Time; property: ICAL.Property } | null {
  const property = component.getFirstProperty(name);
  if (property === null) return null;
  // ical.js hydrates on access and throws a plain Error for an unreadable value.
  const value: unknown = property.getFirstValue();
  return value instanceof ICAL.Time ? { time: value, property } : null;
}

function textOf(component: ICAL.Component, name: string): string | null {
  const value: unknown = component.getFirstPropertyValue(name);
  return hasText(value) ? value : null;
}

type Times = Pick<RemoteEventFields, "date" | "endDate" | "timeFrom" | "timeTo" | "timeZone">;

function readTimes(component: ICAL.Component, zone: SeriesZone): Times | null {
  const start = firstTime(component, "dtstart");
  if (start === null) return null;
  const end = firstTime(component, "dtend");
  const durationValue: unknown = component.getFirstPropertyValue("duration");
  const duration = durationValue instanceof ICAL.Duration ? durationValue : null;
  if (start.time.isDate) {
    const first = DateTime.fromISO(isoDate(start.time), { zone: "UTC" });
    let exclusiveEnd = first.plus({ days: 1 });
    if (end !== null) exclusiveEnd = DateTime.fromISO(isoDate(end.time), { zone: "UTC" });
    else if (duration !== null) exclusiveEnd = first.plus({ seconds: duration.toSeconds() }).startOf("day");
    const last = exclusiveEnd.minus({ days: 1 });
    const date = isoDate(start.time);
    const lastDay = last.toISODate() ?? date;
    return { date, endDate: lastDay > date ? lastDay : null, timeFrom: null, timeTo: null, timeZone: null };
  }
  const from = inZone(start.time, start.property, zone);
  let to = from;
  if (end !== null) to = inZone(end.time, end.property, zone);
  else if (duration !== null) to = from.plus({ seconds: duration.toSeconds() });
  const date = from.toISODate();
  if (date === null) return null;
  const times: Times = { date, endDate: null, timeFrom: from.toFormat("HH:mm"), timeTo: null, timeZone: zone };
  if (to <= from) return times;
  const endDay = to.toISODate();
  const endTime = to.toFormat("HH:mm");
  if (endDay === date) return { ...times, timeTo: endTime };
  if (endTime === "00:00" && endDay === from.plus({ days: 1 }).toISODate()) return { ...times, timeTo: "24:00" };
  return { ...times, endDate: endDay, timeTo: endTime };
}

function readExceptionDates(component: ICAL.Component, zone: SeriesZone): string[] | null {
  const excluded = new Set<string>();
  for (const property of component.getAllProperties("exdate")) {
    for (const value of property.getValues()) {
      if (value instanceof ICAL.Time) excluded.add(occurrenceStart(value, property, zone));
    }
  }
  return excluded.size === 0 ? null : [...excluded].sort();
}

function isDisplayAlarm(alarm: ICAL.Component): boolean {
  const action: unknown = alarm.getFirstPropertyValue("action");
  return typeof action === "string" && action.toUpperCase() === "DISPLAY";
}

/** Minutes before the start of the first display alarm; `null` for none, an absolute or an end-related trigger. */
function readAlertMinutes(component: ICAL.Component): number | null {
  const alarm = component.getAllSubcomponents("valarm").find(isDisplayAlarm);
  const trigger = alarm?.getFirstProperty("trigger");
  if (trigger === undefined || trigger === null) return null;
  const related: unknown = trigger.getParameter("related");
  const value: unknown = trigger.getFirstValue();
  if (!(value instanceof ICAL.Duration) || (typeof related === "string" && related.toUpperCase() === "END")) {
    return null;
  }
  const seconds = value.toSeconds();
  return seconds <= 0 && seconds % 60 === 0 ? Math.abs(seconds) / 60 : null;
}

function parameterText(property: ICAL.Property, name: string): string | null {
  const value: unknown = property.getParameter(name);
  return hasText(value) ? value : null;
}

function participant(property: ICAL.Property, withRole: boolean): RemoteParticipant {
  const address: unknown = property.getFirstValue();
  const email = hasText(address) ? address.replace(/^mailto:/i, "") : null;
  return {
    email,
    name: parameterText(property, "cn"),
    role: withRole ? parameterText(property, "role") : null,
    status: withRole ? parameterText(property, "partstat") : null,
  };
}

/** A participant is kept in the snapshot only; one with a value over the payload bound is left out of it. */
function storable(participant: RemoteParticipant): boolean {
  const values = [participant.email, participant.name, participant.role, participant.status];
  return values.every((value) => value === null || value.length <= MAX_ID_LENGTH);
}

function withinBounds(fields: RemoteEventFields): boolean {
  const texts = [fields.name, fields.place, fields.description, fields.url, fields.recurrenceRule];
  return (
    texts.every((text) => text === null || text.length <= MAX_TEXT_LENGTH) &&
    (fields.exceptionDates?.length ?? 0) <= MAX_EXCEPTION_DATES
  );
}

function readFields(component: ICAL.Component, zone: SeriesZone): RemoteEventFields | null {
  const times = readTimes(component, zone);
  if (times === null) return null;
  const recurrence = firstTime(component, "recurrence-id");
  const rule = component.getFirstProperty("rrule");
  const fields: RemoteEventFields = {
    name: textOf(component, "summary"),
    ...times,
    recurrenceRule: recurrence === null && rule !== null ? ruleText(rule) : null,
    exceptionDates: recurrence === null ? readExceptionDates(component, zone) : null,
    recurrenceId: recurrence === null ? null : occurrenceStart(recurrence.time, recurrence.property, zone),
    place: textOf(component, "location"),
    description: textOf(component, "description"),
    url: textOf(component, "url"),
    alertMinutes: readAlertMinutes(component),
  };
  return withinBounds(fields) ? fields : null;
}

function parseRoot(text: string): ICAL.Component | null {
  try {
    const jcal: unknown = ICAL.parse(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text);
    if (!Array.isArray(jcal) || jcal[0] !== "vcalendar") return null;
    return new ICAL.Component(jcal);
  } catch {
    // ical.js reports any unreadable text with a plain Error; the caller counts the resource as unreadable.
    return null;
  }
}

interface ResourceParts {
  root: ICAL.Component;
  uid: string;
  master: ICAL.Component | null;
  overrides: ICAL.Component[];
  zone: SeriesZone;
}

function resourceParts(root: ICAL.Component): ResourceParts | null {
  const events = root.getAllSubcomponents("vevent");
  const uid = events.map((event) => textOf(event, "uid")).find((value) => value !== null);
  if (uid === undefined || uid.length > MAX_ID_LENGTH) return null;
  const sameUid = events.filter((event) => textOf(event, "uid") === uid);
  const master = sameUid.find((event) => !event.hasProperty("recurrence-id")) ?? null;
  const overrides = sameUid.filter((event) => event.hasProperty("recurrence-id"));
  const anchor = master ?? overrides[0];
  const start = anchor === undefined ? null : firstTime(anchor, "dtstart");
  const zone = start === null ? null : seriesZoneOf(start.time, start.property);
  return { root, uid, master, overrides, zone };
}

function remoteEvent(
  component: ICAL.Component,
  parts: ResourceParts,
  address: { href: string; etag: string | null },
): RemoteEvent | null {
  const fields = readFields(component, parts.zone);
  if (fields === null) return null;
  const organizerProperty = component.getFirstProperty("organizer");
  const organizer = organizerProperty === null ? null : participant(organizerProperty, false);
  return {
    remoteId: fields.recurrenceId === null ? parts.uid : overrideRemoteId(parts.uid, fields.recurrenceId),
    href: address.href,
    etag: address.etag,
    seriesRemoteId: fields.recurrenceId === null ? null : parts.uid,
    fields,
    organizer: organizer !== null && storable(organizer) ? organizer : null,
    attendees: component
      .getAllProperties("attendee")
      .map((attendee) => participant(attendee, true))
      .filter(storable)
      .slice(0, MAX_PARTICIPANTS),
  };
}

/**
 * The VEVENTs of one resource; `null` when the text is no iCalendar object, has no VEVENT with a UID, or any of them
 * cannot be read (a resource is synced whole or not at all). A resource without a VEVENT (a task) is `null` too.
 */
export function parseCalendarResource(
  text: string,
  address: { href: string; etag: string | null },
): ParsedResource | null {
  const root = parseRoot(text);
  if (root === null) return null;
  try {
    const parts = resourceParts(root);
    if (parts === null) return null;
    const components = parts.master === null ? parts.overrides : [parts.master, ...parts.overrides];
    const events: RemoteEvent[] = [];
    for (const component of components) {
      const event = remoteEvent(component, parts, address);
      if (event === null) return null;
      events.push(event);
    }
    const recurring = parts.overrides.length > 0 || (parts.master?.hasProperty("rrule") ?? false);
    return { uid: parts.uid, events, recurring };
  } catch {
    // ical.js hydrates values on access and throws a plain Error for one it cannot read.
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Writing

function timeValue(date: string, time: string | null): ICAL.Time {
  const [year, month, day] = date.split("-").map(Number);
  if (time === null) return ICAL.Time.fromData({ year, month, day, isDate: true });
  const [hour, minute] = time.split(":").map(Number);
  return ICAL.Time.fromData({ year, month, day, hour, minute, second: 0, isDate: false });
}

/** `24:00` is the next day's midnight. */
function wallValue(date: string, time: string): ICAL.Time {
  if (time !== "24:00") return timeValue(date, time);
  const next = DateTime.fromISO(date, { zone: "UTC" }).plus({ days: 1 }).toISODate() ?? date;
  return timeValue(next, "00:00");
}

function dayAfter(date: string): string {
  return DateTime.fromISO(date, { zone: "UTC" }).plus({ days: 1 }).toISODate() ?? date;
}

/** A property holding `values`, all dates or all date-times in `zone` (`UTC` as `Z`, `null` floating). */
function timeProperty(name: string, values: ICAL.Time[], zone: SeriesZone): ICAL.Property {
  const property = new ICAL.Property(name);
  const isDate = values.every((value) => value.isDate);
  if (isDate) property.resetType("date");
  for (const value of values) {
    if (zone === "UTC" && !value.isDate) value.zone = ICAL.Timezone.utcTimezone;
  }
  if (values.length === 1 && values[0] !== undefined) property.setValue(values[0]);
  else property.setValues(values);
  if (!isDate && zone !== null && zone !== "UTC") property.setParameter("tzid", zone);
  return property;
}

function localStartValue(start: string): ICAL.Time {
  const [date = start, time = null] = start.split("T");
  return timeValue(date, time);
}

function setText(component: ICAL.Component, name: string, value: string | null): void {
  component.removeAllProperties(name);
  if (value !== null) component.addPropertyWithValue(name, value);
}

function utcOffset(minutes: number): ICAL.UtcOffset {
  return ICAL.UtcOffset.fromSeconds(minutes * 60);
}

/**
 * A VTIMEZONE for an IANA zone, from luxon's rules: every offset change between one year before and 25 years after
 * `year`, grouped into one STANDARD or DAYLIGHT observance per offset pair with every change as an RDATE.
 */
export function generateVtimezone(zone: string, year: number): ICAL.Component {
  const vtimezone = new ICAL.Component("vtimezone");
  vtimezone.addPropertyWithValue("tzid", zone);
  const groups = new Map<string, { kind: string; from: number; to: number; starts: ICAL.Time[] }>();
  const observe = (instant: DateTime, from: number, to: number): void => {
    const kind = instant.isInDST ? "daylight" : "standard";
    // An observance's DTSTART is the local time of the change, in the offset before it.
    const local = DateTime.fromMillis(instant.toMillis() + from * 60_000, { zone: "UTC" });
    const start = ICAL.Time.fromData({
      year: local.year,
      month: local.month,
      day: local.day,
      hour: local.hour,
      minute: local.minute,
      second: 0,
      isDate: false,
    });
    const key = `${kind}|${from}|${to}`;
    const group = groups.get(key);
    if (group) group.starts.push(start);
    else groups.set(key, { kind, from, to, starts: [start] });
  };
  let cursor = DateTime.fromObject({ year: year - VTIMEZONE_YEARS_BEFORE, month: 1, day: 1 }, { zone });
  const end = cursor.plus({ years: VTIMEZONE_YEARS_BEFORE + VTIMEZONE_YEARS_AFTER + 1 });
  observe(cursor, cursor.offset, cursor.offset);
  while (cursor < end) {
    const next = cursor.plus({ days: 7 });
    if (next.offset !== cursor.offset) {
      let low = cursor.toMillis();
      let high = next.toMillis();
      while (high - low > 60_000) {
        const middle = low + Math.floor((high - low) / 120_000) * 60_000;
        if (DateTime.fromMillis(middle, { zone }).offset === cursor.offset) low = middle;
        else high = middle;
      }
      observe(DateTime.fromMillis(high, { zone }), cursor.offset, next.offset);
    }
    cursor = next;
  }
  for (const group of groups.values()) {
    const observance = new ICAL.Component(group.kind);
    const [first] = group.starts;
    if (first === undefined) continue;
    observance.addPropertyWithValue("dtstart", first);
    observance.addPropertyWithValue("tzoffsetfrom", utcOffset(group.from));
    observance.addPropertyWithValue("tzoffsetto", utcOffset(group.to));
    // One RDATE per onset, the first one included: ical.js reads only the first value of an RDATE, and with RDATEs
    // present it takes the onsets from them alone.
    for (const start of group.starts) observance.addPropertyWithValue("rdate", start);
    vtimezone.addSubcomponent(observance);
  }
  return vtimezone;
}

function ensureVtimezone(root: ICAL.Component, zone: SeriesZone, year: number): void {
  if (zone === null || zone === "UTC") return;
  const known = root
    .getAllSubcomponents("vtimezone")
    .some((vtimezone) => vtimezone.getFirstPropertyValue("tzid") === zone);
  if (!known) root.addSubcomponent(generateVtimezone(zone, year));
}

function writeTimes(component: ICAL.Component, fields: RemoteEventFields): void {
  component.removeAllProperties("dtstart");
  component.removeAllProperties("dtend");
  component.removeAllProperties("duration");
  if (fields.timeFrom === null) {
    component.addProperty(timeProperty("dtstart", [timeValue(fields.date, null)], null));
    component.addProperty(timeProperty("dtend", [timeValue(dayAfter(fields.endDate ?? fields.date), null)], null));
    return;
  }
  component.addProperty(timeProperty("dtstart", [timeValue(fields.date, fields.timeFrom)], fields.timeZone));
  if (fields.timeTo !== null) {
    const end = wallValue(fields.endDate ?? fields.date, fields.timeTo);
    component.addProperty(timeProperty("dtend", [end], fields.timeZone));
  }
}

function writeRecurrence(component: ICAL.Component, fields: RemoteEventFields): void {
  component.removeAllProperties("rrule");
  component.removeAllProperties("exdate");
  component.removeAllProperties("recurrence-id");
  const zone = fields.timeFrom === null ? null : fields.timeZone;
  if (fields.recurrenceRule !== null) {
    component.addPropertyWithValue("rrule", ICAL.Recur.fromString(fields.recurrenceRule));
  }
  if (fields.exceptionDates !== null && fields.exceptionDates.length > 0) {
    component.addProperty(timeProperty("exdate", fields.exceptionDates.map(localStartValue), zone));
  }
  if (fields.recurrenceId !== null) {
    component.addProperty(timeProperty("recurrence-id", [localStartValue(fields.recurrenceId)], zone));
  }
}

function writeAlert(component: ICAL.Component, minutes: number | null): void {
  const alarm = component.getAllSubcomponents("valarm").find(isDisplayAlarm);
  if (minutes === null) {
    if (alarm !== undefined) component.removeSubcomponent(alarm);
    return;
  }
  const trigger = ICAL.Duration.fromSeconds(-minutes * 60);
  if (alarm !== undefined) {
    alarm.removeAllProperties("trigger");
    alarm.addPropertyWithValue("trigger", trigger);
    return;
  }
  const created = new ICAL.Component("valarm");
  created.addPropertyWithValue("action", "DISPLAY");
  // RFC 5545 requires a DESCRIPTION on a display alarm; the Event's own name is the only text it has.
  created.addPropertyWithValue("description", textOf(component, "summary") ?? "");
  created.addPropertyWithValue("trigger", trigger);
  component.addSubcomponent(created);
}

const TIME_KEYS = ["date", "endDate", "timeFrom", "timeTo", "timeZone"] as const;
const RECURRENCE_KEYS = ["recurrenceRule", "exceptionDates", "recurrenceId"] as const;

function differs(
  current: RemoteEventFields | null,
  fields: RemoteEventFields,
  keys: readonly (keyof RemoteEventFields)[],
): boolean {
  return current === null || keys.some((key) => JSON.stringify(current[key]) !== JSON.stringify(fields[key]));
}

/** Rewrites the properties of the fields that differ from what `component` holds now. */
function writeFields(root: ICAL.Component, component: ICAL.Component, fields: RemoteEventFields): void {
  const parts = resourceParts(root);
  const current = parts === null ? null : readFields(component, parts.zone);
  const changed = (keys: readonly (keyof RemoteEventFields)[]): boolean => differs(current, fields, keys);
  const timesChanged = changed(TIME_KEYS);
  if (changed(["name"])) setText(component, "summary", fields.name);
  if (changed(["place"])) setText(component, "location", fields.place);
  if (changed(["description"])) setText(component, "description", fields.description);
  if (changed(["url"])) setText(component, "url", fields.url);
  if (timesChanged) writeTimes(component, fields);
  // The zone of the occurrence starts follows the Event's times.
  if (timesChanged || changed(RECURRENCE_KEYS)) writeRecurrence(component, fields);
  if (changed(["alertMinutes"])) writeAlert(component, fields.alertMinutes);
  if (fields.timeFrom !== null) ensureVtimezone(root, fields.timeZone, Number(fields.date.slice(0, 4)));
  component.updatePropertyWithValue("dtstamp", ICAL.Time.now().convertToZone(ICAL.Timezone.utcTimezone));
}

/** A new resource holding one Event. */
export function serializeNewResource(uid: string, fields: RemoteEventFields): string {
  const root = new ICAL.Component("vcalendar");
  root.addPropertyWithValue("version", "2.0");
  root.addPropertyWithValue("prodid", PRODUCT_ID);
  const event = new ICAL.Component("vevent");
  event.addPropertyWithValue("uid", uid);
  root.addSubcomponent(event);
  writeFields(root, event, fields);
  return root.toString();
}

/** The resource could not be read as one Event series; the caller treats it as changed under it. */
export class CalendarResourceUnreadableError extends Error {
  constructor() {
    super("The calendar resource is not a readable iCalendar Event");
    this.name = "CalendarResourceUnreadableError";
  }
}

function editableParts(text: string): ResourceParts {
  const root = parseRoot(text);
  const parts = root === null ? null : resourceParts(root);
  if (parts === null) throw new CalendarResourceUnreadableError();
  return parts;
}

function overrideFor(parts: ResourceParts, recurrenceId: string): ICAL.Component | undefined {
  return parts.overrides.find((override) => {
    const value = firstTime(override, "recurrence-id");
    return value !== null && occurrenceStart(value.time, value.property, parts.zone) === recurrenceId;
  });
}

/**
 * The resource with the series (`fields.recurrenceId` null) or the override of that occurrence set to `fields`; an
 * override the resource does not have yet is added. Returns the text and the remote id of the Event written.
 */
export function updateResource(text: string, fields: RemoteEventFields): { text: string; remoteId: string } {
  const parts = editableParts(text);
  let component: ICAL.Component | undefined;
  if (fields.recurrenceId === null) {
    component = parts.master ?? undefined;
    if (component === undefined) throw new CalendarResourceUnreadableError();
  } else {
    component = overrideFor(parts, fields.recurrenceId);
    if (component === undefined) {
      component = new ICAL.Component("vevent");
      component.addPropertyWithValue("uid", parts.uid);
      parts.root.addSubcomponent(component);
    }
  }
  writeFields(parts.root, component, fields);
  return {
    text: parts.root.toString(),
    remoteId: fields.recurrenceId === null ? parts.uid : overrideRemoteId(parts.uid, fields.recurrenceId),
  };
}

/** The resource without the occurrence `recurrenceId`: its override is removed and the series excludes it. */
export function removeOccurrence(text: string, recurrenceId: string): string {
  const parts = editableParts(text);
  const override = overrideFor(parts, recurrenceId);
  if (override !== undefined) parts.root.removeSubcomponent(override);
  if (parts.master !== null) {
    const current = readFields(parts.master, parts.zone);
    if (current === null) throw new CalendarResourceUnreadableError();
    const excluded = new Set(current.exceptionDates ?? []);
    excluded.add(recurrenceId);
    writeFields(parts.root, parts.master, { ...current, exceptionDates: [...excluded].sort() });
  }
  return parts.root.toString();
}
