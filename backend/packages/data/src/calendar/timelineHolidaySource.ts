import type { PoolClient } from "pg";
import { readCalendarCatalog } from "./calendarCatalog.js";
import { czechPublicHolidays, type CzechPublicHoliday } from "./czechPublicHolidays.js";
import { readSystemCalendarId } from "./systemCalendar.js";
import type { CalendarHolidayTimelineItem, CalendarTimelineContext } from "./timelineSources.js";

const HOLIDAYS_SYSTEM_KEY = "holidaysCz";

/** Computed, never stored or downloaded. A range without a holiday reads nothing from the database. */
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
