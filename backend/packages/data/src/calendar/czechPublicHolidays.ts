import { DateTime } from "luxon";

/** The first and last year `czechPublicHolidays` knows: Good Friday and 24 December became holidays in 2016. */
const FIRST_YEAR = 2016;
const LAST_YEAR = 2100;

/** One public holiday of the Czech Republic: its canonical key (`calendar.holiday.<key>` in the catalog) and day. */
export interface CzechPublicHoliday {
  key:
    | "newYear"
    | "goodFriday"
    | "easterMonday"
    | "labourDay"
    | "victoryDay"
    | "cyrilAndMethodius"
    | "janHus"
    | "statehood"
    | "independence"
    | "freedomAndDemocracy"
    | "christmasEve"
    | "christmasDay"
    | "boxingDay";
  /** `YYYY-MM-DD`. */
  date: string;
}

/** Easter Sunday of a Gregorian `year` by the anonymous (Meeus/Jones/Butcher) algorithm. */
function easterSunday(year: number): DateTime {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return DateTime.utc(year, month, day);
}

function isoDate(day: DateTime): string {
  const iso = day.toISODate();
  if (iso === null) throw new Error("A holiday date is not a valid date");
  return iso;
}

/**
 * The public holidays of the Czech Republic in `year`, in the order of the calendar: 1 January, Good Friday,
 * Easter Monday, 1 May, 8 May, 5 July, 6 July, 28 September, 28 October, 17 November, 24, 25 and 26 December.
 * Good Friday is two days before Easter Sunday and Easter Monday one day after it. The function knows the
 * years 2016 to 2100 and returns no holidays for any other year.
 */
export function czechPublicHolidays(year: number): CzechPublicHoliday[] {
  if (!Number.isInteger(year) || year < FIRST_YEAR || year > LAST_YEAR) return [];
  const easter = easterSunday(year);
  const fixed = (month: number, day: number): string => isoDate(DateTime.utc(year, month, day));
  return [
    { key: "newYear", date: fixed(1, 1) },
    { key: "goodFriday", date: isoDate(easter.minus({ days: 2 })) },
    { key: "easterMonday", date: isoDate(easter.plus({ days: 1 })) },
    { key: "labourDay", date: fixed(5, 1) },
    { key: "victoryDay", date: fixed(5, 8) },
    { key: "cyrilAndMethodius", date: fixed(7, 5) },
    { key: "janHus", date: fixed(7, 6) },
    { key: "statehood", date: fixed(9, 28) },
    { key: "independence", date: fixed(10, 28) },
    { key: "freedomAndDemocracy", date: fixed(11, 17) },
    { key: "christmasEve", date: fixed(12, 24) },
    { key: "christmasDay", date: fixed(12, 25) },
    { key: "boxingDay", date: fixed(12, 26) },
  ];
}
