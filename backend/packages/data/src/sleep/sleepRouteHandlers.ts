import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { isCalendarDate } from "../calendar/eventValidationHook.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import {
  SLEEP_NIGHTS_MODULE_ID,
  SLEEP_PLANS_MODULE_ID,
  SLEEP_SETTINGS_AREA_KEY,
  SLEEP_SETTINGS_MODULE_ID,
} from "../seed/sleepModuleKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { normalizeWallClockTime } from "../timezone.js";
import {
  resolveSleepNights,
  type ResolvedSleepNight,
  type SleepNightException,
  type SleepPlan,
} from "./resolveSleepNights.js";
import { lockSleepNight } from "./sleepWriteHooks.js";
import type { CustomRouteResult, RouteParams, RouteBody, RouteUser, RouteUrl } from "../customRoute.js";
import { requestUrl } from "../customRoute.js";

const MAX_NIGHTS = 62;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

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
  /** Target of the settings item's `area` edge, or null when it has none. */
  areaId: string | null;
  nights: ResolvedSleepNight[];
}

interface SleepItemRow {
  id: string;
  properties: Record<string, unknown>;
}

/** The seed gives the settings item all of these; an item lacking one fails the read. */
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

/** The write rules require only `name`, `bedTime` and `wakeTime`, hence the defaults. */
const planProperties = z.object({
  name: z.string(),
  wakeDays: z.array(z.string()).default([]),
  bedTime: z.string(),
  wakeTime: z.string(),
  alarm: z.boolean().default(false),
  position: z.number().default(0),
});

/** An absent field becomes null, which the resolver reads as "follow the plan". */
const nightProperties = z.object({
  night: z.string(),
  bedTime: z.string().nullable().default(null),
  wakeTime: z.string().nullable().default(null),
  alarm: z.boolean().nullable().default(null),
});

async function sleepDatabaseId(client: PoolClient, moduleId: string): Promise<string> {
  const database = await getDatabaseByModuleId(client, moduleId);
  if (!database) throw new NotFoundError("The tenant has no sleep module");
  return database.id;
}

/**
 * The relation has no inverse property, so the settings item is always side A. A trashed target is still
 * returned: trashing an item keeps its edges.
 */
async function settingsAreaId(
  client: PoolClient,
  settingsDatabaseId: string,
  settingsItemId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ area_id: string }>(
    `SELECT edge.item_b AS area_id
       FROM properties property
       JOIN relation_definitions definition ON definition.property_id_a = property.id
       JOIN item_relations edge ON edge.relation_definition_id = definition.id
      WHERE property.database_id = $1 AND property.key = $2 AND edge.item_a = $3
      LIMIT 1`,
    [settingsDatabaseId, SLEEP_SETTINGS_AREA_KEY, settingsItemId],
  );
  return rows[0]?.area_id ?? null;
}

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
 * The reads must share one REPEATABLE READ transaction (as `sleepNightsGet` opens it) to describe one state;
 * under READ COMMITTED a write committing between statements is seen by later reads only. `sleepNightPut` calls
 * it at READ COMMITTED and accepts that. Nights are computed even when `enabled` is false. More than one live
 * settings item is a plain error.
 */
export async function loadSleepNights(
  client: PoolClient,
  range: { from: string; to: string },
): Promise<SleepNightsResponse> {
  const { from, to } = range;
  assertNightsRange(from, to);

  const settingsDatabaseId = await sleepDatabaseId(client, SLEEP_SETTINGS_MODULE_ID);
  const settingsItems = await liveItems(client, settingsDatabaseId, null);
  const [settingsItem] = settingsItems;
  if (!settingsItem) throw new NotFoundError("The tenant has no sleep settings");
  if (settingsItems.length > 1) {
    throw new Error(`Expected one sleep settings item, found ${settingsItems.length}`);
  }
  const { prepReminder, prepReminderMinutes, ...settings } = settingsProperties.parse(settingsItem.properties);

  const areaId = await settingsAreaId(client, settingsDatabaseId, settingsItem.id);
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
  return { ...settings, timezone, planCount: plans.length, areaId, nights };
}

function requiredParameter(parameters: URLSearchParams, name: "from" | "to"): string {
  const value = parameters.get(name);
  if (value === null) throw new ValidationError(`'${name}' is required`, { field: name });
  return value;
}

/** Factory called once with the pool by `customRouteMount.ts`. */
export function sleepNightsGet(pool: Pool) {
  return async (ctx: RouteUrl): Promise<CustomRouteResult> => {
    const parameters = requestUrl(ctx.req).searchParams;
    const from = requiredParameter(parameters, "from");
    const to = requiredParameter(parameters, "to");
    const body = await withTransaction(pool, (client) => loadSleepNights(client, { from, to }), {
      isolation: "repeatable_read",
    });
    return { status: 200, body };
  };
}

/** A key the request omits is absent; null means "follow the plan". */
export interface SleepNightFields {
  bedTime?: string | null;
  wakeTime?: string | null;
  alarm?: boolean | null;
}

const FIELD_KEYS = ["bedTime", "wakeTime", "alarm"] as const;

const nightPutBody = z.strictObject({
  bedTime: z.string().nullable().optional(),
  wakeTime: z.string().nullable().optional(),
  alarm: z.boolean().nullable().optional(),
});

function refusedBodyField(issue: z.core.$ZodIssue | undefined): string {
  if (issue?.code === "unrecognized_keys") return issue.keys[0] ?? "body";
  const key = issue?.path[0];
  return typeof key === "string" ? key : "body";
}

/** `6:45` is read as `06:45`; an empty string or `24:00` is a 400 naming the key. */
export function parseNightPutBody(body: unknown): SleepNightFields {
  const parsed = nightPutBody.safeParse(body);
  if (!parsed.success) {
    const field = refusedBodyField(parsed.error.issues[0]);
    throw new ValidationError("The body must hold only bedTime, wakeTime and alarm, each a valid value or null", {
      field,
    });
  }
  const fields: SleepNightFields = {};
  for (const key of ["bedTime", "wakeTime"] as const) {
    const value = parsed.data[key];
    if (value === undefined) continue;
    const time = value === null ? null : normalizeWallClockTime(value, { field: key, allow2400: false });
    if (value !== null && time === null) {
      throw new ValidationError(`Property '${key}' must be a time HH:MM or null`, { field: key });
    }
    fields[key] = time;
  }
  if (parsed.data.alarm !== undefined) fields.alarm = parsed.data.alarm;
  return fields;
}

async function lockNightException(client: PoolClient, databaseId: string, night: string): Promise<SleepItemRow | null> {
  const { rows } = await client.query<SleepItemRow>(
    `SELECT id, properties FROM items
      WHERE database_id = $1 AND deleted_at IS NULL AND properties ->> 'night' = $2
      ORDER BY id
        FOR NO KEY UPDATE`,
    [databaseId, night],
  );
  return rows[0] ?? null;
}

export interface SleepNightWriteOptions {
  writer: WriterIdentity;
  actingUserId: string;
  /** Set only for a human writer; the hooks that confine a write to humans read it. */
  humanWriterUserId?: string;
}

/**
 * Runs inside the caller's READ COMMITTED transaction: a snapshot taken before the lock could not see an
 * exception another writer committed meanwhile.
 *
 * Lock order is the per-night advisory lock, then the exception row `FOR NO KEY UPDATE`; a generic update naming
 * `night` takes the same order (`sleepNightUpdatePreLockHook`), so the two cannot deadlock. Only differing fields
 * are written (no `ifVersion`); an exception is never deleted, a null field follows the plan. Writes go through
 * the choke point, which checks an agent writer's database access, but that check does not happen when nothing is
 * written; a caller that must refuse an unauthorized agent checks it itself. A failure of the final read rolls
 * the writes back with the caller's transaction.
 */
export async function upsertSleepNight(
  client: PoolClient,
  input: { night: string; fields: SleepNightFields },
  writeOptions: SleepNightWriteOptions,
): Promise<{ night: ResolvedSleepNight | null }> {
  const { night, fields } = input;
  const databaseId = await sleepDatabaseId(client, SLEEP_NIGHTS_MODULE_ID);
  await lockSleepNight(client, night);
  const existing = await lockNightException(client, databaseId, night);
  const provided = FIELD_KEYS.flatMap((key) => (fields[key] === undefined ? [] : [[key, fields[key]] as const]));
  if (!existing) {
    if (provided.some(([, value]) => value !== null)) {
      await createItemWithClient(
        client,
        { databaseId, properties: { night, ...Object.fromEntries(provided) } },
        writeOptions,
      );
    }
  } else {
    const differing = provided.filter(([key, value]) => (existing.properties[key] ?? null) !== value);
    if (differing.length > 0) {
      await updateItemWithClient(
        client,
        { databaseId, itemId: existing.id, propertiesPatch: Object.fromEntries(differing) },
        writeOptions,
      );
    }
  }
  const { nights } = await loadSleepNights(client, { from: night, to: night });
  return { night: nights[0] ?? null };
}

/** Factory called once with the pool by `customRouteMount.ts`; path and body are validated before any read. */
export function sleepNightPut(pool: Pool) {
  return async (ctx: RouteParams & RouteBody & RouteUser): Promise<CustomRouteResult> => {
    const night = ctx.params.night;
    if (!isCalendarDate(night)) {
      throw new ValidationError("'night' must be a calendar date YYYY-MM-DD", { field: "night" });
    }
    const fields = parseNightPutBody(ctx.body);
    const userId = ctx.identity.user.id;
    const writeOptions = {
      writer: { writerKind: "user" },
      actingUserId: userId,
      humanWriterUserId: userId,
    } as const;
    const body = await withTransaction(pool, (client) => upsertSleepNight(client, { night, fields }, writeOptions));
    return { status: 200, body };
  };
}
