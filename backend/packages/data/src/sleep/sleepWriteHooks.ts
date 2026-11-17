import { DatabaseError, type PoolClient } from "pg";
import type {
  ItemCreateHook,
  ItemCreateHookContext,
  ItemDeleteHook,
  ItemPreWritePreparation,
  ItemPreWriteTransform,
  ItemRestoreHook,
  ItemUpdateHook,
  ItemUpdatePreLockHook,
} from "../chokePoint/hooks.js";
import { isCalendarDate } from "../calendar/eventValidationHook.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { requireSingleRow } from "../db/pool.js";
import { ConflictError, DuplicateItemError, ValidationError } from "../errors.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import { normalizeWallClockTime } from "../timezone.js";
import { enqueueSleepResync } from "./sleepResync.js";

const TIME_KEYS = ["bedTime", "wakeTime"] as const;

const SETTINGS_BOOLEAN_KEYS = ["enabled", "prepReminder", "muteSemp", "alarmSnooze", "showInCalendar"] as const;
const GOAL_MINUTES = [420, 450, 480, 510, 540];
const PREP_REMINDER_MINUTES = [15, 30, 45, 60];
const WAKE_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** A stored zero-padded 24-hour time. `24:00` is not a sleep time. */
const SLEEP_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Normalizes `bedTime`/`wakeTime` to zero-padded `HH:MM`; an empty value becomes `null` ("follow the plan" on a
 * night, refused on a plan). `24:00` and unreadable values are a 400. Pure, so proposals share it.
 */
function normalizeSleepTimes(patch: Record<string, unknown>): Record<string, unknown> {
  const output = { ...patch };
  for (const key of TIME_KEYS) {
    if (!Object.hasOwn(output, key)) continue;
    output[key] = normalizeWallClockTime(output[key], { field: key, allow2400: false });
  }
  return output;
}

export const sleepPreWriteTransform: ItemPreWriteTransform = async ({ patch }) => normalizeSleepTimes(patch);

/** Proposal preparation of `sleepPreWriteTransform`: reads no row and allocates nothing. */
export const prepareSleepWrite: ItemPreWritePreparation = async ({ patch }) => ({
  patch: normalizeSleepTimes(patch),
  deferredKeys: [],
});

function invalid(field: string, rule: string): ValidationError {
  return new ValidationError(`Property '${field}' ${rule}`, { field });
}

function isOneOf(value: unknown, allowed: readonly (string | number)[]): boolean {
  return allowed.some((candidate) => candidate === value);
}

function isSleepTime(value: unknown): boolean {
  return typeof value === "string" && SLEEP_TIME_PATTERN.test(value);
}

/** An absent key is not judged; `alarmSound` is checked by the choke point against its option catalog. */
function validateSleepSettings(properties: Record<string, unknown>): void {
  for (const key of SETTINGS_BOOLEAN_KEYS) {
    if (Object.hasOwn(properties, key) && typeof properties[key] !== "boolean") {
      throw invalid(key, "must be a boolean");
    }
  }
  if (Object.hasOwn(properties, "goalMinutes") && !isOneOf(properties.goalMinutes, GOAL_MINUTES)) {
    throw invalid("goalMinutes", `must be one of ${GOAL_MINUTES.join(", ")}`);
  }
  if (
    Object.hasOwn(properties, "prepReminderMinutes") &&
    !isOneOf(properties.prepReminderMinutes, PREP_REMINDER_MINUTES)
  ) {
    throw invalid("prepReminderMinutes", `must be one of ${PREP_REMINDER_MINUTES.join(", ")}`);
  }
}

function validateSleepPlan(properties: Record<string, unknown>): void {
  if (typeof properties.name !== "string" || properties.name.trim() === "") {
    throw invalid("name", "must be a non-empty string");
  }
  for (const key of TIME_KEYS) {
    if (!isSleepTime(properties[key])) throw invalid(key, "is required and must be a time HH:MM");
  }
  if (Object.hasOwn(properties, "wakeDays")) {
    const days = properties.wakeDays;
    if (!Array.isArray(days) || !days.every((day) => isOneOf(day, WAKE_DAYS)) || new Set(days).size !== days.length) {
      throw invalid("wakeDays", "must list each of mon, tue, wed, thu, fri, sat and sun at most once");
    }
  }
  if (Object.hasOwn(properties, "alarm") && typeof properties.alarm !== "boolean") {
    throw invalid("alarm", "must be a boolean");
  }
  if (Object.hasOwn(properties, "position")) {
    const position = properties.position;
    if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 0) {
      throw invalid("position", "must be an integer of at least 0");
    }
  }
}

/** `null` on `bedTime`, `wakeTime` or `alarm` means "follow the plan". Returns the night. */
function validateSleepNight(properties: Record<string, unknown>): string {
  const night = properties.night;
  if (!isCalendarDate(night)) throw invalid("night", "is required and must be a calendar date YYYY-MM-DD");
  for (const key of TIME_KEYS) {
    if (Object.hasOwn(properties, key) && properties[key] !== null && !isSleepTime(properties[key])) {
      throw invalid(key, "must be a time HH:MM or null");
    }
  }
  if (Object.hasOwn(properties, "alarm") && properties.alarm !== null && typeof properties.alarm !== "boolean") {
    throw invalid("alarm", "must be a boolean or null");
  }
  return night;
}

/**
 * Transaction-scoped advisory lock on (tenant, night). Every writer of a night item takes it: the duplicate check
 * below and the find-or-create of `PUT /api/sleep/nights/:night`.
 */
export async function lockSleepNight(client: PoolClient, night: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('sleepNight:' || app_tenant_default()::text || ':' || $1::text))",
    [night],
  );
}

/** Takes `lockSleepNight`, then checks in a new statement (fresh snapshot) for another live item of that night. */
async function assertNightIsFree(client: PoolClient, databaseId: string, itemId: string, night: string): Promise<void> {
  await lockSleepNight(client, night);
  const { rows } = await client.query<{ taken: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM items
        WHERE database_id = $1 AND id <> $2 AND deleted_at IS NULL AND properties ->> 'night' = $3
     ) AS taken`,
    [databaseId, itemId, night],
  );
  if (requireSingleRow(rows, "sleep night lookup").taken) {
    throw new DuplicateItemError(`A night exception for ${night} already exists`, { field: "night" });
  }
}

/**
 * Serializes settings creators on a per-tenant advisory lock, then counts in a new statement: the new item is
 * already inserted, so more than one means another creator committed first.
 */
async function assertSingleSettingsItem(client: PoolClient, databaseId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('sleepSettings:' || app_tenant_default()::text))");
  const { rows } = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM items WHERE database_id = $1 AND deleted_at IS NULL",
    [databaseId],
  );
  if (requireSingleRow(rows, "sleep settings count").count > 1) {
    throw new DuplicateItemError("The sleep settings item already exists", { field: "sleepSettings" });
  }
}

/**
 * Runs after the insert, in the write's transaction, on already-normalized properties; a refusal rolls the
 * insert back.
 */
export const sleepItemCreateHook: ItemCreateHook = async ({ client, database, item }) => {
  const moduleId = database.ownerModuleId;
  if (moduleId === SLEEP_SETTINGS_MODULE_ID) {
    validateSleepSettings(item.properties);
    await assertSingleSettingsItem(client, database.id);
  } else if (moduleId === SLEEP_PLANS_MODULE_ID) {
    validateSleepPlan(item.properties);
  } else if (moduleId === SLEEP_NIGHTS_MODULE_ID) {
    const night = validateSleepNight(item.properties);
    await assertNightIsFree(client, database.id, item.id, night);
  }
};

/** Judges the merged item, so a partial patch is judged as a whole. */
export const sleepItemUpdateHook: ItemUpdateHook = async ({ client, database, item, propertiesPatch }) => {
  const moduleId = database.ownerModuleId;
  if (moduleId === SLEEP_SETTINGS_MODULE_ID) {
    validateSleepSettings(item.properties);
  } else if (moduleId === SLEEP_PLANS_MODULE_ID) {
    validateSleepPlan(item.properties);
  } else if (moduleId === SLEEP_NIGHTS_MODULE_ID) {
    const night = validateSleepNight(item.properties);
    if (Object.hasOwn(propertiesPatch, "night")) await assertNightIsFree(client, database.id, item.id, night);
  }
};

/**
 * A patch naming `night` takes the per-night lock before the choke point locks the row, matching the lock order
 * of `PUT /api/sleep/nights/:night` (night, then row); the reverse order would deadlock with it. The later
 * `assertNightIsFree` re-takes the same lock, which returns at once.
 */
export const sleepNightUpdatePreLockHook: ItemUpdatePreLockHook = async ({ client, patch }) => {
  if (isCalendarDate(patch.night)) await lockSleepNight(client, patch.night);
};

interface PlanHoldingDays {
  id: string;
  wakeDays: readonly string[];
}

const DEADLOCK_DETECTED = "40P01";

/**
 * Transactions currently removing days from other plans. The removal is a nested `updateItemWithClient` that
 * reruns this hook; a plan that lost days must not take them back, so nested runs are skipped.
 */
const clientsRemovingDays = new WeakSet<PoolClient>();

/**
 * Locks other plans holding any of `days` `FOR UPDATE` in id order. A deadlock (A and B taking days from each
 * other) is answered as a 409 so the client retries; only this statement's deadlock is mapped.
 */
async function lockPlansHoldingDays(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  days: readonly string[],
): Promise<PlanHoldingDays[]> {
  try {
    const { rows } = await client.query<{ id: string; wake_days: unknown }>(
      `SELECT id, properties -> 'wakeDays' AS wake_days FROM items
        WHERE database_id = $1 AND id <> $2 AND deleted_at IS NULL AND properties -> 'wakeDays' ?| $3::text[]
        ORDER BY id
          FOR NO KEY UPDATE`,
      [databaseId, itemId, days],
    );
    return rows.map((row) => ({
      id: row.id,
      wakeDays: Array.isArray(row.wake_days)
        ? row.wake_days.filter((day): day is string => typeof day === "string")
        : [],
    }));
  } catch (error) {
    if (error instanceof DatabaseError && error.code === DEADLOCK_DETECTED) {
      throw new ConflictError("Another sleep plan write is changing the same wake days; repeat the request");
    }
    throw error;
  }
}

/**
 * A wake day is in at most one plan: other plans holding one of the written plan's days lose it via a nested
 * `updateItemWithClient` (no `ifVersion`), so their hooks, realtime and `updatedAt` apply. Restores are not checked.
 *
 * The locking SELECT is repeated as a new statement until two in a row return nothing: a statement that waited on
 * a plan does not see a plan another transaction committed meanwhile, so one empty result can be stale. Two
 * transactions taking the same free day into two plans are not detected.
 */
export async function keepWakeDaysInOnePlan({
  client,
  database,
  item,
}: Pick<ItemCreateHookContext, "client" | "database" | "item">): Promise<void> {
  if (database.ownerModuleId !== SLEEP_PLANS_MODULE_ID || clientsRemovingDays.has(client)) return;
  const taken = item.properties.wakeDays;
  if (!Array.isArray(taken) || taken.length === 0) return;
  const takenDays = new Set<unknown>(taken);
  const takenList = taken.filter((day): day is string => typeof day === "string");
  let emptyStatements = 0;
  while (emptyStatements < 2) {
    const plans = await lockPlansHoldingDays(client, database.id, item.id, takenList);
    if (plans.length === 0) {
      emptyStatements += 1;
      continue;
    }
    emptyStatements = 0;
    clientsRemovingDays.add(client);
    try {
      for (const plan of plans) {
        await updateItemWithClient(client, {
          databaseId: database.id,
          itemId: plan.id,
          propertiesPatch: { wakeDays: plan.wakeDays.filter((day) => !takenDays.has(day)) },
        });
      }
    } finally {
      clientsRemovingDays.delete(client);
    }
  }
}

const SLEEP_MODULE_IDS: readonly (string | null)[] = [
  SLEEP_SETTINGS_MODULE_ID,
  SLEEP_PLANS_MODULE_ID,
  SLEEP_NIGHTS_MODULE_ID,
];

/** Enqueues the debounced `sleep.resync` job on the write's client, so it commits or rolls back with the write. */
async function enqueueResyncForWrite(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ tenant_id: string | null }>("SELECT app_tenant_default()::text AS tenant_id");
  const { tenant_id: tenantId } = requireSingleRow(rows, "sleep resync tenant");
  if (tenantId === null) throw new Error("A sleep write ran without a tenant");
  await enqueueSleepResync(client, tenantId);
}

export const sleepResyncCreateHook: ItemCreateHook = async ({ client, database }) => {
  if (SLEEP_MODULE_IDS.includes(database.ownerModuleId)) await enqueueResyncForWrite(client);
};

/** A System settings `timezone` change also resyncs, because the zone decides every night's instants. */
export const sleepResyncUpdateHook: ItemUpdateHook = async ({ client, database, propertiesPatch }) => {
  const moduleId = database.ownerModuleId;
  if (
    SLEEP_MODULE_IDS.includes(moduleId) ||
    (moduleId === SYSTEM_SETTINGS_MODULE_ID && Object.hasOwn(propertiesPatch, "timezone"))
  ) {
    await enqueueResyncForWrite(client);
  }
};

export const sleepResyncDeleteHook: ItemDeleteHook = async ({ client, database }) => {
  if (SLEEP_MODULE_IDS.includes(database.ownerModuleId)) await enqueueResyncForWrite(client);
};

export const sleepResyncRestoreHook: ItemRestoreHook = async ({ client, database }) => {
  if (SLEEP_MODULE_IDS.includes(database.ownerModuleId)) await enqueueResyncForWrite(client);
};
