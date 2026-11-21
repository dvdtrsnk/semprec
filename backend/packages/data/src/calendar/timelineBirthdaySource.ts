import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { PEOPLE_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { readCalendarCatalog } from "./calendarCatalog.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { logger } from "./logger.js";
import type { CalendarBirthdayTimelineItem, CalendarTimelineContext } from "./timelineSources.js";

const BIRTHDAYS_SYSTEM_KEY = "birthdays";

interface PersonRow {
  id: string;
  name: unknown;
  birthday: unknown;
}

const PEOPLE_WITH_BIRTHDAY_SQL = `
  SELECT id, properties->'name' AS name, properties->'birthday' AS birthday
    FROM items
   WHERE database_id = $1 AND deleted_at IS NULL
     AND properties->'birthday' IS NOT NULL AND properties->'birthday' <> 'null'::jsonb
   ORDER BY id`;

/** A 29 February falls on 28 February in a non-leap year. */
function birthdayInYear(year: number, monthDay: string): string {
  const day = monthDay === "02-29" && !DateTime.utc(year).isInLeapYear ? "02-28" : monthDay;
  return `${String(year).padStart(4, "0")}-${day}`;
}

function givenName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** Derived on read; no Events row exists for these entries. An unreadable birthday is logged and left out. */
export async function readBirthdayTimelineItems(
  client: PoolClient,
  context: CalendarTimelineContext,
): Promise<CalendarBirthdayTimelineItem[]> {
  const people = await context.lookups.database(PEOPLE_MODULE_ID);
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

  const template = (await readCalendarCatalog(await context.lookups.locale()))("calendar.birthday.title");
  const calendarId = (await context.lookups.calendarIds()).systemCalendarIds.get(BIRTHDAYS_SYSTEM_KEY) ?? null;
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
