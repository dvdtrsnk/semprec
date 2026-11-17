// Serializes iTIP (RFC 5546) REQUEST, CANCEL and REPLY messages as one iCalendar object, CRLF-ended and folded.
import { DateTime } from "luxon";
import { ValidationError } from "../errors.js";

/**
 * An all-day Event has `start` as its first day and `end` as the day after its last day (`DTEND` of a `DATE`
 * value is exclusive), both `YYYY-MM-DD`; a timed Event has UTC instants. No `VTIMEZONE` is written.
 */
export interface ItipEventInput {
  uid: string;
  /** A `CANCEL` carries the revision after the last one that was sent. */
  sequence: number;
  stamp: Date;
  title: string;
  place: string | null;
  allDay: boolean;
  start: string;
  end: string;
  organizerEmail: string;
  attendeeEmail: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
/** An address that can stand in a `mailto:` URI: one `@`, and no space, control character or iCalendar delimiter. */
const MAILTO_ADDRESS_PATTERN = /^[^\s\p{Cc}@;,<>:"\\]+@[^\s\p{Cc}@;,<>:"\\]+$/u;
const MAX_LINE_OCTETS = 75;

function invalid(field: string, message: string): ValidationError {
  return new ValidationError(message, { field });
}

/** TEXT value escaping of RFC 5545 section 3.3.11; other control characters are dropped. */
function escapeText(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, "\n")
    .replace(/[^\P{Cc}\n]/gu, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** Folds a content line at 75 octets without splitting a UTF-8 sequence; continuation lines start with one space. */
function fold(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  let currentOctets = 0;
  for (const character of line) {
    const octets = encoder.encode(character).length;
    const limit = parts.length === 0 ? MAX_LINE_OCTETS : MAX_LINE_OCTETS - 1;
    if (currentOctets + octets > limit) {
      parts.push(current);
      current = "";
      currentOctets = 0;
    }
    current += character;
    currentOctets += octets;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function formatUtc(instant: DateTime): string {
  return instant.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
}

function formatDate(date: string, field: string): string {
  const parsed = DATE_PATTERN.test(date) ? DateTime.fromISO(date, { zone: "utc" }) : DateTime.invalid("bad date");
  if (!parsed.isValid) throw invalid(field, `'${field}' must be a calendar date YYYY-MM-DD`);
  return parsed.toFormat("yyyyMMdd");
}

function instantOf(value: string, field: string): DateTime {
  const parsed = INSTANT_PATTERN.test(value)
    ? DateTime.fromISO(value, { zone: "utc" })
    : DateTime.invalid("bad instant");
  if (!parsed.isValid) throw invalid(field, `'${field}' must be a UTC instant`);
  return parsed;
}

function formatInstant(value: string, field: string): string {
  return formatUtc(instantOf(value, field));
}

function mailto(address: string, field: string): string {
  if (!MAILTO_ADDRESS_PATTERN.test(address)) throw invalid(field, `'${field}' must be an email address`);
  return `mailto:${address}`;
}

function checkIdentity(input: { uid: string; sequence: number }): void {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw invalid("sequence", "'sequence' must be a non-negative integer");
  }
  if (input.uid.length === 0) throw invalid("uid", "'uid' must not be empty");
}

function toCalendarText(lines: string[]): string {
  return lines.map(fold).join("\r\n") + "\r\n";
}

function buildItipMessage(method: "REQUEST" | "CANCEL", input: ItipEventInput): string {
  checkIdentity(input);
  if (!Number.isFinite(input.stamp.getTime())) throw invalid("stamp", "'stamp' must be a valid instant");
  const organizer = mailto(input.organizerEmail, "organizerEmail");
  const attendee = mailto(input.attendeeEmail, "attendeeEmail");
  const times = input.allDay
    ? [`DTSTART;VALUE=DATE:${formatDate(input.start, "start")}`, `DTEND;VALUE=DATE:${formatDate(input.end, "end")}`]
    : [`DTSTART:${formatInstant(input.start, "start")}`, `DTEND:${formatInstant(input.end, "end")}`];
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Semprec//Calendar//EN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${escapeText(input.uid)}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${formatUtc(DateTime.fromJSDate(input.stamp))}`,
    ...times,
    `SUMMARY:${escapeText(input.title)}`,
    ...(input.place === null || input.place === "" ? [] : [`LOCATION:${escapeText(input.place)}`]),
    `ORGANIZER:${organizer}`,
    `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:${attendee}`,
    ...(method === "CANCEL" ? ["STATUS:CANCELLED"] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return toCalendarText(lines);
}

/** A higher `sequence` updates an invitation sent before. Throws `ValidationError` on unwritable input. */
export function buildItipRequest(input: ItipEventInput): string {
  return buildItipMessage("REQUEST", input);
}

export function buildItipCancel(input: ItipEventInput): string {
  return buildItipMessage("CANCEL", input);
}

/** An invitation that is only noted (`acknowledged`) is not replied to. */
export type ItipReplyPartstat = "ACCEPTED" | "TENTATIVE" | "DECLINED";

/**
 * Times are UTC instants as an invitation stores them: for an all-day invitation midnight of the first and last
 * day (`endsAt` `null` for a single day); for a timed one `endsAt` is `null` when it had no end.
 */
export interface ItipReplyInput {
  uid: string;
  sequence: number;
  organizerEmail: string;
  attendeeEmail: string;
  attendeeName?: string;
  partstat: ItipReplyPartstat;
  summary: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
}

/** A parameter value in double quotes (RFC 5545 section 3.2); a quote becomes an apostrophe, control characters go. */
function quotedParameter(value: string): string {
  return `"${value.replace(/\p{Cc}/gu, "").replace(/"/g, "'")}"`;
}

export function buildItipReply(input: ItipReplyInput): string {
  checkIdentity(input);
  const organizer = mailto(input.organizerEmail, "organizerEmail");
  const attendee = mailto(input.attendeeEmail, "attendeeEmail");
  const start = instantOf(input.startsAt, "startsAt");
  const end = input.endsAt === null ? null : instantOf(input.endsAt, "endsAt");
  const times = input.allDay
    ? [
        `DTSTART;VALUE=DATE:${start.toFormat("yyyyMMdd")}`,
        `DTEND;VALUE=DATE:${(end ?? start).plus({ days: 1 }).toFormat("yyyyMMdd")}`,
      ]
    : [`DTSTART:${formatUtc(start)}`, ...(end === null ? [] : [`DTEND:${formatUtc(end)}`])];
  const name = input.attendeeName?.trim() ?? "";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Semprec//Calendar//EN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${escapeText(input.uid)}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${formatUtc(DateTime.now())}`,
    ...times,
    `SUMMARY:${escapeText(input.summary)}`,
    `ORGANIZER:${organizer}`,
    `ATTENDEE${name === "" ? "" : `;CN=${quotedParameter(name)}`};PARTSTAT=${input.partstat}:${attendee}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return toCalendarText(lines);
}
