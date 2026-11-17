import type { PoolClient } from "pg";
import type { WallClock } from "../calendarTime.js";
import type { EventTaskCounts, EventTaskRow, EventTaskState } from "../tasks/taskStateInEvent.js";
import { readBirthdayTimelineItems } from "./timelineBirthdaySource.js";
import { readHolidayTimelineItems } from "./timelineHolidaySource.js";
import { readEventTimelineItems, readTaskTimelineItems } from "./timelineRead.js";
import { readEventOccurrenceTimelineItems } from "./timelineEventOccurrenceSource.js";
import { readSleepTimelineItems } from "./timelineSleepSource.js";
import { readSubscribedEventTimelineItems } from "./timelineSubscribedEventSource.js";
import { readTaskOccurrenceTimelineItems } from "./timelineTaskOccurrenceSource.js";
import { readTaskTraceTimelineItems } from "./timelineTaskTraceSource.js";

/** The live dated host event the task was added to last; it decides the Task's day in the timeline. */
export interface CalendarTimelineHostEvent {
  id: string;
  title: string;
  ended: boolean;
  date: string;
  timeFrom: string | null;
  timeTo: string | null;
  state: EventTaskState;
}

export interface CalendarTimelineItem {
  kind: "event" | "task";
  id: string;
  databaseId: string;
  title: string;
  type: string | null;
  date: string;
  endDate: string | null;
  timeFrom: string | null;
  timeTo: string | null;
  /**
   * Wall-clock end on the last day (`24:00` closes the day). A timed Task without `timeTo` ends at its `timeFrom`,
   * a timed Event at the last minute of its last day. A stored time is returned as stored even when a
   * daylight-saving change skips it.
   */
  effectiveTo: string | null;
  hasEnd: boolean;
  allDay: boolean;
  /** An Event without a `calendar` edge falls back to the default calendar; a Task uses the `tasks` calendar. */
  calendarId: string | null;
  status: string | null;
  place: string | null;
  project: { id: string; name: string; color: string | null } | null;
  people: { id: string; name: string }[];
  /** Of several live transcripts, the first in relation order. */
  transcript: { id: string; status: string | null } | null;
  hostEvent: CalendarTimelineHostEvent | null;
  /**
   * As `GET /api/events/:id/tasks` lists them. A virtual occurrence carries those of its series Event, a changed
   * one those of its own item.
   */
  tasks: EventTaskRow[] | null;
  counts: EventTaskCounts | null;
  /** The first planned day of a carried-forward Task; `null` once it was done before today. */
  carriedFrom: string | null;
  /** Filled by `readCalendarTimeline` after the sources have read their items. */
  attendance: "tentative" | null;
  updatedAt: string;
  /** The item's `version`; a write passes it back as `ifVersion`. */
  version: string;
  /** `true` for an entry that is not a stored row, or whose row no client may edit (a subscribed event). */
  readOnly: boolean;
}

/**
 * A virtual occurrence has id `<seriesId>@<date>` and is read-only; a client materializes it
 * (`POST /api/events/series/:seriesId/occurrences/:date`) before editing. An `overridden` one is its own item.
 */
export interface CalendarEventOccurrence extends CalendarTimelineItem {
  kind: "event";
  seriesId: string;
  /** The rule's day; a moved item keeps it. */
  occurrenceDate: string;
  overridden: boolean;
}

/**
 * A virtual occurrence has id `<seriesId>@<date>`, is read-only and carries the series template with status
 * `notDone` (`missed` before today). `date` is always the `occurrenceDate`, even for an item whose own `date`
 * changed. Items of a series no longer projected are returned this way too.
 */
export interface CalendarTaskOccurrence extends CalendarTimelineItem {
  kind: "task";
  seriesId: string;
  occurrenceDate: string;
  done: boolean;
  overridden: boolean;
}

/** Derived on read from `People.birthday`; its `id` is not an item id, so the item routes refuse it. */
export interface CalendarBirthdayTimelineItem {
  kind: "birthday";
  /** `birthday:<personId>:<year>`. */
  id: string;
  personId: string;
  /** The whole name; `title` carries the given name. */
  personName: string;
  title: string;
  date: string;
  allDay: true;
  calendarId: string | null;
  readOnly: true;
}

/** Computed, not stored; its `id` is not an item id, so the item routes refuse it. */
export interface CalendarHolidayTimelineItem {
  kind: "holiday";
  /** `holiday:cz:<YYYY-MM-DD>`. */
  id: string;
  title: string;
  date: string;
  allDay: true;
  calendarId: string | null;
  readOnly: true;
}

/**
 * Derived on read; its `id` is not an item id, yet it is not read-only: the night is edited on its own. `night`
 * is the date of its evening.
 */
export interface CalendarSleepTimelineItem {
  kind: "sleep";
  /** `sleep:<night>`. */
  id: string;
  night: string;
  planId: string | null;
  bedTime: string;
  wakeTime: string;
  alarm: boolean;
  changed: boolean;
  /** ISO with the tenant zone's offset. */
  bedAt: string;
  wakeAt: string;
  prepReminderAt: string | null;
  readOnly: false;
}

/** How the chain of a carried-over Task ended or stands; the same on every trace of the Task. */
export type CalendarTaskTraceOutcome =
  | { kind: "carried" }
  | { kind: "doneOn"; date: string }
  | { kind: "movedToEvent"; id: string; title: string }
  | { kind: "missed" };

/**
 * A past day on which a Task was planned and not done, derived from its `since`; its `id` is not an item id.
 * Only the `firstDay` trace carries the time the Task had then; later ones are all-day.
 */
export interface CalendarTaskTraceTimelineItem {
  kind: "trace";
  /** `trace:<taskId>:<day>`. */
  id: string;
  taskId: string;
  day: string;
  /** May be before the requested range. */
  firstDay: string;
  sinceTime: { from: string | null; to: string | null } | null;
  outcome: CalendarTaskTraceOutcome;
  readOnly: true;
}

export type CalendarDerivedTimelineItem =
  | CalendarBirthdayTimelineItem
  | CalendarHolidayTimelineItem
  | CalendarSleepTimelineItem
  | CalendarTaskTraceTimelineItem;

export type CalendarTimelineEntry =
  CalendarTimelineItem | CalendarEventOccurrence | CalendarTaskOccurrence | CalendarDerivedTimelineItem;

export interface CalendarTimelineContext {
  from: string;
  /** Inclusive. */
  to: string;
  timezone: string;
  today: string;
  now: WallClock;
  /** The instant `today` and `now` are read from. */
  at: Date;
  /** `false` for a caller without access to the sensitive sleep databases (an ungranted run, an `/mcp` session). */
  includeSleep: boolean;
}

export interface CalendarTimelineSource {
  id: string;
  readItems(client: PoolClient, context: CalendarTimelineContext): Promise<CalendarTimelineEntry[]>;
}

/**
 * The merge sorts, so this order does not matter. This module and `timelineRead.ts` import each other; the core
 * readers are function declarations and the list is read only at call time, so either module can load first.
 */
export const CALENDAR_TIMELINE_SOURCES: readonly CalendarTimelineSource[] = [
  { id: "events", readItems: readEventTimelineItems },
  { id: "tasks", readItems: readTaskTimelineItems },
  { id: "birthdays", readItems: readBirthdayTimelineItems },
  { id: "holidays", readItems: readHolidayTimelineItems },
  { id: "sleep", readItems: readSleepTimelineItems },
  { id: "eventOccurrences", readItems: readEventOccurrenceTimelineItems },
  { id: "taskTraces", readItems: readTaskTraceTimelineItems },
  { id: "taskOccurrences", readItems: readTaskOccurrenceTimelineItems },
  { id: "subscribedEvents", readItems: readSubscribedEventTimelineItems },
];
