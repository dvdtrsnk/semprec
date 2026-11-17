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

const wallClockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

/** An unset name or alarm reads as "" and false, as an unchecked checkbox does. */
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

/** An unset field becomes null, which the resolver reads as "follow the plan". */
const nightProperties = z.object({
  night: z.string().refine(isCalendarDate),
  bedTime: wallClockTime.nullish().transform((value) => value ?? null),
  wakeTime: wallClockTime.nullish().transform((value) => value ?? null),
  alarm: z
    .boolean()
    .nullish()
    .transform((value) => value ?? null),
});

interface SleepSettingsItem {
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
}

const MAX_PREP_REMINDER_MINUTES = 24 * 60;

const SKIP_MESSAGE = "Calendar timeline left out an item with an invalid stored value";

function dayBefore(date: string): string {
  const day = DateTime.fromISO(date, { zone: "utc" }).minus({ days: 1 }).toISODate();
  if (day === null) throw new Error("The day before the range is not a valid date");
  return day;
}

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

/** An invalid row is logged by property name, never its value, and left out. */
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

/** Of several settings items none is chosen. */
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

/** Invalid minutes with the reminder on are logged, so a reminder the user switched on never vanishes silently. */
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
 * Starts the day before `from`, so a night that begins the evening before is included. Entries are derived, not
 * item rows, yet not read-only: a night is edited on its own, not through the item routes. With `includeSleep`
 * false nothing is read, because the sleep databases are sensitive. Whether the Sleep calendar is hidden does not
 * matter.
 */
export async function readSleepTimelineItems(
  client: PoolClient,
  context: CalendarTimelineContext,
): Promise<CalendarSleepTimelineItem[]> {
  if (!context.includeSleep) return [];
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
