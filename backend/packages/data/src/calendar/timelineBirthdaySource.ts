import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { PEOPLE_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { readCalendarCatalog } from "./calendarCatalog.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { logger } from "./logger.js";
import { readSystemCalendarId } from "./systemCalendar.js";
import type { CalendarBirthdayTimelineItem, CalendarTimelineContext } from "./timelineSources.js";

/** The Birthdays calendar's system key (`seed/seedCalendars.ts`). */
const BIRTHDAYS_SYSTEM_KEY = "birthdays";

interface PersonRow {
  id: string;
  name: unknown;
  birthday: unknown;
}

/** Every live person with a stored birthday, in one statement; a `null` birthday is no birthday. */
const PEOPLE_WITH_BIRTHDAY_SQL = `
  SELECT id, properties->'name' AS name, properties->'birthday' AS birthday
    FROM items
   WHERE database_id = $1 AND deleted_at IS NULL
     AND properties->'birthday' IS NOT NULL AND properties->'birthday' <> 'null'::jsonb
   ORDER BY id`;

/**
 * The day of `monthDay` (`MM-DD`) in `year`. A 29 February falls on 28 February in a year that is not a leap
 * year. Only the month and day of a stored birthday matter, whatever its year.
 */
function birthdayInYear(year: number, monthDay: string): string {
  const day = monthDay === "02-29" && !DateTime.utc(year).isInLeapYear ? "02-28" : monthDay;
  return `${String(year).padStart(4, "0")}-${day}`;
}

/** A person's given name: the first word of the name, the whole value when it has one word. */
function givenName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/**
 * The birthday source of the calendar timeline (issue #1800): one all-day, read-only entry in every year the
 * range touches for every live person whose stored `birthday` is a calendar date and falls inside the range
 * that year. The entries are derived on read and no Events row exists for them. A person whose stored
 * birthday is not a calendar date is left out, with one log line that carries the person's id. The title is
 * the `calendar.birthday.title` template of the tenant user's language with the person's given name; the
 * Birthdays calendar's id is `calendarId`, `null` when the tenant has none. A tenant without a People database
 * has none.
 */
export async function readBirthdayTimelineItems(
  client: PoolClient,
  context: CalendarTimelineContext,
): Promise<CalendarBirthdayTimelineItem[]> {
  const people = await getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
  if (!people) return [];
  const { rows } = await client.query<PersonRow>(PEOPLE_WITH_BIRTHDAY_SQL, [people.id]);

  const firstYear = Number(context.from.slice(0, 4));
  const years = Array.from(
    { length: Number(context.to.slice(0, 4)) - firstYear + 1 },
    (_, offset) => firstYear + offset,
  );
  const entries: { personId: string; personName: string; year: number; date: string }[] = [];
  for (const row of rows) {
    if (!isCalendarDate(row.birthday)) {
      logger.warn(
        { itemId: row.id, databaseId: people.id, property: "birthday" },
        "Calendar timeline left out an item with an invalid stored value",
      );
      continue;
    }
    const monthDay = row.birthday.slice(5);
    const personName = typeof row.name === "string" ? row.name : "";
    for (const year of years) {
      const date = birthdayInYear(year, monthDay);
      if (date >= context.from && date <= context.to) entries.push({ personId: row.id, personName, year, date });
    }
  }
  if (entries.length === 0) return [];

  const template = (await readCalendarCatalog(client))("calendar.birthday.title");
  const calendarId = await readSystemCalendarId(client, BIRTHDAYS_SYSTEM_KEY);
  return entries.map(({ personId, personName, year, date }) => ({
    kind: "birthday",
    id: `birthday:${personId}:${year}`,
    personId,
    personName,
    // A replacer function, so a `$` in the name is never read as a replacement pattern.
    title: template.replaceAll("{name}", () => givenName(personName)),
    date,
    allDay: true,
    calendarId,
    readOnly: true,
  }));
}
