import type { PoolClient } from "pg";
import type { WallClock } from "../calendarTime.js";
import { readEventTimelineItems, readTaskTimelineItems } from "./timelineRead.js";

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
  /** The stored item's `updatedAt`, which a write passes back as `ifVersion`. */
  updatedAt: string;
  /** `false` for a stored Event or Task; a source sets `true` on an entry that is not a stored row. */
  readOnly: boolean;
}

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
}

/** One source of timeline items: it returns the items it has for the range of `context`. */
export interface CalendarTimelineSource {
  id: string;
  readItems(client: PoolClient, context: CalendarTimelineContext): Promise<CalendarTimelineItem[]>;
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
];
