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

const planProperties = z.object({
  wakeDays: z.array(z.string()),
  bedTime: z.string(),
  wakeTime: z.string(),
  position: z.number(),
});

/** An unset field becomes null, which the resolver reads as "follow the plan". */
const nightProperties = z.object({
  night: z.string(),
  bedTime: z.string().nullable().default(null),
  wakeTime: z.string().nullable().default(null),
  alarm: z.boolean().nullable().default(null),
});

const NO_PREP_REMINDER: SleepNightsSettings = { prepReminder: false, prepReminderMinutes: 0 };

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}

/** None when the tenant has no such database. */
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
  // Name and alarm do not affect the window.
  return { id: row.id, name: "", alarm: false, ...planProperties.parse(row.properties) };
}

function toException(row: SleepItemRow): SleepNightException {
  return nightProperties.parse(row.properties);
}

/**
 * The latest wake time among the nights (yesterday's and today's, tenant zone) whose window `[bedAt, wakeAt)`
 * contains `now`, or `null`. A night without an alarm has a window too. `null` without reading plans when there is
 * no settings item or `enabled`/`muteSemp` is not `true`. Failures propagate; the caller decides what they mean.
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
