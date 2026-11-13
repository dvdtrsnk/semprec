// Serializes the iTIP messages the calendar sends about an Event (issue #1774): a `REQUEST` that invites one
// person or updates an invitation, and the `CANCEL` that withdraws it. The output is one iCalendar object
// (RFC 5545) with the iTIP method of RFC 5546, lines ended by CRLF and folded at 75 octets.
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

function formatInstant(value: string, field: string): string {
  const parsed = INSTANT_PATTERN.test(value)
    ? DateTime.fromISO(value, { zone: "utc" })
    : DateTime.invalid("bad instant");
  if (!parsed.isValid) throw invalid(field, `'${field}' must be a UTC instant`);
  return formatUtc(parsed);
}

function mailto(address: string, field: string): string {
  if (!MAILTO_ADDRESS_PATTERN.test(address)) throw invalid(field, `'${field}' must be an email address`);
  return `mailto:${address}`;
}

function buildItipMessage(method: "REQUEST" | "CANCEL", input: ItipEventInput): string {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw invalid("sequence", "'sequence' must be a non-negative integer");
  }
  if (input.uid.length === 0) throw invalid("uid", "'uid' must not be empty");
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
  return lines.map(fold).join("\r\n") + "\r\n";
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
