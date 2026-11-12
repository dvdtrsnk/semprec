import type { PoolClient } from "pg";
import { z } from "zod";
import { today } from "../calendarTime.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import {
  resolveSleepNights,
  type SleepNightException,
  type SleepNightsSettings,
  type SleepPlan,
} from "./resolveSleepNights.js";

interface SleepItemRow {
  id: string;
  properties: Record<string, unknown>;
}

/** The plan values a sleep window depends on. */
const planProperties = z.object({
  wakeDays: z.array(z.string()),
  bedTime: z.string(),
  wakeTime: z.string(),
  position: z.number(),
});

/** One night exception; an unset field becomes null, which the resolver reads as "follow the plan". */
const nightProperties = z.object({
  night: z.string(),
  bedTime: z.string().nullable().default(null),
  wakeTime: z.string().nullable().default(null),
  alarm: z.boolean().nullable().default(null),
});

/** A sleep window does not depend on the bedtime reminder, so the resolver is asked for none. */
const NO_PREP_REMINDER: SleepNightsSettings = { prepReminder: false, prepReminderMinutes: 0 };

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** The calendar date before `date` (`YYYY-MM-DD`). */
function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The non-deleted items of one sleep database of the tenant, ordered by id; none when the tenant has no such
 * database. With `nights`, only the items whose `night` is one of those dates.
 */
async function liveItems(
  client: PoolClient,
  moduleId: string,
  nights: readonly string[] | null = null,
): Promise<SleepItemRow[]> {
  const database = await getDatabaseByModuleId(client, moduleId);
  if (!database) return [];
  const { rows } = await client.query<SleepItemRow>(
    `SELECT id, properties FROM items
      WHERE database_id = $1 AND deleted_at IS NULL
        AND ($2::text[] IS NULL OR properties ->> 'night' = ANY($2::text[]))
      ORDER BY id`,
    [database.id, nights],
  );
  return rows;
}

function toPlan(row: SleepItemRow): SleepPlan {
  // A plan's name and alarm do not change its window, so they are not read from the row.
  return { id: row.id, name: "", alarm: false, ...planProperties.parse(row.properties) };
}

function toException(row: SleepItemRow): SleepNightException {
  return nightProperties.parse(row.properties);
}

/**
 * Until when Semp stays quiet for the tenant of `client` (issue #1794): the latest wake time among the nights
 * whose sleep window contains `now`, or `null` when Semp is not to stay quiet.
 *
 * A window runs from a night's bedtime, inclusive, to its wake time, exclusive. The nights named yesterday and
 * today in the tenant's time zone are resolved with `resolveSleepNights` from the tenant's non-deleted plans
 * and night exceptions, so a night without an alarm has a window like any other.
 *
 * Returns `null` when the tenant has no sleep settings item, and when `enabled` or `muteSemp` of that item is
 * not `true`; the plans and exceptions are then not read.
 *
 * Throws when the tenant has more than one non-deleted settings item, when a stored plan or exception does not
 * have the value types of `planProperties` or `nightProperties`, and with whatever the time zone lookup and the
 * resolver throw. The caller decides what such a failure means.
 */
export async function findSleepMuteUntil(client: PoolClient, now: Date): Promise<Date | null> {
  const settingsItems = await liveItems(client, SLEEP_SETTINGS_MODULE_ID);
  const [settings] = settingsItems;
  if (!settings) return null;
  if (settingsItems.length > 1) {
    throw new Error(`Expected one sleep settings item, found ${settingsItems.length}`);
  }
  if (settings.properties.enabled !== true || settings.properties.muteSemp !== true) return null;

  const timezone = await getSystemTimezone(client);
  const to = today(timezone, now);
  const from = dayBefore(to);
  const plans = (await liveItems(client, SLEEP_PLANS_MODULE_ID)).map(toPlan);
  const nights = (await liveItems(client, SLEEP_NIGHTS_MODULE_ID, [from, to])).map(toException);
  const resolved = resolveSleepNights({ settings: NO_PREP_REMINDER, plans, nights, from, to, timezone });

  const instant = now.getTime();
  const wakeTimes = resolved
    .filter((night) => Date.parse(night.bedAt) <= instant && instant < Date.parse(night.wakeAt))
    .map((night) => Date.parse(night.wakeAt));
  return wakeTimes.length === 0 ? null : new Date(Math.max(...wakeTimes));
}
