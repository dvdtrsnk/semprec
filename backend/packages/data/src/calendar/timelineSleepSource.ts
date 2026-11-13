import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import {
  resolveSleepNights,
  type SleepNightException,
  type SleepNightsSettings,
  type SleepPlan,
} from "../sleep/resolveSleepNights.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { logger } from "./logger.js";
import type { CalendarSleepTimelineItem, CalendarTimelineContext } from "./timelineSources.js";

interface SleepItemRow {
  id: string;
  properties: Record<string, unknown>;
}

/** A wall-clock time `HH:MM` the resolver accepts: `00:00` to `23:59`. */
const wallClockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

/** The plan values the resolver reads; an unset name or alarm reads as "" and false, as an unchecked checkbox does. */
const planProperties = z.object({
  name: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
  wakeDays: z.array(z.string()),
  bedTime: wallClockTime,
  wakeTime: wallClockTime,
  alarm: z
    .boolean()
    .nullish()
    .transform((value) => value ?? false),
  position: z.number(),
});

/** One night exception; an unset field becomes null, which the resolver reads as "follow the plan". */
const nightProperties = z.object({
  night: z.string().refine(isCalendarDate),
  bedTime: wallClockTime.nullish().transform((value) => value ?? null),
  wakeTime: wallClockTime.nullish().transform((value) => value ?? null),
  alarm: z
    .boolean()
    .nullish()
    .transform((value) => value ?? null),
});

/** The one live sleep settings item of the tenant and the database that holds it. */
interface SleepSettingsItem {
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
}

/** The longest bedtime reminder lead time the source passes on. */
const MAX_PREP_REMINDER_MINUTES = 24 * 60;

const SKIP_MESSAGE = "Calendar timeline left out an item with an invalid stored value";

/** The day before `date` (`YYYY-MM-DD`), which the caller has checked to be a calendar date. */
function dayBefore(date: string): string {
  const day = DateTime.fromISO(date, { zone: "utc" }).minus({ days: 1 }).toISODate();
  if (day === null) throw new Error("The day before the range is not a valid date");
  return day;
}

/**
 * The non-deleted items of one sleep database of the tenant, ordered by id; none when the tenant has no such
 * database. With `nights`, only the items whose `night` is between its two dates, both included.
 */
async function liveItems(
  client: PoolClient,
  moduleId: string,
  nights: { from: string; to: string } | null = null,
): Promise<{ databaseId: string; rows: SleepItemRow[] }> {
  const database = await getDatabaseByModuleId(client, moduleId);
  if (!database) return { databaseId: "", rows: [] };
  const { rows } = await client.query<SleepItemRow>(
    `SELECT id, properties FROM items
      WHERE database_id = $1 AND deleted_at IS NULL
        AND ($2::text IS NULL OR (properties ->> 'night' COLLATE "C" BETWEEN $2 AND $3))
      ORDER BY id`,
    [database.id, nights?.from ?? null, nights?.to ?? null],
  );
  return { databaseId: database.id, rows };
}

/**
 * Parses each row with `schema`. A row that does not parse is left out, with one log line that carries its id,
 * its database and the name of its first invalid property, never its value.
 */
function parseRows<T>(databaseId: string, rows: SleepItemRow[], schema: z.ZodType<T>): { id: string; value: T }[] {
  const parsed: { id: string; value: T }[] = [];
  for (const row of rows) {
    const result = schema.safeParse(row.properties);
    if (result.success) {
      parsed.push({ id: row.id, value: result.data });
      continue;
    }
    logger.warn({ itemId: row.id, databaseId, property: String(result.error.issues[0]?.path[0] ?? "") }, SKIP_MESSAGE);
  }
  return parsed;
}

/**
 * The sleep settings item the source reads, or `null` when the tenant has none or more than one. Of several
 * settings items none is chosen: the read leaves the nights out and logs the count.
 */
async function readSettings(client: PoolClient): Promise<SleepSettingsItem | null> {
  const { databaseId, rows } = await liveItems(client, SLEEP_SETTINGS_MODULE_ID);
  if (rows.length > 1) {
    logger.warn(
      { databaseId, count: rows.length },
      "Calendar timeline left out the sleep nights: several settings items",
    );
  }
  const only = rows.length === 1 ? rows[0] : undefined;
  return only ? { id: only.id, databaseId, properties: only.properties } : null;
}

/**
 * The reminder lead time the source passes to the resolver: the settings' `prepReminderMinutes` when the
 * reminder is switched on (`prepReminder` is `true`) and the minutes are a whole number from 0 to 1440, a day.
 * With the reminder off, the nights carry no `prepReminderAt`. With the reminder on and minutes that are
 * missing or outside that range, they carry none either, and the source logs one line with the settings
 * item id, its database and the property name, never the value, so that a reminder the user switched on
 * does not vanish without a trace.
 */
function readPrepReminder(settings: SleepSettingsItem): SleepNightsSettings {
  const { prepReminder, prepReminderMinutes: minutes } = settings.properties;
  if (prepReminder !== true) return { prepReminder: false, prepReminderMinutes: 0 };
  if (
    typeof minutes === "number" &&
    Number.isInteger(minutes) &&
    minutes >= 0 &&
    minutes <= MAX_PREP_REMINDER_MINUTES
  ) {
    return { prepReminder: true, prepReminderMinutes: minutes };
  }
  logger.warn(
    { itemId: settings.id, databaseId: settings.databaseId, property: "prepReminderMinutes" },
    "Calendar timeline left out the bedtime reminder: the lead time is not a whole number of minutes from 0 to 1440",
  );
  return { prepReminder: false, prepReminderMinutes: 0 };
}

/**
 * The sleep source of the calendar timeline (issue #1806): one entry per planned night. For the range
 * `from`..`to` it asks `resolveSleepNights` for the nights from the day before `from` to `to`, in the tenant
 * time zone, so that a night that starts the evening before `from` and ends inside the range is included. A
 * night that crosses midnight is one entry; its day in the order of the merge is its `night`. The entries are
 * not stored rows and their ids are not item ids; they are not read-only, because a night is edited on its own
 * and not through the item routes (docs/adr/2026-11-12-a-sleep-night-in-the-timeline-is-a-derived-entry-the-user-edits.md).
 *
 * It returns nothing when the tenant has no sleep settings item, when `enabled` or `showInCalendar` of that
 * item is not `true`, and when the tenant has several settings items; the plans and the night items are then
 * not read. Whether the Sleep calendar is hidden does not matter. A plan or a night exception that does not
 * have the value types of `planProperties` or `nightProperties` is left out with one log line, so one broken
 * row never fails the timeline.
 */
export async function readSleepTimelineItems(
  client: PoolClient,
  context: CalendarTimelineContext,
): Promise<CalendarSleepTimelineItem[]> {
  const settings = await readSettings(client);
  if (settings === null || settings.properties.enabled !== true || settings.properties.showInCalendar !== true)
    return [];

  const from = dayBefore(context.from);
  const planItems = await liveItems(client, SLEEP_PLANS_MODULE_ID);
  const plans: SleepPlan[] = parseRows(planItems.databaseId, planItems.rows, planProperties).map(({ id, value }) => ({
    id,
    ...value,
  }));
  const nightItems = await liveItems(client, SLEEP_NIGHTS_MODULE_ID, { from, to: context.to });
  const nights: SleepNightException[] = parseRows(nightItems.databaseId, nightItems.rows, nightProperties).map(
    ({ value }) => value,
  );

  return resolveSleepNights({
    settings: readPrepReminder(settings),
    plans,
    nights,
    from,
    to: context.to,
    timezone: context.timezone,
  }).map((night) => ({
    kind: "sleep",
    id: `sleep:${night.night}`,
    night: night.night,
    planId: night.planId,
    bedTime: night.bedTime,
    wakeTime: night.wakeTime,
    alarm: night.alarm,
    changed: night.changed,
    bedAt: night.bedAt,
    wakeAt: night.wakeAt,
    prepReminderAt: night.prepReminderAt,
    readOnly: false,
  }));
}
