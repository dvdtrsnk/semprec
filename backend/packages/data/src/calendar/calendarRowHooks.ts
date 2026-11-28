// Calendar row rules: keep the name of a system or subscription calendar, judge `name` and `color`, let only the
// calendar sync write an account calendar's remote fields, and keep exactly one `isDefault` mark on an own calendar.
// The create/update hooks run in the write's transaction after the row is written, so a refusal rolls back. The
// update pre-lock hook takes the default-mark lock before the update locks the row.
import type { PoolClient } from "pg";
import type { ItemCreateHook, ItemUpdateHook, ItemUpdatePreLockHook } from "../chokePoint/hooks.js";
import { updateItemWithClient, type UpdateItemWithClientOptions } from "../chokePoint/itemWrites.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { ForbiddenError, ValidationError } from "../errors.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import type { DatabaseRow, ItemRow } from "../types.js";

const CALENDAR_COLOR = /^#[0-9A-Fa-f]{6}$/;

export function isCalendarsDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === CALENDARS_MODULE_ID;
}

export function isSystemOrSubscription(kind: unknown): boolean {
  return kind === "system" || kind === "subscription";
}

/** A calendar synced from an internet account. */
export function isAccountCalendar(kind: unknown): boolean {
  return kind === "account";
}

/** Absent and empty are `own` too. */
export function isOwnCalendar(kind: unknown): boolean {
  return kind === undefined || kind === null || kind === "" || kind === "own";
}

/** Written by the calendar sync only, on an account calendar only. */
const ACCOUNT_CALENDAR_REMOTE_KEYS = ["remoteName", "remoteColor", "readOnly"] as const;

/**
 * `null` stands for the provider's value on an account calendar and is refused on any other, so a write cannot remove
 * a calendar's name or colour. The choke point already refuses a blank title from a user or agent.
 */
function assertCalendarNameAndColor(values: Record<string, unknown>, kind: unknown): void {
  const remoteFallback = isAccountCalendar(kind);
  if (Object.hasOwn(values, "name")) {
    const name = values.name;
    if (!(name === null && remoteFallback) && (typeof name !== "string" || name.trim() === "")) {
      throw new ValidationError("Property 'name' of a calendar must be a non-empty title", { field: "name" });
    }
  }
  if (Object.hasOwn(values, "color")) {
    const color = values.color;
    if (!(color === null && remoteFallback) && (typeof color !== "string" || !CALENDAR_COLOR.test(color))) {
      throw new ValidationError("Property 'color' of a calendar must be a color in #RRGGBB format", { field: "color" });
    }
  }
}

/**
 * The choke point admits a system-owned key for any process of the calendar module; an account calendar and its
 * remote fields belong to the calendar sync alone. `kind` is the stored kind after the write.
 */
function assertAccountCalendarFieldsWriter(
  values: Record<string, unknown>,
  kind: unknown,
  writer: WriterIdentity,
  creates: boolean,
): void {
  const remoteKeys = ACCOUNT_CALENDAR_REMOTE_KEYS.filter((key) => Object.hasOwn(values, key));
  if (remoteKeys.length > 0 && !isAccountCalendar(kind)) {
    throw new ValidationError("Only an account calendar has remote fields", { field: remoteKeys[0] });
  }
  const writesAccountKind = creates && isAccountCalendar(kind);
  if ((remoteKeys.length > 0 || writesAccountKind) && writer.systemProcess !== "calendarSync") {
    throw new ForbiddenError(
      "An account calendar and its remote fields are written by the calendar sync only",
      { field: remoteKeys[0] ?? "kind" },
      "owner_violation",
    );
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
  if (!isOwnCalendar(calendar.properties.kind)) {
    const message = isAccountCalendar(calendar.properties.kind)
      ? "An account calendar cannot be the default calendar"
      : "A system or subscription calendar cannot be the default calendar";
    throw new ValidationError(message, { field: "isDefault" });
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
  assertAccountCalendarFieldsWriter(properties, item.properties.kind, writer, true);
  assertCalendarNameAndColor(properties, item.properties.kind);
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
 *   row, so resending the stored name is refused too. An account calendar's `name` is the user's local override.
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
  assertAccountCalendarFieldsWriter(propertiesPatch, item.properties.kind, writer, false);
  assertCalendarNameAndColor(propertiesPatch, item.properties.kind);
  if (!Object.hasOwn(propertiesPatch, "isDefault")) return;
  if (propertiesPatch.isDefault === true) {
    await makeDefaultCalendar(client, item, { writer, humanWriterUserId });
    return;
  }
  const others = await lockOtherDefaultCalendars(client, database.id, item.id);
  if (!others.some((other) => isOwnCalendar(other.kind))) {
    throw new ValidationError("One of the user's own calendars must stay the default calendar", {
      field: "isDefault",
    });
  }
};
