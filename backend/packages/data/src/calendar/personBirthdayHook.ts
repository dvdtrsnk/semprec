import type { ItemCreateHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import { PEOPLE_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { DatabaseRow } from "../types.js";
import { isCalendarDate } from "./eventValidationHook.js";

function isPeopleDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === PEOPLE_MODULE_ID;
}

/**
 * A written `birthday` is `null` (no birthday) or a string `YYYY-MM-DD` that is a real calendar date from year
 * 0001 on, so a People view sorted or filtered by it never casts an unreadable value: Postgres has no year 0
 * and `'0000-01-01'::date` fails. Otherwise the year is not judged: a person whose year is unknown stores a
 * placeholder leap year, which makes 29 February storable.
 */
function assertBirthday(value: unknown): void {
  if (value === null || (isCalendarDate(value) && Number(value.slice(0, 4)) >= 1)) return;
  throw new ValidationError("Property 'birthday' must be a calendar date YYYY-MM-DD", { field: "birthday" });
}

/**
 * The People create rule of issue #1795, registered by `../domainWriteHooks.ts`: a `birthday` in the written
 * properties passes `assertBirthday`. A create that names no `birthday` passes unchecked. A rejection is a
 * `ValidationError` naming the field, which rolls the insert back and which REST answers as 400
 * `validation_failed`.
 */
export const personBirthdayItemCreateHook: ItemCreateHook = async ({ database, properties }) => {
  if (!isPeopleDatabase(database)) return;
  if (Object.hasOwn(properties, "birthday")) assertBirthday(properties.birthday);
};

/**
 * The People update rule of issue #1795, registered by `../domainWriteHooks.ts`: a `birthday` in the patch
 * passes `assertBirthday`. A patch that names no `birthday` passes unchecked, which keeps a person editable
 * while a stored birthday is unreadable.
 */
export const personBirthdayItemUpdateHook: ItemUpdateHook = async ({ database, propertiesPatch }) => {
  if (!isPeopleDatabase(database)) return;
  if (Object.hasOwn(propertiesPatch, "birthday")) assertBirthday(propertiesPatch.birthday);
};
