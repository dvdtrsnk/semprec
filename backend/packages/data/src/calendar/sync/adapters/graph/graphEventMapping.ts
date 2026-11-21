// Graph Events to the calendar sync's `RemoteEvent` and back. Graph is asked for times in UTC; each Event's own zone
// comes from `originalStartTimeZone` (a series' from its range's `recurrenceTimeZone`), and its times are stored as
// wall clock there. A zone Graph names in a way no table knows ("Customized Time Zone") is stored as `Etc/UTC`: the
// instants stay right, only a series crossing a DST change would show shifted occurrences.
import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import { shiftDays } from "../../../recurrenceExpansion.js";
import {
  CalendarSyncProviderError,
  type RemoteEvent,
  type RemoteEventFields,
  type RemoteParticipant,
} from "../../adapter.js";
import {
  graphRecurrenceOfRrule,
  graphRecurrenceSchema,
  rruleOfGraphRecurrence,
  type GraphRecurrence,
} from "./graphRecurrence.js";
import { graphZoneOfIanaZone, ianaZoneOfGraphZone } from "./graphTimeZones.js";

/** The bounds the sync's apply enforces; longer provider texts are cut rather than failing the calendar. */
const MAX_TEXT_LENGTH = 100_000;
const MAX_SHORT_TEXT_LENGTH = 2048;
const MAX_PARTICIPANTS = 500;
const FALLBACK_ZONE = "Etc/UTC";

const dateTimeTimeZoneSchema = z.object({ dateTime: z.string().max(64), timeZone: z.string().max(256).nullish() });
const emailAddressSchema = z.object({ name: z.string().nullish(), address: z.string().nullish() }).nullish();

export const graphEventSchema = z.object({
  id: z.string().min(1).max(MAX_SHORT_TEXT_LENGTH),
  "@odata.etag": z.string().max(MAX_SHORT_TEXT_LENGTH).nullish(),
  "@removed": z.object({ reason: z.string().nullish() }).nullish(),
  type: z.enum(["singleInstance", "occurrence", "exception", "seriesMaster"]).nullish(),
  seriesMasterId: z.string().max(MAX_SHORT_TEXT_LENGTH).nullish(),
  subject: z.string().nullish(),
  body: z.object({ contentType: z.string().nullish(), content: z.string().nullish() }).nullish(),
  start: dateTimeTimeZoneSchema.nullish(),
  end: dateTimeTimeZoneSchema.nullish(),
  isAllDay: z.boolean().nullish(),
  isCancelled: z.boolean().nullish(),
  isReminderOn: z.boolean().nullish(),
  reminderMinutesBeforeStart: z.number().int().nullish(),
  location: z.object({ displayName: z.string().nullish() }).nullish(),
  onlineMeeting: z.object({ joinUrl: z.string().nullish() }).nullish(),
  organizer: z.object({ emailAddress: emailAddressSchema }).nullish(),
  attendees: z
    .array(
      z.object({
        type: z.string().nullish(),
        status: z.object({ response: z.string().nullish() }).nullish(),
        emailAddress: emailAddressSchema,
      }),
    )
    .nullish(),
  iCalUId: z.string().nullish(),
  isOrganizer: z.boolean().nullish(),
  responseStatus: z.object({ response: z.string().nullish() }).nullish(),
  originalStart: z.string().max(64).nullish(),
  originalStartTimeZone: z.string().max(256).nullish(),
  recurrence: graphRecurrenceSchema.nullish(),
});
export type GraphEvent = z.infer<typeof graphEventSchema>;

function invalidResponse(): CalendarSyncProviderError {
  return new CalendarSyncProviderError("invalidResponse", "Microsoft Graph sent an unusable Event");
}

function text(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
}

/** An instant Graph sent as `dateTimeTimeZone` (asked for in UTC; another zone it names is honoured). */
function instantOf(value: { dateTime: string; timeZone?: string | null | undefined }): DateTime {
  const zone = ianaZoneOfGraphZone(value.timeZone) ?? FALLBACK_ZONE;
  const instant = DateTime.fromISO(value.dateTime, { zone });
  if (!instant.isValid) throw invalidResponse();
  return instant;
}

/** The zone an Event's times are stored in; `preferredZone` (the tenant's) wins over an equivalent table entry. */
export function zoneOfGraphEvent(event: GraphEvent, preferredZone?: string): string {
  return (
    ianaZoneOfGraphZone(event.recurrence?.range.recurrenceTimeZone, preferredZone) ??
    ianaZoneOfGraphZone(event.originalStartTimeZone, preferredZone) ??
    FALLBACK_ZONE
  );
}

/**
 * The day an all-day boundary names. Graph may send it as midnight unconverted, or converted from the Event's zone
 * into the requested UTC; a value that is not midnight is read back in the Event's zone.
 */
function allDayDate(value: { dateTime: string; timeZone?: string | null | undefined }, zone: string): string {
  const instant = instantOf(value);
  const local = instant.hour === 0 && instant.minute === 0 ? instant : instant.setZone(zone);
  const date = local.toISODate();
  if (date === null) throw invalidResponse();
  return date;
}

function wallClock(instant: DateTime, zone: string): { date: string; time: string } {
  const local = instant.setZone(zone);
  const date = local.toISODate();
  if (date === null) throw invalidResponse();
  return { date, time: local.toFormat("HH:mm") };
}

type Schedule = Pick<RemoteEventFields, "date" | "endDate" | "timeFrom" | "timeTo">;

/**
 * Stored like the Events database keeps it: an all-day Event names its last day in `endDate` (or none for one day);
 * a timed one ending on its start day has no `endDate`, and one ending at the next midnight ends at `24:00`.
 */
function scheduleOf(event: GraphEvent, zone: string): Schedule {
  if (!event.start || !event.end) throw invalidResponse();
  if (event.isAllDay) {
    const date = allDayDate(event.start, zone);
    const endExclusive = allDayDate(event.end, zone);
    const lastDay = endExclusive > date ? shiftDays(endExclusive, -1) : date;
    return { date, endDate: lastDay > date ? lastDay : null, timeFrom: null, timeTo: null };
  }
  const startInstant = instantOf(event.start);
  const endInstant = instantOf(event.end);
  const start = wallClock(startInstant, zone);
  const end = wallClock(endInstant, zone);
  if (endInstant <= startInstant || (end.date === start.date && end.time <= start.time)) {
    return { date: start.date, endDate: null, timeFrom: start.time, timeTo: null };
  }
  if (end.time === "00:00" && shiftDays(end.date, -1) === start.date) {
    return { date: start.date, endDate: null, timeFrom: start.time, timeTo: "24:00" };
  }
  return { date: start.date, endDate: end.date > start.date ? end.date : null, timeFrom: start.time, timeTo: end.time };
}

/** A local start in `zone`: the day for an all-day series, `YYYY-MM-DDTHH:MM` otherwise. */
export function localStartOf(instant: DateTime, zone: string, allDay: boolean): string {
  const local = wallClock(instant, zone);
  return allDay ? local.date : `${local.date}T${local.time}`;
}

/** The start an occurrence or exception had before any change; Graph's `originalStart` is an ISO instant. */
export function originalStartOf(event: GraphEvent): DateTime | null {
  if (event.originalStart) {
    const instant = DateTime.fromISO(event.originalStart, { setZone: true });
    if (!instant.isValid) throw invalidResponse();
    return instant;
  }
  return event.type === "occurrence" && event.start ? instantOf(event.start) : null;
}

function participant(
  emailAddress: z.infer<typeof emailAddressSchema>,
  role: string | null,
  status: string | null,
): RemoteParticipant {
  return {
    email: text(emailAddress?.address, MAX_SHORT_TEXT_LENGTH),
    name: text(emailAddress?.name, MAX_SHORT_TEXT_LENGTH),
    role,
    status,
  };
}

export interface GraphEventPlacement {
  /** The master's id, for an override. */
  seriesRemoteId: string | null;
  /** The zone the Event is stored in: its own, or the series' for an override. */
  zone: string;
  recurrenceRule: string | null;
  exceptionDates: string[] | null;
  recurrenceId: string | null;
}

export function remoteEventOf(event: GraphEvent, placement: GraphEventPlacement): RemoteEvent {
  const { zone } = placement;
  return {
    remoteId: event.id,
    href: null,
    etag: event["@odata.etag"] ?? null,
    seriesRemoteId: placement.seriesRemoteId,
    fields: {
      name: text(event.subject, MAX_TEXT_LENGTH),
      ...scheduleOf(event, zone),
      timeZone: zone,
      recurrenceRule: placement.recurrenceRule,
      exceptionDates: placement.exceptionDates,
      recurrenceId: placement.recurrenceId,
      place: text(event.location?.displayName, MAX_TEXT_LENGTH),
      description: text(event.body?.content, MAX_TEXT_LENGTH),
      url: text(event.onlineMeeting?.joinUrl, MAX_TEXT_LENGTH),
      alertMinutes:
        event.isReminderOn &&
        typeof event.reminderMinutesBeforeStart === "number" &&
        event.reminderMinutesBeforeStart >= 0
          ? event.reminderMinutesBeforeStart
          : null,
    },
    organizer: event.organizer ? participant(event.organizer.emailAddress, null, null) : null,
    attendees: (event.attendees ?? [])
      .slice(0, MAX_PARTICIPANTS)
      .map((attendee) =>
        participant(
          attendee.emailAddress,
          text(attendee.type, MAX_SHORT_TEXT_LENGTH),
          text(attendee.status?.response, MAX_SHORT_TEXT_LENGTH),
        ),
      ),
    icalUid: event.iCalUId && event.iCalUId.length <= MAX_SHORT_TEXT_LENGTH ? event.iCalUId : null,
    // The attendee's own copy reports its answer here; `attendees` there need not.
    selfStatus: event.isOrganizer === true ? null : text(event.responseStatus?.response, MAX_SHORT_TEXT_LENGTH),
  };
}

/** The RRULE of a series master, `null` when Graph's pattern is incomplete. */
export function rruleOfGraphMaster(master: GraphEvent, zone: string): string | null {
  if (!master.recurrence || !master.start) return null;
  const start = master.isAllDay ? allDayDate(master.start, zone) : wallClock(instantOf(master.start), zone).date;
  return rruleOfGraphRecurrence(master.recurrence, { start, allDay: master.isAllDay === true, zone });
}

/** The series' start in its zone: the first occurrence, which Graph puts in the master's `start`. */
export function seriesStartOf(master: GraphEvent, zone: string): { date: string; time: string } {
  if (!master.start) throw invalidResponse();
  if (master.isAllDay) return { date: allDayDate(master.start, zone), time: "00:00" };
  return wallClock(instantOf(master.start), zone);
}

function graphDateTime(date: string, time: string, graphZone: string): { dateTime: string; timeZone: string } {
  return { dateTime: `${date}T${time}:00`, timeZone: graphZone };
}

export interface GraphEventBody {
  subject: string;
  body: { contentType: "text"; content: string };
  location: { displayName: string };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isAllDay: boolean;
  isReminderOn: boolean;
  reminderMinutesBeforeStart?: number;
  recurrence?: GraphRecurrence;
}

/**
 * The Graph body of an Event's fields. An Event without a zone of its own is written in `tenantZone`, the zone its
 * times are wall clock in. `url` is not written: Graph sets an online meeting's link itself.
 */
export function graphEventBodyOf(fields: RemoteEventFields, tenantZone: string): GraphEventBody {
  const allDay = fields.timeFrom === null;
  const zone = fields.timeZone ?? tenantZone;
  const graphZone = graphZoneOfIanaZone(zone);
  const lastDay = fields.endDate ?? fields.date;
  let start: GraphEventBody["start"];
  let end: GraphEventBody["end"];
  if (allDay) {
    start = graphDateTime(fields.date, "00:00", graphZone);
    end = graphDateTime(shiftDays(lastDay, 1), "00:00", graphZone);
  } else {
    const timeFrom = fields.timeFrom!;
    start = graphDateTime(fields.date, timeFrom, graphZone);
    end =
      fields.timeTo === null
        ? start
        : fields.timeTo === "24:00"
          ? graphDateTime(shiftDays(lastDay, 1), "00:00", graphZone)
          : graphDateTime(lastDay, fields.timeTo, graphZone);
  }
  return {
    subject: fields.name ?? "",
    body: { contentType: "text", content: fields.description ?? "" },
    location: { displayName: fields.place ?? "" },
    start,
    end,
    isAllDay: allDay,
    isReminderOn: fields.alertMinutes !== null,
    ...(fields.alertMinutes !== null ? { reminderMinutesBeforeStart: fields.alertMinutes } : {}),
    ...(fields.recurrenceRule !== null
      ? { recurrence: graphRecurrenceOfRrule(fields.recurrenceRule, { startDate: fields.date, zone, graphZone }) }
      : {}),
  };
}

/**
 * The same local Event (`createKey`) with the same fields in the same calendar gives the same id, so a create Graph
 * received but whose answer was lost is not made twice when the write is retried; two local Events with equal fields
 * get different ids. The fields are part of the id because Graph may answer a known id with the Event as it was first
 * made: a repeat after the Event changed here is a create of its own.
 */
export function graphTransactionIdOf(
  calendarRemoteId: string,
  createKey: string | null,
  fields: RemoteEventFields,
): string {
  return createHash("sha256")
    .update(calendarRemoteId)
    .update("\n")
    .update(createKey ?? "")
    .update("\n")
    .update(JSON.stringify(fields))
    .digest("hex")
    .slice(0, 32);
}
