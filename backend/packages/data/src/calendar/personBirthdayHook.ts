import type { ItemCreateHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import { PEOPLE_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { DatabaseRow } from "../types.js";
import { isCalendarDate } from "./eventValidationHook.js";

function isPeopleDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === PEOPLE_MODULE_ID;
}

/**
 * Year 0001 or later, so a People view sorted or filtered by it never fails a cast: Postgres has no year 0. A person
 * whose year is unknown stores a placeholder leap year, which makes 29 February storable.
 */
function assertBirthday(value: unknown): void {
  if (value === null || (isCalendarDate(value) && Number(value.slice(0, 4)) >= 1)) return;
  throw new ValidationError("Property 'birthday' must be a calendar date YYYY-MM-DD", { field: "birthday" });
}

export const personBirthdayItemCreateHook: ItemCreateHook = async ({ database, properties }) => {
  if (!isPeopleDatabase(database)) return;
  if (Object.hasOwn(properties, "birthday")) assertBirthday(properties.birthday);
};

/** A patch without `birthday` passes unchecked, keeping a person editable while a stored birthday is unreadable. */
export const personBirthdayItemUpdateHook: ItemUpdateHook = async ({ database, propertiesPatch }) => {
  if (!isPeopleDatabase(database)) return;
  if (Object.hasOwn(propertiesPatch, "birthday")) assertBirthday(propertiesPatch.birthday);
};
