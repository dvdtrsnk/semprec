import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { isCalendarDate } from "../calendar/eventValidationHook.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import {
  resolveSleepNights,
  type ResolvedSleepNight,
  type SleepNightException,
  type SleepPlan,
} from "./resolveSleepNights.js";

/** The most nights one request may ask for, both ends of the range included. */
const MAX_NIGHTS = 62;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** The body of `GET /api/sleep/nights`. `nights` are the resolver's nights of the requested range. */
export interface SleepNightsResponse {
  enabled: boolean;
  showInCalendar: boolean;
  muteSemp: boolean;
  alarmSound: string;
  alarmSnooze: boolean;
  timezone: string;
  /** The number of non-deleted plans, whether or not any of them has a night in the range. */
  planCount: number;
  goalMinutes: number;
  nights: ResolvedSleepNight[];
}

interface SleepItemRow {
  id: string;
  properties: Record<string, unknown>;
}

/** The settings keys the route reads. The seed gives the settings item all of them; an item that lacks one fails the read. */
const settingsProperties = z.object({
  enabled: z.boolean(),
  showInCalendar: z.boolean(),
  muteSemp: z.boolean(),
  alarmSound: z.string(),
  alarmSnooze: z.boolean(),
  goalMinutes: z.number(),
  prepReminder: z.boolean(),
  prepReminderMinutes: z.number(),
});

/**
 * A plan. The write rules (`sleepWriteHooks.ts`) require `name`, `bedTime` and `wakeTime` only, so an absent
 * `wakeDays` is no day, an absent `alarm` is off and an absent `position` is 0.
 */
const planProperties = z.object({
  name: z.string(),
  wakeDays: z.array(z.string()).default([]),
  bedTime: z.string(),
  wakeTime: z.string(),
  alarm: z.boolean().default(false),
  position: z.number().default(0),
});

/** One night exception; an absent field becomes null, which the resolver reads as "follow the plan". */
const nightProperties = z.object({
  night: z.string(),
  bedTime: z.string().nullable().default(null),
  wakeTime: z.string().nullable().default(null),
  alarm: z.boolean().nullable().default(null),
});

/** The id of the tenant's system database `moduleId`, or a 404 when the tenant has none (no sleep module). */
async function sleepDatabaseId(client: PoolClient, moduleId: string): Promise<string> {
  const database = await getDatabaseByModuleId(client, moduleId);
  if (!database) throw new NotFoundError("The tenant has no sleep module");
  return database.id;
}

/** The non-deleted items of a database, ordered by id. With `range`, only those whose `night` is in it. */
async function liveItems(
  client: PoolClient,
  databaseId: string,
  range: { from: string; to: string } | null,
): Promise<SleepItemRow[]> {
  const { rows } = await client.query<SleepItemRow>(
    `SELECT id, properties FROM items
      WHERE database_id = $1 AND deleted_at IS NULL
        AND ($2::text IS NULL OR (properties ->> 'night') COLLATE "C" BETWEEN $2::text AND $3::text)
      ORDER BY id`,
    [databaseId, range?.from ?? null, range?.to ?? null],
  );
  return rows;
}

function toPlan(row: SleepItemRow): SleepPlan {
  return { id: row.id, ...planProperties.parse(row.properties) };
}

function toException(row: SleepItemRow): SleepNightException {
  return nightProperties.parse(row.properties);
}

/**
 * Throws a 400 `validation_failed` unless `from` and `to` are calendar dates `YYYY-MM-DD` that exist, `from` is
 * not after `to`, and the range holds at most 62 nights, both ends included. The field is `from` for a bad or
 * late `from`, and `to` for a bad `to` or a range of more than 62 nights.
 */
function assertNightsRange(from: string, to: string): void {
  if (!isCalendarDate(from)) throw new ValidationError("'from' must be a calendar date YYYY-MM-DD", { field: "from" });
  if (!isCalendarDate(to)) throw new ValidationError("'to' must be a calendar date YYYY-MM-DD", { field: "to" });
  if (from > to) throw new ValidationError("'from' must not be after 'to'", { field: "from" });
  const nights = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MILLISECONDS_PER_DAY + 1;
  if (nights > MAX_NIGHTS) {
    throw new ValidationError(`The range must not hold more than ${MAX_NIGHTS} nights`, { field: "to" });
  }
}

/**
 * The sleep settings, the tenant's time zone and the planned nights of `from`..`to` (inclusive) for the tenant
 * of `client`, in the shape of `GET /api/sleep/nights` (issue gh-1809).
 *
 * The nights are those of `resolveSleepNights` from the non-deleted plans and the non-deleted night
 * exceptions in the range, and they are computed also when `enabled` is false. The reads share the
 * transaction of `client`, which must be REPEATABLE READ (as `sleepNightsGet` opens it) for the settings, the
 * zone, the plans and the exceptions to describe one state of the data: under READ COMMITTED each statement
 * takes its own snapshot and a write that commits between two of them is seen by the later ones only.
 *
 * Throws a 400 `validation_failed` for a range that `assertNightsRange` refuses, before anything is read, and
 * a 404 `not_found` when the tenant has no sleep database or no non-deleted settings item. It also throws,
 * as a plain error, when the tenant has more than one non-deleted settings item, and a `ZodError` when a stored
 * settings, plan or exception item does not have the value types it is read with.
 */
export async function loadSleepNights(
  client: PoolClient,
  range: { from: string; to: string },
): Promise<SleepNightsResponse> {
  const { from, to } = range;
  assertNightsRange(from, to);

  const settingsItems = await liveItems(client, await sleepDatabaseId(client, SLEEP_SETTINGS_MODULE_ID), null);
  const [settingsItem] = settingsItems;
  if (!settingsItem) throw new NotFoundError("The tenant has no sleep settings");
  if (settingsItems.length > 1) {
    throw new Error(`Expected one sleep settings item, found ${settingsItems.length}`);
  }
  const { prepReminder, prepReminderMinutes, ...settings } = settingsProperties.parse(settingsItem.properties);

  const timezone = await getSystemTimezone(client);
  const plans = (await liveItems(client, await sleepDatabaseId(client, SLEEP_PLANS_MODULE_ID), null)).map(toPlan);
  const exceptions = (await liveItems(client, await sleepDatabaseId(client, SLEEP_NIGHTS_MODULE_ID), range)).map(
    toException,
  );
  const nights = resolveSleepNights({
    settings: { prepReminder, prepReminderMinutes },
    plans,
    nights: exceptions,
    from,
    to,
    timezone,
  });
  return { ...settings, timezone, planCount: plans.length, nights };
}

/** The request context of `GET /api/sleep/nights`: its query string is read from the request URL. */
interface SleepNightsRouteRequestContext {
  req: { url?: string };
}

function requiredParameter(parameters: URLSearchParams, name: "from" | "to"): string {
  const value = parameters.get(name);
  if (value === null) throw new ValidationError(`'${name}' is required`, { field: name });
  return value;
}

/**
 * `GET /api/sleep/nights?from=YYYY-MM-DD&to=YYYY-MM-DD` (issue gh-1809): the body of `loadSleepNights` for the
 * caller's tenant. Both parameters are required; a missing one, a range `loadSleepNights` refuses, and
 * anything else it throws are answered as that function documents. The reads run in one REPEATABLE READ
 * transaction, so the response describes one state of the data even when a write commits while it is read.
 * The export is the factory that `customRouteMount.ts` calls once with the pool, as for every custom route.
 */
export function sleepNightsGet(pool: Pool) {
  return async (ctx: SleepNightsRouteRequestContext): Promise<{ status: number; body: unknown }> => {
    const parameters = new URL(ctx.req.url ?? "/", "http://localhost").searchParams;
    const from = requiredParameter(parameters, "from");
    const to = requiredParameter(parameters, "to");
    const body = await withTransaction(pool, (client) => loadSleepNights(client, { from, to }), {
      isolation: "repeatable_read",
    });
    return { status: 200, body };
  };
}
