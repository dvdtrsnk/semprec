// Serializes the iTIP messages the calendar sends about an Event: a `REQUEST` that invites one person or updates an
// invitation and the `CANCEL` that withdraws it (issue #1774), and the `REPLY` with which an invited person answers
// an organizer's invitation (issue gh-1953). The output is one iCalendar object (RFC 5545) with the iTIP method of
// RFC 5546, lines ended by CRLF and folded at 75 octets.
import { DateTime } from "luxon";
import { ValidationError } from "../errors.js";

/**
 * What a message says about one Event and one invited person. Times are already converted to what the message
 * carries: an all-day Event has `start` as its first day and `end` as the day after its last day (`DTEND` of a
 * `DATE` value is exclusive), both `YYYY-MM-DD`; a timed Event has `start` and `end` as UTC instants
 * (`2026-11-16T09:00:00.000Z`). No `VTIMEZONE` is written.
 */
export interface ItipEventInput {
  uid: string;
  /** The `SEQUENCE` the message carries; a `CANCEL` carries the revision after the last one that was sent. */
  sequence: number;
  /** The `DTSTAMP`, the moment the message is made. */
  stamp: Date;
  title: string;
  /** The `LOCATION`; `null` or empty leaves the property out. */
  place: string | null;
  allDay: boolean;
  start: string;
  end: string;
  /** The sending mailbox's address. */
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

/** The lines of one iCalendar object, folded and ended by CRLF. */
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

/**
 * The `METHOD:REQUEST` message that invites `attendeeEmail` to the Event or, with a higher `sequence`, updates
 * an invitation sent before. The attendee is asked to reply (`RSVP=TRUE`, `PARTSTAT=NEEDS-ACTION`). Refuses
 * with `validation_failed` an input whose sequence, UID, stamp, times or addresses cannot be written.
 */
export function buildItipRequest(input: ItipEventInput): string {
  return buildItipMessage("REQUEST", input);
}

/**
 * The `METHOD:CANCEL` message that withdraws the invitation of `attendeeEmail`: the same `UID`, the revision
 * in `sequence` and `STATUS:CANCELLED`. Refuses the same inputs as `buildItipRequest`.
 */
export function buildItipCancel(input: ItipEventInput): string {
  return buildItipMessage("CANCEL", input);
}

/** The `PARTSTAT` values a `REPLY` carries; an invitation that is only noted (`acknowledged`) is not replied to. */
export type ItipReplyPartstat = "ACCEPTED" | "TENTATIVE" | "DECLINED";

/**
 * What an invited person's answer says about the invitation. `startsAt` and `endsAt` are UTC instants
 * (`2026-10-22T11:00:00.000Z`) as an invitation stores them: for an all-day invitation `startsAt` is midnight of the
 * first day and `endsAt` midnight of the last day, `null` for a single day; for a timed one `endsAt` is `null` when the
 * invitation had no end. `sequence` is the revision of the invitation that is answered.
 */
export interface ItipReplyInput {
  uid: string;
  sequence: number;
  /** The address the reply is sent to. */
  organizerEmail: string;
  /** The address of the person who answers. */
  attendeeEmail: string;
  /** The `CN` of the attendee; left out when absent or blank. */
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

/**
 * The `METHOD:REPLY` message of the invited person `attendeeEmail`: the invitation's `UID` and `SEQUENCE`, a
 * `DTSTAMP` of the moment it is made, the original `DTSTART` and `DTEND` (an all-day invitation as `DATE` values with
 * the day after its last day as the exclusive end; no `DTEND` for a timed invitation that had none), and one
 * `ATTENDEE` carrying the `PARTSTAT`. Refuses with `validation_failed` an input whose sequence, UID, times or
 * addresses cannot be written.
 */
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
