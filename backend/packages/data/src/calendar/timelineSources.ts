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

/**
 * The Event that decided the day of a Task in the timeline (issue gh-1880): the live host event with a `date` that
 * the task was added to last. `ended` is whether the Event's end in the tenant zone is at or before the timeline's
 * instant, and `state` is the task's state in that Event as `GET /api/events/:id/tasks` reports it.
 */
export interface CalendarTimelineHostEvent {
  id: string;
  title: string;
  ended: boolean;
  date: string;
  timeFrom: string | null;
  timeTo: string | null;
  state: EventTaskState;
}

/** One entry of the calendar timeline in its full shape (issue #1717). */
export interface CalendarTimelineItem {
  kind: "event" | "task";
  /** The id of the stored item. A source whose entries are not stored rows gives each an id of its own. */
  id: string;
  databaseId: string;
  title: string;
  /** The Event type; `null` for a Task. */
  type: string | null;
  /** The first day, `YYYY-MM-DD`. */
  date: string;
  /** The stored last day of an Event; `null` when it has none, and for a Task. */
  endDate: string | null;
  timeFrom: string | null;
  timeTo: string | null;
  /**
   * The end time of a timed item by the rules of the calendar time module (`eventEnd`, `taskEffectiveEnd`),
   * as the wall-clock time on its last day: `HH:MM`, or `24:00` for the midnight that closes that day. It is
   * the `timeTo` when one is stored. A timed Task without a `timeTo` ends at its `timeFrom`; a timed Event
   * without one ends with the last minute of its last day. A stored time is returned as stored, also when
   * the tenant zone skips it on that day (a daylight-saving change). `null` for an all-day item.
   */
  effectiveTo: string | null;
  /** Whether a `timeTo` is stored. */
  hasEnd: boolean;
  /** No `timeFrom`. */
  allDay: boolean;
  /**
   * An Event's calendar: the target of its `calendar` edge, or the live default calendar when it has no edge.
   * A Task's calendar is the live calendar with the system key `tasks`. `null` when there is none.
   */
  calendarId: string | null;
  /** The Task status; `null` for an Event. */
  status: string | null;
  /** The Event place; `null` for a Task. */
  place: string | null;
  /** The live project the item is linked to; `null` without one. */
  project: { id: string; name: string; color: string | null } | null;
  /** The live people the item is linked to. */
  people: { id: string; name: string }[];
  /**
   * A stored Event's live transcript (issue #1721): of several, the first in the order of the Event's
   * `transcript` relation. `status` is the transcript's stored `status` when that is a string, else `null`.
   * `null` for an Event without a live transcript, and for a Task.
   */
  transcript: { id: string; status: string | null } | null;
  /**
   * The host event of a Task that sits in at least one live Event with a date (issue gh-1880); `null` for a Task
   * in no such Event and for an Event.
   */
  hostEvent: CalendarTimelineHostEvent | null;
  /**
   * The tasks that sit in a stored Event, with their states in it, as `GET /api/events/:id/tasks` lists them (issue
   * gh-1880). An occurrence of a recurring Event carries those of its stored Event: its own item for a changed
   * occurrence, the series Event for a virtual one. `null` for a Task.
   */
  tasks: EventTaskRow[] | null;
  /** The counts of `tasks`, as `GET /api/events/:id/tasks` reports them; `null` for a Task. */
  counts: EventTaskCounts | null;
  /**
   * The first planned day of a Task that was carried forward (issue gh-1884): its stored `since`, whenever that is
   * a calendar date and the Task is not done on a day earlier than today. `null` for an Event, for a Task without a
   * `since`, and for a Task done before today.
   */
  carriedFrom: string | null;
  /**
   * How the user answered an invitation that created this Event (issue gh-2008): `"tentative"` when a live
   * invitation whose `status` is `tentative` links to it through its `event` relation, otherwise `null`. Always
   * `null` for a Task and for an entry that is not a stored Event. `readCalendarTimeline` fills it after the sources
   * have read their items.
   */
  attendance: "tentative" | null;
  /** The stored item's `updatedAt`, which a write passes back as `ifVersion`. */
  updatedAt: string;
  /**
   * `false` for a stored Event or Task; a source sets `true` on an entry that is not a stored row or whose row no
   * client may edit (a subscribed event, issue gh-2005, a stored row of the `subscribedEvents` database whose `id` is
   * an item id: docs/adr/2026-11-14-a-subscribed-event-in-the-timeline-is-a-read-only-stored-row.md).
   */
  readOnly: boolean;
}

/**
 * One occurrence of a recurring Event (issue gh-1877), in the full shape of an Event. A virtual occurrence is not a
 * stored row: its `id` is `<seriesId>@<date>` (`formatOccurrenceId`), `readOnly` is `true` and `overridden` is
 * `false`, and a client materializes it (`POST /api/events/series/:seriesId/occurrences/:date`) before it edits it.
 * An occurrence that has an item of its own is that item: its `id` is the item's, `readOnly` is `false` and
 * `overridden` is `true`. `date` and `endDate` are those of the occurrence, which for an item are its stored values.
 */
export interface CalendarEventOccurrence extends CalendarTimelineItem {
  kind: "event";
  /** The id of the series Event. */
  seriesId: string;
  /** The day the series rule assigns to the occurrence; a moved item keeps it. */
  occurrenceDate: string;
  overridden: boolean;
}

/**
 * One occurrence of a recurring Task (issue gh-1886), in the full shape of a Task. A virtual occurrence is not a stored
 * row: its `id` is `<seriesId>@<date>` (`projectTaskOccurrences`), `readOnly` is `true` and `overridden` is `false`, and it
 * carries the series template with the status `notDone`, or `missed` for a day before today. An occurrence that has an
 * item of its own is that item: its `id` is the item's, `readOnly` is `false` and `overridden` is `true`. `date` is the
 * day the occurrence is displayed on, its `occurrenceDate`, also for an item whose own `date` was changed. An item of a series
 * that no series projects any more (turned off and started again, or deleted) is the history of that series and is also
 * returned this way, as it stays an item with its `seriesId`.
 */
export interface CalendarTaskOccurrence extends CalendarTimelineItem {
  kind: "task";
  /** The id of the series. */
  seriesId: string;
  /** The day the series rule assigns to the occurrence. */
  occurrenceDate: string;
  /** Whether the Task `status` is `done`. */
  done: boolean;
  overridden: boolean;
}

/**
 * A person's birthday in one year (issue #1800), derived on read from `People.birthday`: it is not a stored
 * row, so its `id` is not an item id and the item routes refuse it. Only the month and day of the stored
 * birthday matter; `date` is that day in the year of the entry (28 February for a 29 February in a year that
 * is not a leap year).
 */
export interface CalendarBirthdayTimelineItem {
  kind: "birthday";
  /** `birthday:<personId>:<year>`. */
  id: string;
  personId: string;
  /** The person's whole name; `title` carries the given name. */
  personName: string;
  /** The `calendar.birthday.title` template of the tenant user's language with the person's given name. */
  title: string;
  date: string;
  allDay: true;
  /** The live Birthdays calendar; `null` when the tenant has none. */
  calendarId: string | null;
  readOnly: true;
}

/**
 * A Czech public holiday (issue #1804), computed by `czechPublicHolidays` and not stored: its `id` is not an
 * item id, so the item routes refuse it.
 */
export interface CalendarHolidayTimelineItem {
  kind: "holiday";
  /** `holiday:cz:<YYYY-MM-DD>`. */
  id: string;
  /** The `calendar.holiday.<key>` entry of the tenant user's language. */
  title: string;
  date: string;
  allDay: true;
  /** The live `holidaysCz` calendar; `null` when the tenant has none. */
  calendarId: string | null;
  readOnly: true;
}

/**
 * One planned night of sleep (issue #1806), derived on read from the sleep plans and night exceptions by
 * `resolveSleepNights` and not stored: its `id` is not an item id. It is not read-only: the night is edited on
 * its own. A night that crosses midnight is one entry; `night` is the calendar date of its evening.
 */
export interface CalendarSleepTimelineItem {
  kind: "sleep";
  /** `sleep:<night>`. */
  id: string;
  night: string;
  /** The plan the night follows; `null` for a night that only has an exception. */
  planId: string | null;
  /** `HH:MM`. */
  bedTime: string;
  /** `HH:MM`. */
  wakeTime: string;
  alarm: boolean;
  /** Whether an exception overrides a field of the night. */
  changed: boolean;
  /** The bedtime instant as an ISO string with the tenant zone's offset. */
  bedAt: string;
  /** The wake-up instant, rendered like `bedAt`. */
  wakeAt: string;
  /** `bedAt` minus the reminder lead time; `null` when the reminder is off. */
  prepReminderAt: string | null;
  readOnly: false;
}

/**
 * How the chain of a carried-over Task ended or stands (issue gh-1884), the same on every trace of the Task: `doneOn`
 * the Task was completed on `date` (its `completedOn`), `missed` its status is `missed`, `movedToEvent` it sits in the
 * host event `id` named `title`, and `carried` it was only moved on to the next day.
 */
export type CalendarTaskTraceOutcome =
  | { kind: "carried" }
  | { kind: "doneOn"; date: string }
  | { kind: "movedToEvent"; id: string; title: string }
  | { kind: "missed" };

/**
 * One past day on which a Task was planned and not done (issue gh-1884), derived on read from the stored `since` of
 * the Task: it is not a stored row, so its `id` is not an item id and the item routes refuse it. A Task has one trace
 * for each day from `firstDay` up to the day before its live day, and none for a day that is not over yet. The trace
 * of `firstDay` carries the time the Task had then; the later ones are all-day.
 */
export interface CalendarTaskTraceTimelineItem {
  kind: "trace";
  /** `trace:<taskId>:<day>`. */
  id: string;
  taskId: string;
  /** The day the trace marks. */
  day: string;
  /** The Task's stored `since`, the first day of its chain, also when it is before the requested range. */
  firstDay: string;
  /** The stored `sinceTime` on the trace of `firstDay`; `null` on every other trace and for a Task without one. */
  sinceTime: { from: string | null; to: string | null } | null;
  outcome: CalendarTaskTraceOutcome;
  readOnly: true;
}

/** An entry that is not a stored row: the shape of each derived `kind` is added here by the source that returns it. */
export type CalendarDerivedTimelineItem =
  | CalendarBirthdayTimelineItem
  | CalendarHolidayTimelineItem
  | CalendarSleepTimelineItem
  | CalendarTaskTraceTimelineItem;

/** Everything a source may return: a stored Event or Task, or a derived entry. `kind` tells them apart. */
export type CalendarTimelineEntry =
  CalendarTimelineItem | CalendarEventOccurrence | CalendarTaskOccurrence | CalendarDerivedTimelineItem;

/** What every source of one timeline read is given: the requested range and the tenant's zone, day and time. */
export interface CalendarTimelineContext {
  /** The first day of the range, `YYYY-MM-DD`. */
  from: string;
  /** The last day of the range; the range includes it. */
  to: string;
  /** The tenant time zone. */
  timezone: string;
  /** The current day in `timezone`. */
  today: string;
  /** The current wall-clock date and time in `timezone`. */
  now: WallClock;
  /** The instant `today` and `now` are read from, to the millisecond. */
  at: Date;
}

/** One source of timeline entries: it returns the entries it has for the range of `context`. */
export interface CalendarTimelineSource {
  id: string;
  readItems(client: PoolClient, context: CalendarTimelineContext): Promise<CalendarTimelineEntry[]>;
}

/**
 * The sources `readCalendarTimeline` merges, in the order it reads them. The order of the merged items does
 * not depend on it: the merge sorts them. This module and `timelineRead.ts` import each other; the two core
 * readers are function declarations and the merge reads this list only when it is called, so either module
 * can be loaded first (docs/adr/2026-11-10-calendar-timeline-merges-a-list-of-sources.md).
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
