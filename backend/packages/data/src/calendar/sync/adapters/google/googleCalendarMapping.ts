// Google Calendar v3 resources as the calendar sync's payload, and Event fields as a Google event body. Google times
// are instants with the zone they were entered in (or days for an all-day Event); Events store wall clock in a zone.
import { DateTime, IANAZone } from "luxon";
import { z } from "zod";
import { formatLocalStart } from "../../../syncedEventFields.js";
import { shiftDays } from "../../../recurrenceExpansion.js";
import type { RemoteEvent, RemoteEventFields, RemoteParticipant } from "../../adapter.js";

const MAX_PARTICIPANTS = 500;

const eventTimeSchema = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional(),
});
type GoogleEventTime = z.infer<typeof eventTimeSchema>;

const personSchema = z.object({ email: z.string().optional(), displayName: z.string().optional() });
const attendeeSchema = personSchema.extend({
  optional: z.boolean().optional(),
  resource: z.boolean().optional(),
  responseStatus: z.string().optional(),
});
export const googleReminderSchema = z.object({ method: z.string(), minutes: z.number().int() });

export const googleEventSchema = z.object({
  id: z.string().min(1),
  etag: z.string().optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: eventTimeSchema.optional(),
  end: eventTimeSchema.optional(),
  recurrence: z.array(z.string()).optional(),
  recurringEventId: z.string().optional(),
  originalStartTime: eventTimeSchema.optional(),
  reminders: z
    .object({ useDefault: z.boolean().optional(), overrides: z.array(googleReminderSchema).optional() })
    .optional(),
  organizer: personSchema.optional(),
  attendees: z.array(attendeeSchema).optional(),
  source: z.object({ url: z.string().optional() }).optional(),
});
export type GoogleEvent = z.infer<typeof googleEventSchema>;
type GoogleReminder = z.infer<typeof googleReminderSchema>;

/** What the events listing says about its calendar: its zone and the default reminders of the signed-in user. */
export interface GoogleCalendarContext {
  zone: string | null;
  defaultReminders: GoogleReminder[];
}

/** The zone and kind of a series, which its exceptions and overrides are expressed in. */
export interface GoogleSeries {
  zone: string | null;
  allDay: boolean;
}

export function validZone(zone: string | undefined | null): string | null {
  return typeof zone === "string" && IANAZone.isValidZone(zone) ? zone : null;
}

export function isCancelled(event: GoogleEvent): boolean {
  return event.status === "cancelled";
}

function firstPopupMinutes(reminders: GoogleReminder[] | undefined): number | null {
  return reminders?.find((reminder) => reminder.method === "popup")?.minutes ?? null;
}

/** The zone a timed Event's times are read in: its own, else its calendar's. */
function eventZone(time: GoogleEventTime, context: GoogleCalendarContext): string | null {
  return validZone(time.timeZone) ?? context.zone;
}

function instantIn(value: string, zone: string): DateTime | null {
  const instant = DateTime.fromISO(value, { zone });
  return instant.isValid ? instant : null;
}

function isDay(value: string | undefined): value is string {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value).isValid;
}

type Schedule = Pick<RemoteEventFields, "date" | "endDate" | "timeFrom" | "timeTo" | "timeZone">;

/**
 * An all-day Event's exclusive end day becomes its last day (`endDate` only when that is after `date`). A timed
 * Event is read in its start's zone; an end on the next midnight is `24:00`, and an end not after the start leaves
 * `timeTo` empty. `null` when the times are missing or unreadable.
 */
export function googleSchedule(event: GoogleEvent, context: GoogleCalendarContext): Schedule | null {
  const { start, end } = event;
  if (start === undefined) return null;
  if (start.dateTime === undefined) {
    if (!isDay(start.date)) return null;
    const lastDay = isDay(end?.date) ? shiftDays(end.date, -1) : start.date;
    return {
      date: start.date,
      endDate: lastDay > start.date ? lastDay : null,
      timeFrom: null,
      timeTo: null,
      timeZone: null,
    };
  }
  const zone = eventZone(start, context);
  if (zone === null) return null;
  const from = instantIn(start.dateTime, zone);
  if (from === null) return null;
  const date = from.toFormat("yyyy-MM-dd");
  const timeFrom = from.toFormat("HH:mm");
  const to = end?.dateTime === undefined ? null : instantIn(end.dateTime, zone);
  if (to === null || to <= from) return { date, endDate: null, timeFrom, timeTo: null, timeZone: zone };
  const closesDay = to.toFormat("HH:mm") === "00:00";
  const lastDay = closesDay ? to.minus({ days: 1 }).toFormat("yyyy-MM-dd") : to.toFormat("yyyy-MM-dd");
  return {
    date,
    endDate: lastDay > date ? lastDay : null,
    timeFrom,
    timeTo: closesDay ? "24:00" : to.toFormat("HH:mm"),
    timeZone: zone,
  };
}

export function seriesOf(schedule: Schedule): GoogleSeries {
  return { zone: schedule.timeZone, allDay: schedule.timeFrom === null };
}

/** An original start (an override's or a cancelled instance's) as a local start of the series. */
export function googleLocalStart(time: GoogleEventTime, series: GoogleSeries): string | null {
  if (time.dateTime === undefined) return isDay(time.date) ? time.date : null;
  const zone = series.zone ?? validZone(time.timeZone);
  if (zone === null) return null;
  const instant = instantIn(time.dateTime, zone);
  if (instant === null) return null;
  const date = instant.toFormat("yyyy-MM-dd");
  return series.allDay ? date : formatLocalStart({ date, time: instant.toFormat("HH:mm") });
}

/** `20261202`, `20261202T090000` (in `zone`) or `20261202T080000Z`. */
function icalValueLocalStart(value: string, zone: string | null, series: GoogleSeries): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value.trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  const date = `${year}-${month}-${day}`;
  if (hour === undefined) return isDay(date) ? date : null;
  const sourceZone = utc === "Z" ? "UTC" : (zone ?? series.zone);
  if (sourceZone === null) return null;
  return googleLocalStart({ dateTime: `${date}T${hour}:${minute}:${second}`, timeZone: sourceZone }, series);
}

interface GoogleRecurrence {
  rule: string | null;
  exceptionDates: string[];
  /** Property names of the lines the Events model cannot hold (`RDATE`, `EXRULE`, a second `RRULE`). */
  unsupported: string[];
  /** `EXDATE` values that could not be read; left out. */
  unreadable: number;
}

/** The `RRULE` (without its prefix) and `EXDATE` values of a master's `recurrence` lines. */
export function googleRecurrence(lines: string[], series: GoogleSeries): GoogleRecurrence {
  const result: GoogleRecurrence = { rule: null, exceptionDates: [], unsupported: [], unreadable: 0 };
  for (const line of lines) {
    const colon = line.indexOf(":");
    const head = colon < 0 ? line : line.slice(0, colon);
    const [rawName = "", ...params] = head.split(";");
    const name = rawName.trim().toUpperCase();
    const value = colon < 0 ? "" : line.slice(colon + 1);
    if (name === "RRULE" && result.rule === null && value.trim() !== "") {
      result.rule = value.trim();
    } else if (name === "EXDATE") {
      const tzid = params.find((param) => param.toUpperCase().startsWith("TZID="))?.slice("TZID=".length) ?? null;
      for (const part of value.split(",")) {
        const start = icalValueLocalStart(part, validZone(tzid), series);
        if (start === null) result.unreadable += 1;
        else result.exceptionDates.push(start);
      }
    } else {
      result.unsupported.push(name === "" ? "unnamed" : name.slice(0, 32));
    }
  }
  return result;
}

function participant(
  person: z.infer<typeof personSchema>,
  role: string | null,
  status: string | null,
): RemoteParticipant {
  return { email: person.email ?? null, name: person.displayName ?? null, role, status };
}

function attendeeRole(attendee: z.infer<typeof attendeeSchema>): string {
  if (attendee.resource === true) return "resource";
  return attendee.optional === true ? "optional" : "required";
}

/**
 * A live Google event as a `RemoteEvent`. A master passes its exception dates; an override passes its series (so
 * `recurrenceId` is in the series' zone). `null` when its times cannot be read.
 */
export function googleRemoteEvent(
  event: GoogleEvent,
  context: GoogleCalendarContext,
  options: { series: GoogleSeries | null; recurrence: GoogleRecurrence | null; exceptionDates: string[] },
): RemoteEvent | null {
  const schedule = googleSchedule(event, context);
  if (schedule === null) return null;
  let recurrenceId: string | null = null;
  if (event.recurringEventId !== undefined) {
    if (event.originalStartTime === undefined || options.series === null) return null;
    recurrenceId = googleLocalStart(event.originalStartTime, options.series);
    if (recurrenceId === null) return null;
  }
  const exceptionDates = [...new Set(options.exceptionDates)].sort();
  const alertMinutes =
    event.reminders?.useDefault === false
      ? firstPopupMinutes(event.reminders.overrides)
      : firstPopupMinutes(context.defaultReminders);
  return {
    remoteId: event.id,
    href: null,
    etag: event.etag ?? null,
    seriesRemoteId: event.recurringEventId ?? null,
    fields: {
      name: event.summary ?? null,
      ...schedule,
      recurrenceRule: recurrenceId === null ? (options.recurrence?.rule ?? null) : null,
      exceptionDates: recurrenceId === null && exceptionDates.length > 0 ? exceptionDates : null,
      recurrenceId,
      place: event.location ?? null,
      description: event.description ?? null,
      url: event.source?.url ?? null,
      alertMinutes,
    },
    organizer: event.organizer === undefined ? null : participant(event.organizer, null, null),
    attendees: (event.attendees ?? [])
      .slice(0, MAX_PARTICIPANTS)
      .map((attendee) => participant(attendee, attendeeRole(attendee), attendee.responseStatus ?? null)),
  };
}

function icalDay(date: string): string {
  return date.replaceAll("-", "");
}

/**
 * An Event's fields as the body of `events.insert` or `events.patch`. `zone` is the Event's zone, or its calendar's
 * when the Event has none. Every mapped field is sent, an empty one as `null` or an empty list, so a patch clears
 * what was removed; an override carries no `recurrence`, since an instance has none of its own.
 */
export function googleEventBody(fields: RemoteEventFields, zone: string): Record<string, unknown> {
  const allDay = fields.timeFrom === null;
  let start: GoogleEventTime;
  let end: GoogleEventTime;
  if (fields.timeFrom === null) {
    start = { date: fields.date };
    end = { date: shiftDays(fields.endDate ?? fields.date, 1) };
  } else {
    const timeTo = fields.timeTo ?? fields.timeFrom;
    const endDay = fields.endDate ?? fields.date;
    start = { dateTime: `${fields.date}T${fields.timeFrom}:00`, timeZone: zone };
    end =
      timeTo === "24:00"
        ? { dateTime: `${shiftDays(endDay, 1)}T00:00:00`, timeZone: zone }
        : { dateTime: `${endDay}T${timeTo}:00`, timeZone: zone };
  }
  const body: Record<string, unknown> = {
    summary: fields.name,
    location: fields.place,
    description: fields.description,
    start,
    end,
    reminders: {
      useDefault: false,
      overrides: fields.alertMinutes === null ? [] : [{ method: "popup", minutes: fields.alertMinutes }],
    },
    source: fields.url === null ? null : { title: fields.name ?? fields.url, url: fields.url },
  };
  if (fields.recurrenceId === null) {
    const lines = fields.recurrenceRule === null ? [] : [`RRULE:${fields.recurrenceRule}`];
    if (fields.recurrenceRule !== null && fields.exceptionDates !== null && fields.exceptionDates.length > 0) {
      lines.push(
        allDay
          ? `EXDATE;VALUE=DATE:${fields.exceptionDates.map((entry) => icalDay(entry.slice(0, 10))).join(",")}`
          : `EXDATE;TZID=${zone}:${fields.exceptionDates
              .map((entry) => {
                const [date = entry, time = fields.timeFrom ?? "00:00"] = entry.split("T");
                return `${icalDay(date)}T${time.replace(":", "")}00`;
              })
              .join(",")}`,
      );
    }
    body.recurrence = lines;
  }
  return body;
}
