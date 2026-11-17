// Calendar row rules: keep the name of a system or subscription calendar, judge `color`, and keep exactly one
// `isDefault` mark. The create/update hooks run in the write's transaction after the row is written, so a refusal
// rolls back. The update pre-lock hook takes the default-mark lock before the update locks the row.
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

/** Every other value, absent included, is one of the user's own calendars. */
export function isSystemOrSubscription(kind: unknown): boolean {
  return kind === "system" || kind === "subscription";
}

/** `null` is refused too, so a write cannot remove a calendar's colour. */
function assertCalendarColor(values: Record<string, unknown>): void {
  if (!Object.hasOwn(values, "color")) return;
  const color = values.color;
  if (typeof color !== "string" || !CALENDAR_COLOR.test(color)) {
    throw new ValidationError("Property 'color' of a calendar must be a color in #RRGGBB format", { field: "color" });
  }
}

/**
 * Transaction-scoped advisory lock of the tenant's default mark, keyed by the calendars database id. The
 * statement text is the one the tests look for in `pg_stat_activity`.
 */
export async function lockDefaultMark(client: PoolClient, calendarsDatabaseId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('calendars-default:' || $1::text, 0))", [
    calendarsDatabaseId,
  ]);
}

/** Rows locked `FOR UPDATE` in id order, after the advisory lock. */
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
      FOR NO KEY UPDATE`,
    [calendarsDatabaseId, calendarId],
  );
  return rows;
}

/**
 * Clears the mark on every other default calendar with the outer write's writer. An update already holds the
 * advisory lock (`calendarItemUpdatePreLockHook`); a create takes it here.
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

/** A calendar created without `isDefault` changes no other calendar and takes no lock. */
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
 * Takes the default-mark advisory lock before the choke point locks the row, so every writer of the mark locks
 * advisory-first, rows-after and two such writes cannot deadlock. The later update hook re-takes it at once.
 */
export const calendarItemUpdatePreLockHook: ItemUpdatePreLockHook = async ({ client, database, patch }) => {
  if (!isCalendarsDatabase(database)) return;
  if (Object.hasOwn(patch, "isDefault")) await lockDefaultMark(client, database.id);
};

/**
 * - `name` on a system or subscription calendar is a 403 for every writer kind. The hook does not see the old
 *   row, so resending the stored name is refused too.
 * - `isDefault: true` makes the calendar the one default. Any other value is refused unless another live own
 *   calendar holds the mark; `makeDefaultCalendar`'s clearing passes because the new default is written first.
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
