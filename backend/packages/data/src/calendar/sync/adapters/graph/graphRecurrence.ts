// Graph's `patternedRecurrence` and RRULE text (without the `RRULE:` prefix), both ways. Graph describes a series
// with one pattern (daily, weekly, absolute or relative monthly and yearly) and one range (an end date, a number of
// occurrences, or none); RRULE parts outside what a pattern can say are refused on the way to Graph.
import { DateTime } from "luxon";
import { z } from "zod";
import { CalendarSyncWriteUnsupportedError } from "../../adapter.js";

const GRAPH_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
type GraphDay = (typeof GRAPH_DAYS)[number];
const RRULE_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

const GRAPH_INDEXES = ["first", "second", "third", "fourth", "last"] as const;
type GraphIndex = (typeof GRAPH_INDEXES)[number];
const ORDINAL_OF_INDEX: Readonly<Record<GraphIndex, number>> = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };

export const graphRecurrenceSchema = z.object({
  pattern: z.object({
    type: z.enum(["daily", "weekly", "absoluteMonthly", "relativeMonthly", "absoluteYearly", "relativeYearly"]),
    interval: z.number().int().min(1).max(9999).nullish(),
    month: z.number().int().min(0).max(12).nullish(),
    dayOfMonth: z.number().int().min(0).max(31).nullish(),
    daysOfWeek: z.array(z.enum(GRAPH_DAYS)).max(7).nullish(),
    firstDayOfWeek: z.enum(GRAPH_DAYS).nullish(),
    index: z.enum(GRAPH_INDEXES).nullish(),
  }),
  range: z.object({
    type: z.enum(["endDate", "noEnd", "numbered"]),
    startDate: z.string().nullish(),
    endDate: z.string().nullish(),
    numberOfOccurrences: z.number().int().min(0).nullish(),
    recurrenceTimeZone: z.string().nullish(),
  }),
});
export type GraphRecurrence = z.infer<typeof graphRecurrenceSchema>;

/** A write Graph cannot represent: an RRULE outside what a pattern says, an override without its series, … */
export class GraphCalendarWriteUnsupportedError extends CalendarSyncWriteUnsupportedError {
  constructor(message: string) {
    super(message);
    this.name = "GraphCalendarWriteUnsupportedError";
  }
}

function rruleDay(day: GraphDay): string {
  return RRULE_DAYS[GRAPH_DAYS.indexOf(day)] ?? "MO";
}

function sortedDays(days: readonly GraphDay[]): GraphDay[] {
  return [...new Set(days)].sort((a, b) => GRAPH_DAYS.indexOf(a) - GRAPH_DAYS.indexOf(b));
}

/**
 * Whether a weekly rule with these days gives the same days when weeks start on `firstDayOfWeek` as when they start
 * on Monday (RRULE's default `WKST`), from a series start of `start`. Both are periodic with `interval` weeks, so two
 * periods decide it.
 */
function weekStartIrrelevant(days: GraphDay[], interval: number, firstDayOfWeek: GraphDay, start: string): boolean {
  if (interval === 1 || firstDayOfWeek === "monday") return true;
  const wanted = new Set(days.map((day) => GRAPH_DAYS.indexOf(day) + 1));
  const origin = DateTime.fromISO(start, { zone: "utc" });
  const weekIndex = (day: DateTime, weekStart: number) => {
    const shift = (day.weekday - weekStart + 7) % 7;
    return Math.round(day.minus({ days: shift }).diff(origin, "days").days);
  };
  const graphStart = GRAPH_DAYS.indexOf(firstDayOfWeek) + 1;
  const firstGraphWeek = weekIndex(origin, graphStart);
  const firstMondayWeek = weekIndex(origin, 1);
  for (let offset = 0; offset < 14 * interval; offset += 1) {
    const day = origin.plus({ days: offset });
    if (!wanted.has(day.weekday)) continue;
    const inGraph = Math.round((weekIndex(day, graphStart) - firstGraphWeek) / 7) % interval === 0;
    const inMonday = Math.round((weekIndex(day, 1) - firstMondayWeek) / 7) % interval === 0;
    if (inGraph !== inMonday) return false;
  }
  return true;
}

function relativeDayParts(days: GraphDay[], index: GraphIndex): string[] {
  const ordinal = ORDINAL_OF_INDEX[index];
  if (days.length === 1) return [`BYDAY=${ordinal}${rruleDay(days[0]!)}`];
  return [`BYDAY=${days.map(rruleDay).join(",")}`, `BYSETPOS=${ordinal}`];
}

/** RRULE `UNTIL` for a Graph end date (inclusive, in the series' zone): a day, or that day's last second in UTC. */
function untilPart(endDate: string, allDay: boolean, zone: string): string | null {
  const day = DateTime.fromISO(endDate, { zone });
  if (!day.isValid) return null;
  if (allDay) return `UNTIL=${day.toFormat("yyyyMMdd")}`;
  return `UNTIL=${day.endOf("day").toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'")}`;
}

/**
 * The RRULE of a Graph series, or `null` for a pattern that lacks what its type needs (a weekly pattern without
 * days). `start` is the series' first day in `zone`; `WKST` is written only when the week start changes the days.
 */
export function rruleOfGraphRecurrence(
  recurrence: GraphRecurrence,
  series: { start: string; allDay: boolean; zone: string },
): string | null {
  const { pattern, range } = recurrence;
  const interval = pattern.interval ?? 1;
  const days = sortedDays(pattern.daysOfWeek ?? []);
  const parts: string[] = [];
  switch (pattern.type) {
    case "daily":
      parts.push("FREQ=DAILY");
      break;
    case "weekly": {
      if (days.length === 0) return null;
      parts.push("FREQ=WEEKLY", `BYDAY=${days.map(rruleDay).join(",")}`);
      const firstDayOfWeek = pattern.firstDayOfWeek ?? "sunday";
      if (!weekStartIrrelevant(days, interval, firstDayOfWeek, series.start)) {
        parts.push(`WKST=${rruleDay(firstDayOfWeek)}`);
      }
      break;
    }
    case "absoluteMonthly":
      if (!pattern.dayOfMonth) return null;
      parts.push("FREQ=MONTHLY", `BYMONTHDAY=${pattern.dayOfMonth}`);
      break;
    case "relativeMonthly":
      if (days.length === 0) return null;
      parts.push("FREQ=MONTHLY", ...relativeDayParts(days, pattern.index ?? "first"));
      break;
    case "absoluteYearly":
      if (!pattern.month || !pattern.dayOfMonth) return null;
      parts.push("FREQ=YEARLY", `BYMONTH=${pattern.month}`, `BYMONTHDAY=${pattern.dayOfMonth}`);
      break;
    case "relativeYearly":
      if (!pattern.month || days.length === 0) return null;
      parts.push("FREQ=YEARLY", `BYMONTH=${pattern.month}`, ...relativeDayParts(days, pattern.index ?? "first"));
      break;
  }
  if (interval !== 1) parts.splice(1, 0, `INTERVAL=${interval}`);
  if (range.type === "numbered") {
    if (!range.numberOfOccurrences) return null;
    parts.push(`COUNT=${range.numberOfOccurrences}`);
  } else if (range.type === "endDate") {
    const until = range.endDate ? untilPart(range.endDate, series.allDay, series.zone) : null;
    if (until === null) return null;
    parts.push(until);
  }
  return parts.join(";");
}

const SUPPORTED_PARTS = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS"]);

function unsupported(part: string): GraphCalendarWriteUnsupportedError {
  return new GraphCalendarWriteUnsupportedError(`Microsoft Graph cannot represent the recurrence part ${part}`);
}

function graphDayOf(code: string): GraphDay {
  const index = RRULE_DAYS.indexOf(code as (typeof RRULE_DAYS)[number]);
  if (index < 0) throw unsupported("BYDAY");
  return GRAPH_DAYS[index]!;
}

function graphIndexOf(ordinal: number): GraphIndex {
  const found = GRAPH_INDEXES.find((index) => ORDINAL_OF_INDEX[index] === ordinal);
  if (found === undefined) throw unsupported("BYDAY ordinal");
  return found;
}

function positiveInteger(text: string, part: string, max: number): number {
  if (!/^\d{1,5}$/.test(text)) throw unsupported(part);
  const value = Number(text);
  if (value < 1 || value > max) throw unsupported(part);
  return value;
}

/** The end date (in `zone`) an RRULE `UNTIL` names: a day, a floating time, or a UTC time. */
function endDateOfUntil(text: string, zone: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(text);
  if (match === null) throw unsupported("UNTIL");
  const [, year, month, day, hour, minute, second, utc] = match;
  const date = `${year}-${month}-${day}`;
  if (hour === undefined || utc === undefined) {
    if (!DateTime.fromISO(date, { zone: "utc" }).isValid) throw unsupported("UNTIL");
    return date;
  }
  const local = DateTime.fromISO(`${date}T${hour}:${minute}:${second}`, { zone: "utc" }).setZone(zone);
  const endDate = local.toISODate();
  if (!local.isValid || endDate === null) throw unsupported("UNTIL");
  return endDate;
}

/**
 * The Graph recurrence of an RRULE, for a series starting on `startDate` in `zone` (sent to Graph as `graphZone`).
 * Weeks start on Monday unless `WKST` names another day, so the days are the ones RRULE means. Throws
 * `GraphCalendarWriteUnsupportedError` for a rule no pattern expresses (several month days, `BYHOUR`, …).
 */
export function graphRecurrenceOfRrule(
  rule: string,
  series: { startDate: string; zone: string; graphZone: string },
): GraphRecurrence {
  const parts = new Map<string, string>();
  for (const entry of rule.split(";")) {
    const separator = entry.indexOf("=");
    const name = entry.slice(0, separator).toUpperCase();
    const value = entry.slice(separator + 1).toUpperCase();
    if (separator <= 0 || value === "" || parts.has(name)) throw unsupported(name || entry);
    if (name !== "WKST" && !SUPPORTED_PARTS.has(name)) throw unsupported(name);
    parts.set(name, value);
  }
  const interval = parts.has("INTERVAL") ? positiveInteger(parts.get("INTERVAL")!, "INTERVAL", 9999) : 1;
  const monthDayText = parts.get("BYMONTHDAY");
  const monthText = parts.get("BYMONTH");
  const setPosText = parts.get("BYSETPOS");
  const dayEntries = (parts.get("BYDAY")?.split(",") ?? []).map((entry) => {
    const match = /^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(entry);
    if (match === null) throw unsupported("BYDAY");
    return { ordinal: match[1] === undefined ? null : Number(match[1]), day: graphDayOf(match[2]!) };
  });
  const plainDays = dayEntries.filter((entry) => entry.ordinal === null).map((entry) => entry.day);
  const ordinalDays = dayEntries.filter((entry) => entry.ordinal !== null);
  const start = DateTime.fromISO(series.startDate, { zone: "utc" });
  if (!start.isValid) throw unsupported("DTSTART");
  const startDay = GRAPH_DAYS[start.weekday - 1]!;
  const firstDayOfWeek = parts.has("WKST") ? graphDayOf(parts.get("WKST")!) : "monday";

  /** One relative day (`2TU`), or several plain days chosen by `BYSETPOS`. */
  const relative = (): { daysOfWeek: GraphDay[]; index: GraphIndex } => {
    if (ordinalDays.length === 1 && plainDays.length === 0 && setPosText === undefined) {
      return { daysOfWeek: [ordinalDays[0]!.day], index: graphIndexOf(ordinalDays[0]!.ordinal!) };
    }
    if (ordinalDays.length === 0 && plainDays.length > 0 && setPosText !== undefined) {
      if (!/^-?\d$/.test(setPosText)) throw unsupported("BYSETPOS");
      return { daysOfWeek: sortedDays(plainDays), index: graphIndexOf(Number(setPosText)) };
    }
    throw unsupported("BYDAY");
  };
  const monthDay = () => (monthDayText === undefined ? start.day : positiveInteger(monthDayText, "BYMONTHDAY", 31));

  let pattern: GraphRecurrence["pattern"];
  switch (parts.get("FREQ")) {
    case "DAILY":
      if (monthDayText !== undefined || monthText !== undefined || setPosText !== undefined) throw unsupported("FREQ");
      if (dayEntries.length === 0) {
        pattern = { type: "daily", interval };
      } else {
        if (interval !== 1 || ordinalDays.length > 0) throw unsupported("BYDAY");
        pattern = { type: "weekly", interval: 1, daysOfWeek: sortedDays(plainDays), firstDayOfWeek };
      }
      break;
    case "WEEKLY":
      if (monthDayText !== undefined || monthText !== undefined || setPosText !== undefined) throw unsupported("FREQ");
      if (ordinalDays.length > 0) throw unsupported("BYDAY");
      pattern = {
        type: "weekly",
        interval,
        daysOfWeek: plainDays.length > 0 ? sortedDays(plainDays) : [startDay],
        firstDayOfWeek,
      };
      break;
    case "MONTHLY":
      if (monthText !== undefined) throw unsupported("BYMONTH");
      if (dayEntries.length > 0) {
        if (monthDayText !== undefined) throw unsupported("BYMONTHDAY");
        pattern = { type: "relativeMonthly", interval, ...relative() };
      } else {
        if (setPosText !== undefined) throw unsupported("BYSETPOS");
        pattern = { type: "absoluteMonthly", interval, dayOfMonth: monthDay() };
      }
      break;
    case "YEARLY": {
      const month = monthText === undefined ? start.month : positiveInteger(monthText, "BYMONTH", 12);
      if (dayEntries.length > 0) {
        if (monthDayText !== undefined) throw unsupported("BYMONTHDAY");
        pattern = { type: "relativeYearly", interval, month, ...relative() };
      } else {
        if (setPosText !== undefined) throw unsupported("BYSETPOS");
        pattern = { type: "absoluteYearly", interval, month, dayOfMonth: monthDay() };
      }
      break;
    }
    default:
      throw unsupported("FREQ");
  }

  const countText = parts.get("COUNT");
  const untilText = parts.get("UNTIL");
  if (countText !== undefined && untilText !== undefined) throw unsupported("COUNT");
  const base = { startDate: series.startDate, recurrenceTimeZone: series.graphZone };
  const range: GraphRecurrence["range"] =
    countText !== undefined
      ? { type: "numbered", ...base, numberOfOccurrences: positiveInteger(countText, "COUNT", 99_999) }
      : untilText !== undefined
        ? { type: "endDate", ...base, endDate: endDateOfUntil(untilText, series.zone) }
        : { type: "noEnd", ...base };
  return { pattern, range };
}
