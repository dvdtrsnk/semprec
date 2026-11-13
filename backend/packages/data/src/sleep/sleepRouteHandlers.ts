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
  /** The id of the area the settings item's `area` edge points at, or null when it has none (issue gh-1833). */
  areaId: string | null;
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

/**
 * The id of the item the `area` edge of the settings item points at, or null when the item has no such edge.
 * The relation has no inverse property, so the settings item is always side A of its edges, and its cardinality
 * allows one. A target in the trash is still returned: trashing an item keeps its edges.
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
 * `areaId` is the target of the settings item's `area` edge (`settingsAreaId`), or null while a user has set none;
 * a tenant whose `sleepSettings` has no `area` property yet also answers null.
 *
 * The nights are those of `resolveSleepNights` from the non-deleted plans and the non-deleted night
 * exceptions in the range, and they are computed also when `enabled` is false. The reads share the
 * transaction of `client`, which must be REPEATABLE READ (as `sleepNightsGet` opens it) for the settings, the
 * zone, the plans and the exceptions to describe one state of the data: under READ COMMITTED each statement
 * takes its own snapshot and a write that commits between two of them is seen by the later ones only.
 * `sleepNightPut` calls it at READ COMMITTED and accepts that.
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

/** The part of the request context of `PUT /api/sleep/nights/:night` that the handler reads. */
interface SleepNightPutRequestContext {
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string } };
}

/** The fields of a night exception that a request may set, each as a value or null; a key the request omits is absent. */
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

/** The name `ValidationError` carries for a body that `nightPutBody` refused: the offending key, or `body` itself. */
function refusedBodyField(issue: z.core.$ZodIssue | undefined): string {
  if (issue?.code === "unrecognized_keys") return issue.keys[0] ?? "body";
  const key = issue?.path[0];
  return typeof key === "string" ? key : "body";
}

/**
 * The body of the PUT as the fields it sets. It must be an object with no other key than `bedTime`, `wakeTime`
 * and `alarm`; a time is `HH:MM` (`6:45` is read as `06:45`) or null, and `alarm` is a boolean or null. Anything
 * else, an empty string and `24:00` included, is a 400 `validation_failed` naming the key.
 */
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

/** The non-deleted exception of `night`, locked `FOR UPDATE`, or null when the night has none. */
async function lockNightException(client: PoolClient, databaseId: string, night: string): Promise<SleepItemRow | null> {
  const { rows } = await client.query<SleepItemRow>(
    `SELECT id, properties FROM items
      WHERE database_id = $1 AND deleted_at IS NULL AND properties ->> 'night' = $2
      ORDER BY id
        FOR UPDATE`,
    [databaseId, night],
  );
  return rows[0] ?? null;
}

/** Who makes a night write: the writer of the choke point and the users the write is attributed to (issue gh-1840). */
export interface SleepNightWriteOptions {
  writer: WriterIdentity;
  actingUserId: string;
  /** Set only for a human writer; the hooks that confine a write to humans read it. */
  humanWriterUserId?: string;
}

/**
 * Sets, changes or resets the exception of `night` and returns the resolved night (issue gh-1840; the body of the
 * transaction of `sleepNightPut`). `night` must be a calendar date and `fields` the output of `parseNightPutBody`;
 * `client` must be inside the caller's open transaction, which this function neither opens nor commits, at READ
 * COMMITTED (see below).
 *
 * It takes the per-night advisory lock (`lockSleepNight`, which the write hooks of the night exceptions take too),
 * then locks the non-deleted exception of the night `FOR UPDATE`. A generic update that names `night` takes the same
 * lock before it locks the row (`sleepNightUpdatePreLockHook`), so the two never wait for each other in opposite
 * orders.
 * - No exception and a non-null field: one is created with `night` and the fields.
 * - No exception and no non-null field (all null, or no field): nothing is written.
 * - An exception and a field that differs from the stored one (an absent stored field counts as null): the
 *   differing fields are patched without `ifVersion`. When none differs, nothing is written.
 * A field that is omitted is left as it is, and a field set to null follows the plan again: the exception stays with
 * that field null and is never deleted. Both writes go through the choke point with `writeOptions`, so its hooks,
 * validation and invalidation apply, and so does the per-database access of an agent writer
 * (`writeOptions.writer.agentProjectItemId`), which the choke point checks before it writes. That check does not
 * happen when nothing is written; a caller that must refuse an unauthorized agent also then checks the access itself.
 *
 * The answer is `{ night }`: the entry of `resolveSleepNights` for that date as `GET /api/sleep/nights` returns it, or
 * null when neither a plan nor an exception applies. It is read in the same transaction, which must run at READ
 * COMMITTED (a snapshot taken before the lock could not see an exception another writer committed meanwhile), so a
 * plan that another transaction commits during the response read is seen by the later reads only. Whatever
 * `loadSleepNights` throws for the read (a 404 for a tenant without a settings item, a `ZodError` for stored data
 * of the wrong type) is thrown after the writes and rolls them back with the caller's transaction.
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

/**
 * `PUT /api/sleep/nights/:night` (issue gh-1835): sets, changes or resets the exception of one night and answers
 * the resolved night. `:night` must be a calendar date `YYYY-MM-DD` and the body is `{ bedTime?, wakeTime?, alarm? }`
 * (see `parseNightPutBody`), otherwise the answer is a 400 `validation_failed` naming `night` or the key of the
 * body; both are judged before anything is read. A tenant without the sleep module gets a 404.
 *
 * In one transaction the handler calls `upsertSleepNight` as the signed-in user: it finds or creates the night's
 * exception, patches it and reads the resolved night, as that function documents. The answer is `{ night }`.
 * The export is the factory that `customRouteMount.ts` calls once with the pool.
 */
export function sleepNightPut(pool: Pool) {
  return async (ctx: SleepNightPutRequestContext): Promise<{ status: number; body: unknown }> => {
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
