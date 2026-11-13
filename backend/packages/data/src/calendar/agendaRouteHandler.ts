import { DateTime } from "luxon";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { readCalendarTimeline } from "./timelineRead.js";
import type { CalendarTimelineEntry, CalendarTimelineItem } from "./timelineSources.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** The days one call of `readCalendarTimeline` covers. */
const WINDOW_DAYS = 31;
/** The days one request scans, the day it starts on included. */
const SCAN_HORIZON_DAYS = 366;
/** An agenda ends this many years from its `from`. */
const AGENDA_YEARS = 5;
/** The longest `cursor` value that is decoded. */
const MAX_CURSOR_LENGTH = 1024;

/** The first and the last day `isCalendarDate` accepts. */
const FIRST_CALENDAR_DAY = "0000-01-01";
const LAST_CALENDAR_DAY = "9999-12-31";

/** `1` for an agenda that goes forward, to later days, and `-1` for one that goes backward. */
type AgendaStep = 1 | -1;

/** A decoded cursor: a day, `|`, and the id of an item or nothing. */
const CURSOR_SHAPE = /^(\d{4}-\d{2}-\d{2})\|(.*)$/s;

/** A `nextCursor`: the page after it continues after the item `id` among the items of `day`, or with the whole `day` when `id` is `null`. */
function encodeCursor(day: string, id: string | null): string {
  return Buffer.from(`${day}|${id ?? ""}`).toString("base64url");
}

function invalidCursor(): ValidationError {
  return new ValidationError("'cursor' must be a nextCursor of this agenda", { field: "cursor" });
}

/** Decodes a `nextCursor`. A value of another shape, or one whose day is no calendar date, is refused on `cursor`. */
function decodeCursor(raw: string): { day: string; id: string | null } {
  const match =
    raw.length <= MAX_CURSOR_LENGTH && /^[A-Za-z0-9_-]+$/.test(raw)
      ? CURSOR_SHAPE.exec(Buffer.from(raw, "base64url").toString("utf8"))
      : null;
  const day = match?.[1];
  const id = match?.[2];
  if (id === undefined || !isCalendarDate(day)) throw invalidCursor();
  return { day, id: id === "" ? null : id };
}

/**
 * A stored Event or Task. The agenda lists only those: a birthday, a holiday and a sleep night are derived
 * entries of the timeline, and the agenda defines its day, span, order and cursor for stored items alone.
 */
function isStoredItem(entry: CalendarTimelineEntry): entry is CalendarTimelineItem {
  return entry.kind === "event" || entry.kind === "task";
}

function utcDay(day: string): DateTime {
  return DateTime.fromISO(day, { zone: "utc" });
}

/** The number of days between two calendar dates, whichever is the earlier one. */
function daysApart(a: string, b: string): number {
  return Math.abs(utcDay(a).diff(utcDay(b), "days").days);
}

/**
 * How many days after `from`, in the direction of travel, its agenda ends: five years on, or on the first or
 * last calendar date when that comes sooner.
 */
function agendaLength(from: string, step: AgendaStep): number {
  const start = utcDay(from);
  const fiveYears = Math.abs(start.plus({ years: step * AGENDA_YEARS }).diff(start, "days").days);
  return Math.min(fiveYears, daysApart(from, step === 1 ? LAST_CALENDAR_DAY : FIRST_CALENDAR_DAY));
}

interface AgendaPageInput {
  from: string;
  step: AgendaStep;
  limit: number;
  /** The day the page starts on, in days from `from` in the direction of travel. */
  startOffset: number;
  /** The item of the start day the page continues after; `null` for a page that starts with the whole day. */
  afterId: string | null;
  /** `agendaLength` of this agenda. */
  lastOffset: number;
}

interface AgendaPage {
  items: CalendarTimelineItem[];
  nextCursor: string | null;
}

/**
 * One page of the agenda that starts on `from` (issue #1762), read through `readCalendarTimeline` in windows
 * of 31 days. It holds stored Events and Tasks only; the derived entries of the timeline (birthdays, holidays
 * and sleep nights) are left out of every page and of the cursor.
 *
 * Every item is shown on one day. Going forward that is its `date`, or `from` when it began before `from`;
 * going backward it is its last day (an Event's `endDate`, else `date`), or `from` when it ends after `from`.
 * The days follow each other in the direction of travel, and the items of one day keep the order the
 * timeline returns them in. A day without an item takes no place.
 *
 * The page starts on the day `startOffset` and holds at most `limit` items. With an `afterId` it continues
 * after that item among the items of the start day; when the item is not among them, it starts on the next
 * day in the direction of travel. The scan stops when the page is full, after 366 days, or at the end of the
 * agenda (`lastOffset`), whichever comes first.
 *
 * `nextCursor` is `null` when the scan reached the end of the agenda and the page holds everything found up
 * to it. Else it names the last item of a full page, and for a page that is not full the day after the last
 * scanned one. The caller passes a `startOffset` from 0 to `lastOffset`.
 */
async function readAgendaPage(client: PoolClient, input: AgendaPageInput): Promise<AgendaPage> {
  const { from, step, limit, startOffset, afterId, lastOffset } = input;
  const dayAt = (offset: number): string =>
    utcDay(from)
      .plus({ days: step * offset })
      .toFormat("yyyy-MM-dd");
  const shownOn = (item: CalendarTimelineItem): string => {
    if (step === 1) return item.date < from ? from : item.date;
    const last = item.endDate ?? item.date;
    return last > from ? from : last;
  };

  const startDay = dayAt(startOffset);
  const horizonOffset = Math.min(startOffset + SCAN_HORIZON_DAYS - 1, lastOffset);
  const page: { item: CalendarTimelineItem; day: string }[] = [];
  let offset = startOffset;
  let windowEnd: number;
  let leftInWindow: boolean;
  do {
    windowEnd = Math.min(offset + WINDOW_DAYS - 1, horizonOffset);
    const first = dayAt(step === 1 ? offset : windowEnd);
    const last = dayAt(step === 1 ? windowEnd : offset);
    const timeline = await readCalendarTimeline(client, { from: first, to: last, shape: "full" });
    // An item that lasts several days is in every window it touches; it is kept in the window of its one day.
    let shown = timeline.items
      .filter(isStoredItem)
      .map((item) => ({ item, day: shownOn(item) }))
      .filter(({ day }) => day >= first && day <= last)
      .sort((a, b) => step * (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    if (afterId !== null) {
      // Only the first window holds the start day, which comes first in it; a later window is left as it is.
      const index = shown.findIndex(({ item, day }) => day === startDay && item.id === afterId);
      shown = index === -1 ? shown.filter(({ day }) => day !== startDay) : shown.slice(index + 1);
    }
    const room = limit - page.length;
    page.push(...shown.slice(0, room));
    leftInWindow = shown.length > room;
    offset = windowEnd + 1;
  } while (page.length < limit && windowEnd < horizonOffset);

  const items = page.map(({ item }) => item);
  const lastShown = page.at(-1);
  if (!leftInWindow && windowEnd === lastOffset) return { items, nextCursor: null };
  if (lastShown !== undefined && page.length === limit) {
    return { items, nextCursor: encodeCursor(lastShown.day, lastShown.item.id) };
  }
  return { items, nextCursor: encodeCursor(dayAt(horizonOffset + 1), null) };
}

/** The request context of `GET /api/calendar/agenda`: its query string is read from the request URL. */
interface CalendarAgendaRouteRequestContext {
  req: { url?: string };
}

/**
 * `GET /api/calendar/agenda?from=YYYY-MM-DD&direction=forward|backward[&limit=1..200][&cursor=...]` (issue
 * #1762): `{ items, nextCursor }` of `readAgendaPage` for the caller's tenant, the stored Events and Tasks in
 * the full shape of the calendar timeline (its derived entries are not agenda items). `from` is a calendar
 * date, `direction` is `forward` or `backward`, `limit` is a whole number from 1 to 200 (50 when it is absent)
 * and `cursor` is absent or has the shape of a `nextCursor` with a day between `from` and the end of the
 * agenda in that direction. Anything else is a 400 `validation_failed` naming the parameter.
 */
export function createCalendarAgendaRouteHandler(pool: Pool) {
  return async (ctx: CalendarAgendaRouteRequestContext): Promise<{ status: number; body: AgendaPage }> => {
    const parameters = new URL(ctx.req.url ?? "/", "http://localhost").searchParams;
    const from = parameters.get("from");
    if (!isCalendarDate(from)) {
      throw new ValidationError("'from' must be a calendar date YYYY-MM-DD", { field: "from" });
    }
    const direction = parameters.get("direction");
    if (direction !== "forward" && direction !== "backward") {
      throw new ValidationError("'direction' must be 'forward' or 'backward'", { field: "direction" });
    }
    const step = direction === "forward" ? 1 : -1;
    const rawLimit = parameters.get("limit");
    const limit = rawLimit === null ? DEFAULT_LIMIT : /^[0-9]{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
    if (!(limit >= 1 && limit <= MAX_LIMIT)) {
      throw new ValidationError(`'limit' must be a whole number from 1 to ${MAX_LIMIT}`, { field: "limit" });
    }
    const lastOffset = agendaLength(from, step);
    const rawCursor = parameters.get("cursor");
    const cursor = rawCursor === null ? null : decodeCursor(rawCursor);
    const startOffset = cursor === null ? 0 : step * utcDay(cursor.day).diff(utcDay(from), "days").days;
    if (startOffset < 0 || startOffset > lastOffset) throw invalidCursor();

    const body = await withTransaction(pool, (client) =>
      readAgendaPage(client, { from, step, limit, startOffset, afterId: cursor?.id ?? null, lastOffset }),
    );
    return { status: 200, body };
  };
}
