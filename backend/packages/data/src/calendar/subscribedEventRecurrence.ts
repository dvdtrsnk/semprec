// The RRULE subset that subscribed events are expanded with (issue gh-1966): which rule texts are understood, and on which
// local days a series that starts on a given day occurs. Everything here is pure and works on calendar days only; the
// time zones, the exceptions and the overrides are applied by `subscribedEventOccurrences.ts`.
// Constrained by: docs/adr/2026-11-14-a-subscribed-event-series-is-expanded-from-its-stored-rows-on-read.md

/** The frequencies a rule may have. */
export type RecurrenceFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

/** A `BYDAY` entry: the weekday (ISO, Monday is 1) and, for `2TU` or `-1FR`, the ordinal within the month. */
export interface RecurrenceWeekday {
  weekday: number;
  ordinal: number | null;
}

/** The `UNTIL` of a rule as the feed gave it: a date, with a time of day when it has one, `utc` for a `Z` time. */
export interface RecurrenceUntil {
  date: string;
  time: string | null;
  utc: boolean;
}

/** A rule that uses only `FREQ`, `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`, `BYMONTHDAY` and `BYMONTH`. */
export interface RecurrenceRule {
  freq: RecurrenceFrequency;
  interval: number;
  count: number | null;
  until: RecurrenceUntil | null;
  byDay: RecurrenceWeekday[];
  byMonthDay: number[];
  byMonth: number[];
}

/** The most periods (days, weeks, months or years, by frequency) one expansion looks at before it gives up. */
const MAX_PERIODS = 20_000;

function isFrequency(value: string): value is RecurrenceFrequency {
  return value === "DAILY" || value === "WEEKLY" || value === "MONTHLY" || value === "YEARLY";
}

const SUPPORTED_PARTS: readonly string[] = ["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH"];
const WEEKDAY_CODES: readonly string[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

const MS_PER_DAY = 86_400_000;

/** The days since 1970-01-01 of the calendar date `YYYY-MM-DD`. */
function toDays(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Math.round(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1) / MS_PER_DAY);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** The calendar date `YYYY-MM-DD` of a number of days since 1970-01-01. */
function fromDays(days: number): string {
  const date = new Date(days * MS_PER_DAY);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

/** The ISO weekday (Monday is 1) of a number of days since 1970-01-01, which was a Thursday. */
function weekdayOf(days: number): number {
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isExistingDate(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function readInteger(text: string): number {
  return Number.parseInt(text, 10);
}

function readUntil(text: string): RecurrenceUntil | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{2}(Z)?)?$/.exec(text);
  if (match === null) return null;
  const [, year, month, day, hour, minute, zulu] = match;
  if (!isExistingDate(readInteger(year ?? ""), readInteger(month ?? ""), readInteger(day ?? ""))) return null;
  const date = `${year}-${month}-${day}`;
  if (hour === undefined) return { date, time: null, utc: false };
  if (readInteger(hour) > 23 || readInteger(minute ?? "") > 59) return null;
  return { date, time: `${hour}:${minute}`, utc: zulu !== undefined };
}

function readWeekdays(text: string): RecurrenceWeekday[] | null {
  const weekdays: RecurrenceWeekday[] = [];
  for (const entry of text.split(",")) {
    const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(entry);
    if (match === null) return null;
    const ordinal = match[1] === undefined ? null : readInteger(match[1]);
    if (ordinal === 0 || (ordinal !== null && Math.abs(ordinal) > 5)) return null;
    weekdays.push({ weekday: WEEKDAY_CODES.indexOf(match[2] ?? "") + 1, ordinal });
  }
  return weekdays;
}

function readNumbers(text: string, pattern: RegExp, within: (value: number) => boolean): number[] | null {
  const numbers: number[] = [];
  for (const entry of text.split(",")) {
    if (!pattern.test(entry)) return null;
    const value = readInteger(entry);
    if (!within(value)) return null;
    numbers.push(value);
  }
  return numbers;
}

/**
 * Reads the text of an `RRULE` value. Returns `null` for a rule that is not expanded: one with a part other than
 * `FREQ`, `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`, `BYMONTHDAY` and `BYMONTH`, a frequency other than daily, weekly,
 * monthly or yearly, a value that is not valid, a part given twice, `COUNT` together with `UNTIL`, an ordinal `BYDAY`
 * outside a monthly rule or a yearly one with `BYMONTH`, `BYMONTHDAY` in a weekly rule, and a yearly rule with `BYDAY`
 * or `BYMONTHDAY` but no `BYMONTH`. The last four are combinations that this expansion does not define.
 */
export function parseRecurrenceRule(text: string): RecurrenceRule | null {
  const parts = new Map<string, string>();
  for (const entry of text.split(";")) {
    const separator = entry.indexOf("=");
    const name = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (separator <= 0 || value === "" || !SUPPORTED_PARTS.includes(name) || parts.has(name)) return null;
    parts.set(name, value);
  }
  const freq = parts.get("FREQ");
  if (freq === undefined || !isFrequency(freq)) return null;
  const intervalText = parts.get("INTERVAL");
  const countText = parts.get("COUNT");
  const untilText = parts.get("UNTIL");
  const dayText = parts.get("BYDAY");
  const monthDayText = parts.get("BYMONTHDAY");
  const monthText = parts.get("BYMONTH");
  if (intervalText !== undefined && !/^[1-9]\d{0,3}$/.test(intervalText)) return null;
  if (countText !== undefined && !/^[1-9]\d{0,5}$/.test(countText)) return null;
  if (countText !== undefined && untilText !== undefined) return null;
  const until = untilText === undefined ? null : readUntil(untilText);
  const byDay = dayText === undefined ? [] : readWeekdays(dayText);
  const byMonthDay =
    monthDayText === undefined
      ? []
      : readNumbers(monthDayText, /^[+-]?\d{1,2}$/, (value) => value !== 0 && Math.abs(value) <= 31);
  const byMonth =
    monthText === undefined ? [] : readNumbers(monthText, /^\d{1,2}$/, (value) => value >= 1 && value <= 12);
  if ((untilText !== undefined && until === null) || byDay === null || byMonthDay === null || byMonth === null) {
    return null;
  }
  const rule: RecurrenceRule = {
    freq,
    interval: intervalText === undefined ? 1 : readInteger(intervalText),
    count: countText === undefined ? null : readInteger(countText),
    until,
    byDay,
    byMonthDay,
    byMonth,
  };
  const ordinal = byDay.some((entry) => entry.ordinal !== null);
  if (ordinal && !(freq === "MONTHLY" || (freq === "YEARLY" && byMonth.length > 0))) return null;
  if (freq === "WEEKLY" && byMonthDay.length > 0) return null;
  if (freq === "YEARLY" && byMonth.length === 0 && (byDay.length > 0 || byMonthDay.length > 0)) return null;
  return rule;
}

/** The date of the `ordinal`-th `weekday` of a month: from the first one for a positive ordinal, the last for a negative. */
function nthWeekday(year: number, month: number, weekday: number, ordinal: number): number | null {
  const length = daysInMonth(year, month);
  const firstDay = toDays(`${pad(year, 4)}-${pad(month, 2)}-01`);
  const day =
    ordinal > 0
      ? 1 + ((weekday - weekdayOf(firstDay) + 7) % 7) + (ordinal - 1) * 7
      : length - ((weekdayOf(firstDay + length - 1) - weekday + 7) % 7) + (ordinal + 1) * 7;
  return day >= 1 && day <= length ? day : null;
}

/** The days of a month that `BYMONTHDAY` and `BYDAY` name, both applying when both are given. `null` when neither is. */
function namedDaysOfMonth(rule: RecurrenceRule, year: number, month: number): number[] | null {
  if (rule.byMonthDay.length === 0 && rule.byDay.length === 0) return null;
  const length = daysInMonth(year, month);
  const first = toDays(`${pad(year, 4)}-${pad(month, 2)}-01`);
  const monthDays = rule.byMonthDay
    .map((day) => (day > 0 ? day : length + 1 + day))
    .filter((day) => day >= 1 && day <= length);
  const weekdayDays = rule.byDay.flatMap((entry): number[] => {
    if (entry.ordinal !== null) {
      const day = nthWeekday(year, month, entry.weekday, entry.ordinal);
      return day === null ? [] : [day];
    }
    return Array.from({ length }, (_, index) => index + 1).filter(
      (day) => weekdayOf(first + day - 1) === entry.weekday,
    );
  });
  if (rule.byMonthDay.length === 0) return weekdayDays;
  if (rule.byDay.length === 0) return monthDays;
  return monthDays.filter((day) => weekdayDays.includes(day));
}

function sortedUnique(days: number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

/** What the iteration needs to know about the day the series starts on. */
interface SeriesStart {
  days: number;
  year: number;
  month: number;
  day: number;
  weekday: number;
}

function readStart(date: string): SeriesStart {
  const [year, month, day] = date.split("-").map(Number);
  const days = toDays(date);
  return { days, year: year ?? 1970, month: month ?? 1, day: day ?? 1, weekday: weekdayOf(days) };
}

/** The first day of period `index` and the days of the rule inside it, ascending; the period is a day, week, month or year. */
function period(rule: RecurrenceRule, start: SeriesStart, index: number): { first: number; days: number[] } {
  const step = index * rule.interval;
  switch (rule.freq) {
    case "DAILY": {
      const day = start.days + step;
      const date = fromDays(day);
      const month = readInteger(date.slice(5, 7));
      const monthDay = readInteger(date.slice(8, 10));
      const length = daysInMonth(readInteger(date.slice(0, 4)), month);
      const fits =
        (rule.byMonth.length === 0 || rule.byMonth.includes(month)) &&
        (rule.byMonthDay.length === 0 ||
          rule.byMonthDay.some((entry) => (entry > 0 ? entry : length + 1 + entry) === monthDay)) &&
        (rule.byDay.length === 0 || rule.byDay.some((entry) => entry.weekday === weekdayOf(day)));
      return { first: day, days: fits ? [day] : [] };
    }
    case "WEEKLY": {
      const monday = start.days - (start.weekday - 1) + step * 7;
      const weekdays = rule.byDay.length === 0 ? [start.weekday] : rule.byDay.map((entry) => entry.weekday);
      const days = sortedUnique(weekdays.map((weekday) => monday + weekday - 1)).filter(
        (day) => rule.byMonth.length === 0 || rule.byMonth.includes(readInteger(fromDays(day).slice(5, 7))),
      );
      return { first: monday, days };
    }
    case "MONTHLY": {
      const monthIndex = start.year * 12 + (start.month - 1) + step;
      const year = Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      const first = toDays(`${pad(year, 4)}-${pad(month, 2)}-01`);
      if (rule.byMonth.length > 0 && !rule.byMonth.includes(month)) return { first, days: [] };
      const named = namedDaysOfMonth(rule, year, month) ?? (start.day <= daysInMonth(year, month) ? [start.day] : []);
      return { first, days: sortedUnique(named.map((day) => first + day - 1)) };
    }
    case "YEARLY": {
      const year = start.year + step;
      const months = rule.byMonth.length === 0 ? [start.month] : sortedUnique(rule.byMonth);
      const days = months.flatMap((month) => {
        const first = toDays(`${pad(year, 4)}-${pad(month, 2)}-01`);
        const named = namedDaysOfMonth(rule, year, month) ?? (start.day <= daysInMonth(year, month) ? [start.day] : []);
        return named.map((day) => first + day - 1);
      });
      return { first: toDays(`${pad(year, 4)}-01-01`), days: sortedUnique(days) };
    }
  }
}

/** How many periods of the rule lie between its first and the day `from`, rounded down; an upper bound for skipping ahead. */
function periodsBefore(rule: RecurrenceRule, start: SeriesStart, from: number): number {
  const date = fromDays(from);
  const year = readInteger(date.slice(0, 4));
  const month = readInteger(date.slice(5, 7));
  switch (rule.freq) {
    case "DAILY":
      return Math.floor((from - start.days) / rule.interval);
    case "WEEKLY":
      return Math.floor((from - (start.days - (start.weekday - 1))) / 7 / rule.interval);
    case "MONTHLY":
      return Math.floor((year * 12 + month - (start.year * 12 + start.month)) / rule.interval);
    case "YEARLY":
      return Math.floor((year - start.year) / rule.interval);
  }
}

/**
 * The days of the series that fall in `window` (`from` and `to` are dates, both included), ascending, as `YYYY-MM-DD`.
 * `start` is the local date and time of the first occurrence, which is an occurrence whether or not the rule names it,
 * and counts towards `COUNT`. `until` is the last allowed local start as `YYYY-MM-DDTHH:mm`, compared with each start
 * (`start.date` with `start.time`), or `null`. Without `COUNT` the iteration starts at the period before `window.from`;
 * with it, every period from the first is counted, and a rule that has not produced its `COUNT` occurrences after
 * `MAX_PERIODS` periods ends there. A day that a month lacks (the 31st, 29 February) is no occurrence, it is not moved.
 */
export function recurrenceDates(
  rule: RecurrenceRule,
  start: { date: string; time: string },
  until: string | null,
  window: { from: string; to: string },
): string[] {
  const seriesStart = readStart(start.date);
  const from = toDays(window.from);
  const to = toDays(window.to);
  const found: string[] = [];
  let produced = 0;
  let index = rule.count === null ? Math.max(0, periodsBefore(rule, seriesStart, from) - 1) : 0;
  for (let looked = 0; looked < MAX_PERIODS; looked += 1, index += 1) {
    const current = period(rule, seriesStart, index);
    if (current.first > to) break;
    const days =
      index === 0
        ? sortedUnique([...current.days.filter((day) => day >= seriesStart.days), seriesStart.days])
        : current.days;
    for (const day of days) {
      if (until !== null && `${fromDays(day)}T${start.time}` > until) return found;
      produced += 1;
      if (day >= from && day <= to) found.push(fromDays(day));
      if (rule.count !== null && produced >= rule.count) return found;
    }
  }
  return found;
}
