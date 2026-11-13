// The rules of a calendar row (issue #1778): the choke point's item create and update hooks for the Calendars
// system database. They keep the name of a system or subscription calendar, judge a written colour, and keep
// a create or an update from adding a second `isDefault` mark or removing the only one. Both run inside the
// write's transaction after the row is written, so a refusal rolls the write back. A third hook, the update
// pre-lock hook, takes the lock of the default mark before the update locks the written row.
// Constrained by: docs/adr/2026-11-12-calendar-rows-keep-one-default-under-an-advisory-lock.md,
// docs/adr/2026-11-12-an-update-takes-the-module-locks-before-it-locks-the-row.md,
// docs/adr/2026-10-09-item-create-domain-hooks.md,
// docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md
import type { PoolClient } from "pg";
import type { ItemCreateHook, ItemUpdateHook, ItemUpdatePreLockHook } from "../chokePoint/hooks.js";
import { updateItemWithClient, type UpdateItemWithClientOptions } from "../chokePoint/itemWrites.js";
import { ForbiddenError, ValidationError } from "../errors.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import type { DatabaseRow, ItemRow } from "../types.js";

const CALENDAR_COLOR = /^#[0-9A-Fa-f]{6}$/;

export function isCalendarsDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === CALENDARS_MODULE_ID;
}

/** Whether `kind` is `system` or `subscription`. Every other value, an absent one included, is one of the user's own calendars. */
export function isSystemOrSubscription(kind: unknown): boolean {
  return kind === "system" || kind === "subscription";
}

/**
 * Judges `color` when `values` names it: the value must be a string of the form `#RRGGBB`, six hexadecimal
 * digits in either case. `null` is refused too, so a write cannot remove a calendar's colour. A write that
 * does not name `color` is not judged.
 */
function assertCalendarColor(values: Record<string, unknown>): void {
  if (!Object.hasOwn(values, "color")) return;
  const color = values.color;
  if (typeof color !== "string" || !CALENDAR_COLOR.test(color)) {
    throw new ValidationError("Property 'color' of a calendar must be a color in #RRGGBB format", { field: "color" });
  }
}

/**
 * Takes the transaction-scoped advisory lock of the tenant's default mark, keyed by the calendars database
 * id, and holds it until the caller's transaction ends. Taking it again in the same transaction returns at
 * once. The statement text is the one the tests look for in `pg_stat_activity`.
 */
export async function lockDefaultMark(client: PoolClient, calendarsDatabaseId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('calendars-default:' || $1::text, 0))", [
    calendarsDatabaseId,
  ]);
}

/**
 * Takes the lock of the default mark (`lockDefaultMark`) and returns the live calendars other than
 * `calendarId` whose `isDefault` is true, in id order, each row locked `FOR UPDATE`. Both locks are held
 * until the caller's transaction ends.
 */
async function lockOtherDefaultCalendars(
  client: PoolClient,
  calendarsDatabaseId: string,
  calendarId: string,
): Promise<Array<{ id: string; kind: string | null }>> {
  await lockDefaultMark(client, calendarsDatabaseId);
  const { rows } = await client.query<{ id: string; kind: string | null }>(
    `SELECT id, properties->>'kind' AS kind FROM items
      WHERE database_id = $1 AND id <> $2 AND deleted_at IS NULL AND properties->'isDefault' = 'true'::jsonb
      ORDER BY id
      FOR UPDATE`,
    [calendarsDatabaseId, calendarId],
  );
  return rows;
}

/**
 * Makes `calendar`, whose row already holds `isDefault` true, the one default: clears the mark on every other
 * live calendar that holds it, each through `updateItemWithClient` with the writer of the outer write. A
 * system or subscription calendar is refused with `validation_failed` on `isDefault` before another calendar
 * is read. An update has taken the advisory lock already (`calendarItemUpdatePreLockHook`); a create takes it
 * here, when it reads the other marks.
 */
async function makeDefaultCalendar(
  client: PoolClient,
  calendar: ItemRow,
  options: Pick<UpdateItemWithClientOptions, "writer" | "humanWriterUserId">,
): Promise<void> {
  if (isSystemOrSubscription(calendar.properties.kind)) {
    throw new ValidationError("A system or subscription calendar cannot be the default calendar", {
      field: "isDefault",
    });
  }
  for (const other of await lockOtherDefaultCalendars(client, calendar.databaseId, calendar.id)) {
    await updateItemWithClient(
      client,
      { databaseId: calendar.databaseId, itemId: other.id, propertiesPatch: { isDefault: false } },
      options,
    );
  }
}

/**
 * The Calendars create rule, registered by `../domainWriteHooks.ts`. It runs after a real insert, judges the
 * stored properties and does nothing for another database: a named `color` must be `#RRGGBB`, and a calendar
 * created with `isDefault` true becomes the one default (`makeDefaultCalendar`). A calendar created without
 * that mark changes no other calendar and takes no lock.
 */
export const calendarItemCreateHook: ItemCreateHook = async ({
  client,
  database,
  item,
  properties,
  writer,
  humanWriterUserId,
}) => {
  if (!isCalendarsDatabase(database)) return;
  assertCalendarColor(properties);
  if (properties.isDefault === true) await makeDefaultCalendar(client, item, { writer, humanWriterUserId });
};

/**
 * The Calendars update pre-lock rule, registered by `../domainWriteHooks.ts` under the Calendars module id.
 * An update whose patch names `isDefault` takes the lock of the default mark before the choke point locks or
 * changes the written calendar's row, so every writer of the mark orders its locks as the advisory lock first
 * and the rows after, and two such writes cannot wait for each other. The later `calendarItemUpdateHook`
 * takes the same lock again, which returns at once. An update that does not name `isDefault` takes no lock.
 */
export const calendarItemUpdatePreLockHook: ItemUpdatePreLockHook = async ({ client, database, patch }) => {
  if (!isCalendarsDatabase(database)) return;
  if (Object.hasOwn(patch, "isDefault")) await lockDefaultMark(client, database.id);
};

/**
 * The Calendars update rule, registered by `../domainWriteHooks.ts`. It runs after the update, judges the
 * written patch against the row as the update left it, and does nothing for another database.
 *
 * - A patch that names `name` on a system or subscription calendar is refused with 403 `forbidden` on
 *   `name`, for every writer kind. The hook does not receive the row as it was before the update, so a patch
 *   that sends the stored name again is refused as well.
 * - A named `color` must be `#RRGGBB`.
 * - A patch that names `isDefault` with true makes the calendar the one default (`makeDefaultCalendar`). With
 *   any other value it is refused with `validation_failed` on `isDefault` unless another live own calendar
 *   holds the mark, whether or not this calendar held it before. The clearing that `makeDefaultCalendar`
 *   writes passes this check because the new default's row is written before it.
 */
export const calendarItemUpdateHook: ItemUpdateHook = async ({
  client,
  database,
  item,
  propertiesPatch,
  writer,
  humanWriterUserId,
}) => {
  if (!isCalendarsDatabase(database)) return;
  if (Object.hasOwn(propertiesPatch, "name") && isSystemOrSubscription(item.properties.kind)) {
    throw new ForbiddenError("The name of a system or subscription calendar cannot be changed", { field: "name" });
  }
  assertCalendarColor(propertiesPatch);
  if (!Object.hasOwn(propertiesPatch, "isDefault")) return;
  if (propertiesPatch.isDefault === true) {
    await makeDefaultCalendar(client, item, { writer, humanWriterUserId });
    return;
  }
  const others = await lockOtherDefaultCalendars(client, database.id, item.id);
  if (!others.some((other) => !isSystemOrSubscription(other.kind))) {
    throw new ValidationError("One of the user's own calendars must stay the default calendar", {
      field: "isDefault",
    });
  }
};
