// A small parser for the iCalendar (RFC 5545) subset that an iMIP invitation needs (issue gh-1929): line unfolding,
// BEGIN/END nesting, parameters, quoted values and text unescaping, with no dependency. It is a pure function over
// text that arrived by mail, so it is bounded (input size, number of VEVENTs, nesting depth) and never throws on
// its input: a text it cannot use is reported as a rejection with a reason code.
import { DateTime, IANAZone } from "luxon";

/** The largest input the parser reads, in bytes; a larger text is rejected as a whole. */
export const ICALENDAR_MAX_BYTES = 256 * 1024;

/** The most VEVENT blocks one input may hold; more are rejected as a whole. */
export const ICALENDAR_MAX_EVENTS = 10;

/** The deepest BEGIN/END nesting accepted (VCALENDAR > VEVENT > VALARM is three). */
const MAX_NESTING_DEPTH = 8;

export interface ICalendarAddress {
  /** The address without its `mailto:` prefix. */
  address: string;
  /** The `CN` parameter, or `null` when absent or empty. */
  name: string | null;
}

export interface ICalendarAttendee extends ICalendarAddress {
  /** The `PARTSTAT` parameter in upper case, or `null` when absent. */
  partStat: string | null;
}

export interface ICalendarEvent {
  uid: string;
  /** The `SEQUENCE`, `0` when the event has none. */
  sequence: number;
  summary: string | null;
  location: string | null;
  /** `true` when `DTSTART` has the value type `DATE`; then both times are at 00:00 UTC. */
  allDay: boolean;
  /** An ISO UTC instant: the start, or for an all-day event the first day at 00:00 UTC. */
  startsAt: string;
  /**
   * An ISO UTC instant: the end, or for an all-day event the last day inclusive (`DTEND` minus one day) at 00:00 UTC.
   * `null` when there is no `DTEND`, and for an all-day event of a single day.
   */
  endsAt: string | null;
  /** The IANA zone of `DTSTART`: its `TZID`, `UTC` for a UTC time or a date, the fallback zone otherwise. */
  timeZone: string;
  /** `true` when `DTSTART` named a `TZID` that is not an IANA zone, so `timeZone` is the fallback zone. */
  timeZoneFallback: boolean;
  organizer: ICalendarAddress | null;
  attendees: ICalendarAttendee[];
  hasRecurrenceRule: boolean;
  hasRecurrenceId: boolean;
}

export type ICalendarRejection = "tooLarge" | "tooManyEvents" | "malformed";

export type ICalendarParseResult =
  | {
      ok: true;
      /** The calendar `METHOD` in upper case, or `null` when the calendar has none. */
      method: string | null;
      events: ICalendarEvent[];
    }
  | { ok: false; reason: ICalendarRejection };

export interface ParseICalendarOptions {
  /** The IANA zone that a floating time (no `Z`, no `TZID`) and a time with an unknown `TZID` are read in. */
  fallbackTimeZone: string;
}

interface ContentLine {
  name: string;
  params: Map<string, string>;
  value: string;
}

/** A VEVENT as its lines named it, before the values are checked. */
interface RawEvent {
  uid?: ContentLine;
  sequence?: ContentLine;
  summary?: ContentLine;
  location?: ContentLine;
  dtStart?: ContentLine;
  dtEnd?: ContentLine;
  organizer?: ContentLine;
  attendees: ContentLine[];
  hasRecurrenceRule: boolean;
  hasRecurrenceId: boolean;
}

const NAME_PATTERN = /^[A-Za-z0-9-]+$/;

/** Splits `text` at the characters `separator` that stand outside double quotes. */
function splitOutsideQuotes(text: string, separator: string, limit = Number.POSITIVE_INFINITY): string[] {
  const parts: string[] = [];
  let start = 0;
  let inQuotes = false;
  for (let index = 0; index < text.length && parts.length < limit - 1; index += 1) {
    const char = text[index];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === separator && !inQuotes) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/** `NAME;PARAM=value:value`, or `null` for a line that is not a content line. */
function parseContentLine(line: string): ContentLine | null {
  const [head, value] = splitOutsideQuotes(line, ":", 2);
  if (head === undefined || value === undefined) return null;
  const [rawName, ...rawParams] = splitOutsideQuotes(head, ";");
  const name = rawName?.trim() ?? "";
  if (!NAME_PATTERN.test(name)) return null;
  const params = new Map<string, string>();
  for (const rawParam of rawParams) {
    const [key, paramValue] = splitOutsideQuotes(rawParam, "=", 2);
    if (key === undefined || paramValue === undefined) return null;
    const normalizedKey = key.trim().toUpperCase();
    if (!params.has(normalizedKey)) params.set(normalizedKey, unquote(paramValue));
  }
  return { name: name.toUpperCase(), params, value };
}

/** Unescapes an iCalendar TEXT value (`\n`, `\,`, `\;`, `\\`); an empty result is `null`. */
function textValue(line: ContentLine | undefined): string | null {
  if (!line) return null;
  const text = line.value.replace(/\\([\\;,nN])/g, (_match, char: string) =>
    char === "n" || char === "N" ? "\n" : char,
  );
  return text.trim() === "" ? null : text;
}

/** The address of an ORGANIZER or ATTENDEE line, or `null` when its value is not a mail address. */
function addressOf(line: ContentLine): ICalendarAddress | null {
  const address = line.value.trim().replace(/^mailto:/i, "");
  if (!/^[^\s@]+@[^\s@]+$/.test(address)) return null;
  const name = line.params.get("CN")?.trim() ?? "";
  return { address, name: name === "" ? null : name };
}

interface ParsedTime {
  kind: "date" | "utc" | "local";
  instant: DateTime;
  timeZone: string;
  fallback: boolean;
}

const DATE_PATTERN = /^\d{8}$/;
const UTC_TIME_PATTERN = /^\d{8}T\d{6}Z$/;
const LOCAL_TIME_PATTERN = /^\d{8}T\d{6}$/;
const LOCAL_FORMAT = "yyyyLLdd'T'HHmmss";

/** The DTSTART or DTEND of `line`, or `null` when its value is not a date or a date-time. */
function parseTime(line: ContentLine, fallbackTimeZone: string): ParsedTime | null {
  const value = line.value.trim();
  if (line.params.get("VALUE")?.toUpperCase() === "DATE" || DATE_PATTERN.test(value)) {
    if (!DATE_PATTERN.test(value)) return null;
    const instant = DateTime.fromFormat(value, "yyyyLLdd", { zone: "utc" });
    return instant.isValid ? { kind: "date", instant, timeZone: "UTC", fallback: false } : null;
  }
  if (UTC_TIME_PATTERN.test(value)) {
    const instant = DateTime.fromFormat(value.slice(0, -1), LOCAL_FORMAT, { zone: "utc" });
    return instant.isValid ? { kind: "utc", instant, timeZone: "UTC", fallback: false } : null;
  }
  if (!LOCAL_TIME_PATTERN.test(value)) return null;
  const tzid = line.params.get("TZID")?.trim();
  const known = tzid !== undefined && IANAZone.isValidZone(tzid);
  // A floating time has no TZID and is read in the fallback zone; only a TZID that is named and unknown is a fallback.
  const timeZone = known ? tzid : fallbackTimeZone;
  const instant = DateTime.fromFormat(value, LOCAL_FORMAT, { zone: timeZone });
  return instant.isValid ? { kind: "local", instant, timeZone, fallback: tzid !== undefined && !known } : null;
}

const SEQUENCE_PATTERN = /^\d{1,9}$/;

/** The event, or `null` when it lacks a UID or a usable DTSTART, or holds a value that is not valid. */
function finishEvent(raw: RawEvent, options: ParseICalendarOptions): ICalendarEvent | null {
  const uid = raw.uid?.value.trim() ?? "";
  if (uid === "") return null;
  let sequence = 0;
  if (raw.sequence) {
    const text = raw.sequence.value.trim();
    if (!SEQUENCE_PATTERN.test(text)) return null;
    sequence = Number(text);
  }
  const start = raw.dtStart ? parseTime(raw.dtStart, options.fallbackTimeZone) : null;
  if (!start) return null;
  const allDay = start.kind === "date";

  let endsAt: string | null = null;
  if (raw.dtEnd) {
    const end = parseTime(raw.dtEnd, options.fallbackTimeZone);
    if (!end || (end.kind === "date") !== allDay) return null;
    if (allDay) {
      // DTEND of a DATE event is exclusive: the last day is the day before it, and a single day has no end.
      const lastDay = end.instant.minus({ days: 1 });
      endsAt = lastDay.toMillis() > start.instant.toMillis() ? lastDay.toUTC().toISO() : null;
    } else {
      endsAt = end.instant.toUTC().toISO();
    }
  }
  const startsAt = start.instant.toUTC().toISO();
  if (startsAt === null) return null;

  const organizer = raw.organizer ? addressOf(raw.organizer) : null;
  const attendees = raw.attendees.flatMap((line): ICalendarAttendee[] => {
    const address = addressOf(line);
    if (!address) return [];
    const partStat = line.params.get("PARTSTAT")?.trim().toUpperCase() ?? "";
    return [{ ...address, partStat: partStat === "" ? null : partStat }];
  });
  return {
    uid,
    sequence,
    summary: textValue(raw.summary),
    location: textValue(raw.location),
    allDay,
    startsAt,
    endsAt,
    timeZone: start.timeZone,
    timeZoneFallback: start.fallback,
    organizer,
    attendees,
    hasRecurrenceRule: raw.hasRecurrenceRule,
    hasRecurrenceId: raw.hasRecurrenceId,
  };
}

/**
 * Parses the iCalendar text of an iMIP message: the calendar `METHOD` and, per `VEVENT` directly inside the
 * `VCALENDAR`, its `UID`, `SEQUENCE`, `SUMMARY`, `LOCATION`, start and end, `ORGANIZER`, `ATTENDEE` lines and whether it
 * has an `RRULE` or a `RECURRENCE-ID`. Properties of a nested component (a `VALARM`, a `VTIMEZONE`) are not the
 * event's. Never throws on `text`:
 *
 * - input over `ICALENDAR_MAX_BYTES` is rejected as `tooLarge` and more than `ICALENDAR_MAX_EVENTS` VEVENT blocks as
 *   `tooManyEvents`, in both cases as a whole;
 * - input that is not one balanced `VCALENDAR`, a line that is not a content line, or an event without a `UID` or a
 *   readable `DTSTART`, or with a `SEQUENCE`, `DTEND` or `DTSTART` it cannot read, is rejected as `malformed`.
 *
 * A time is an ISO UTC instant. A time with `Z` or a date is in `UTC`; a time with a `TZID` that luxon accepts as an
 * IANA zone is read in it; a floating time, and a time whose `TZID` is not an IANA zone, is read in
 * `options.fallbackTimeZone` (the second sets `timeZoneFallback`, so the caller can log it). `options.fallbackTimeZone`
 * must be a valid IANA zone.
 */
export function parseICalendar(text: string, options: ParseICalendarOptions): ICalendarParseResult {
  // A character takes at least one byte, so a text longer than the limit in characters is over it in bytes.
  if (text.length > ICALENDAR_MAX_BYTES || Buffer.byteLength(text, "utf8") > ICALENDAR_MAX_BYTES) {
    return { ok: false, reason: "tooLarge" };
  }
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r\n|\n|\r/);

  const stack: string[] = [];
  const events: ICalendarEvent[] = [];
  let method: string | null = null;
  let calendarSeen = false;
  let eventCount = 0;
  let raw: RawEvent | null = null;

  for (const line of lines) {
    if (line === "") continue;
    const content = parseContentLine(line);
    if (!content) return { ok: false, reason: "malformed" };

    if (content.name === "BEGIN") {
      const component = content.value.trim().toUpperCase();
      if (stack.length >= MAX_NESTING_DEPTH) return { ok: false, reason: "malformed" };
      if (stack.length === 0) {
        if (component !== "VCALENDAR" || calendarSeen) return { ok: false, reason: "malformed" };
        calendarSeen = true;
      }
      if (component === "VEVENT") {
        if (stack.length !== 1) return { ok: false, reason: "malformed" };
        eventCount += 1;
        if (eventCount > ICALENDAR_MAX_EVENTS) return { ok: false, reason: "tooManyEvents" };
        raw = { attendees: [], hasRecurrenceRule: false, hasRecurrenceId: false };
      }
      stack.push(component);
      continue;
    }

    if (content.name === "END") {
      const component = content.value.trim().toUpperCase();
      if (stack.pop() !== component) return { ok: false, reason: "malformed" };
      if (component === "VEVENT" && raw) {
        const event = finishEvent(raw, options);
        if (!event) return { ok: false, reason: "malformed" };
        events.push(event);
        raw = null;
      }
      continue;
    }

    const top = stack[stack.length - 1];
    if (top === undefined) return { ok: false, reason: "malformed" };
    if (top === "VCALENDAR" && content.name === "METHOD" && method === null) {
      method = content.value.trim().toUpperCase();
    } else if (top === "VEVENT" && raw) {
      switch (content.name) {
        case "UID":
          raw.uid ??= content;
          break;
        case "SEQUENCE":
          raw.sequence ??= content;
          break;
        case "SUMMARY":
          raw.summary ??= content;
          break;
        case "LOCATION":
          raw.location ??= content;
          break;
        case "DTSTART":
          raw.dtStart ??= content;
          break;
        case "DTEND":
          raw.dtEnd ??= content;
          break;
        case "ORGANIZER":
          raw.organizer ??= content;
          break;
        case "ATTENDEE":
          raw.attendees.push(content);
          break;
        case "RRULE":
          raw.hasRecurrenceRule = true;
          break;
        case "RECURRENCE-ID":
          raw.hasRecurrenceId = true;
          break;
      }
    }
  }
  if (stack.length !== 0 || !calendarSeen) return { ok: false, reason: "malformed" };
  return { ok: true, method: method === "" ? null : method, events };
}
