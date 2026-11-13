import type { PoolClient } from "pg";
import { readCalendarCatalog } from "./calendarCatalog.js";
import { czechPublicHolidays, type CzechPublicHoliday } from "./czechPublicHolidays.js";
import { readSystemCalendarId } from "./systemCalendar.js";
import type { CalendarHolidayTimelineItem, CalendarTimelineContext } from "./timelineSources.js";

/** The Czech public holidays calendar's system key (`seed/seedCalendars.ts`). */
const HOLIDAYS_SYSTEM_KEY = "holidaysCz";

/**
 * The public holiday source of the calendar timeline (issue #1804): one all-day, read-only entry for every
 * Czech public holiday that falls inside the range, in every year the range touches. The holidays come from
 * `czechPublicHolidays`, which knows the years 2016 to 2100; nothing is stored or downloaded. The title is the
 * `calendar.holiday.<key>` entry of the tenant user's language; the `holidaysCz` calendar's id is `calendarId`,
 * `null` when the tenant has none. A range without a holiday reads nothing from the database.
 */
export async function readHolidayTimelineItems(
  client: PoolClient,
  context: CalendarTimelineContext,
): Promise<CalendarHolidayTimelineItem[]> {
  const firstYear = Number(context.from.slice(0, 4));
  const lastYear = Number(context.to.slice(0, 4));
  const holidays: CzechPublicHoliday[] = [];
  for (let year = firstYear; year <= lastYear; year += 1) {
    holidays.push(...czechPublicHolidays(year).filter(({ date }) => date >= context.from && date <= context.to));
  }
  if (holidays.length === 0) return [];

  const label = await readCalendarCatalog(client);
  const calendarId = await readSystemCalendarId(client, HOLIDAYS_SYSTEM_KEY);
  return holidays.map(({ key, date }) => ({
    kind: "holiday",
    id: `holiday:cz:${date}`,
    title: label(`calendar.holiday.${key}`),
    date,
    allDay: true,
    calendarId,
    readOnly: true,
  }));
}
