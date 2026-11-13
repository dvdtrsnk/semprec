import { DatabaseError, type PoolClient } from "pg";
import type {
  ItemCreateHook,
  ItemCreateHookContext,
  ItemPreWritePreparation,
  ItemPreWriteTransform,
  ItemUpdateHook,
} from "../chokePoint/hooks.js";
import { isCalendarDate } from "../calendar/eventValidationHook.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { requireSingleRow } from "../db/pool.js";
import { ConflictError, DuplicateItemError, ValidationError } from "../errors.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { normalizeWallClockTime } from "../timezone.js";

/** The sleep time keys; they exist on `sleepPlans` and `sleepNights` only. */
const TIME_KEYS = ["bedTime", "wakeTime"] as const;

const SETTINGS_BOOLEAN_KEYS = ["enabled", "prepReminder", "muteSemp", "alarmSnooze", "showInCalendar"] as const;
const GOAL_MINUTES = [420, 450, 480, 510, 540];
const PREP_REMINDER_MINUTES = [15, 30, 45, 60];
const WAKE_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** A stored zero-padded 24-hour time. `24:00` is not a sleep time. */
const SLEEP_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The patch with `bedTime` and `wakeTime`, when it names them, as zero-padded 24-hour `HH:MM` (`6:45` becomes
 * `06:45`). An empty value becomes `null`, which `sleepNights` keeps as "follow the plan" and which the plan
 * rule of `validateSleepPlan` then refuses. `24:00` and an unreadable value are a 400 naming the key.
 * Pure, so it serves the write and the proposal preparation of an agent's patch alike.
 */
function normalizeSleepTimes(patch: Record<string, unknown>): Record<string, unknown> {
  const output = { ...patch };
  for (const key of TIME_KEYS) {
    if (!Object.hasOwn(output, key)) continue;
    output[key] = normalizeWallClockTime(output[key], { field: key, allow2400: false });
  }
  return output;
}

/** The pre-write transform of issue gh-1784, registered by `../domainWriteHooks.ts` for each of the three sleep module ids. */
export const sleepPreWriteTransform: ItemPreWriteTransform = async ({ patch }) => normalizeSleepTimes(patch);

/** The proposal preparation of `sleepPreWriteTransform`: it reads no row and allocates nothing. */
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

/**
 * Each present checkbox and number key of the settings item holds an allowed value. An absent key is not judged.
 * The `alarmSound` select is not judged here: the choke point checks it against its option catalog.
 */
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

/**
 * A plan has a non-blank `name` and a `bedTime` and `wakeTime` of `HH:MM`. Of the other keys, a present one is
 * judged: `wakeDays` lists distinct weekdays (an empty list is valid), `alarm` is a boolean and `position` is an
 * integer from 0.
 */
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

/**
 * A night exception has a `night` that is a calendar date `YYYY-MM-DD`. A present `bedTime` or `wakeTime` is
 * `HH:MM` or `null` and a present `alarm` is a boolean or `null`; `null` means "follow the plan". Returns the night.
 */
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
 * Serializes the writers of one night: takes the transaction-scoped advisory lock
 * `hashtext('sleepNight:' || <tenant id> || ':' || <night>)`, then looks in a new statement for another
 * non-deleted item of the database with the same `night` and refuses with a 409 `duplicate_item` naming `night`
 * when one exists. The lock key is the contract of every writer of a night item; it is held until the
 * transaction ends. The tenant is `app_tenant_default()`, which is the tenant of the scope the item was inserted
 * in, so it is never NULL here.
 */
async function assertNightIsFree(client: PoolClient, databaseId: string, itemId: string, night: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('sleepNight:' || app_tenant_default()::text || ':' || $1::text))",
    [night],
  );
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
 * Serializes the creators of the settings item: takes `pg_advisory_xact_lock(hashtext('sleepSettings:' ||
 * <tenant id>))`, then counts the non-deleted items of the database in a new statement. The new item is already
 * inserted, so more than one means another creator committed first, and the create is refused with a 409
 * `duplicate_item` naming `sleepSettings`.
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
 * The create rules of issue gh-1784 for the three sleep databases. It runs after the insert, in the write's
 * transaction, on the stored properties, which the pre-write transform has already normalized: every rule of the
 * database passes, then a second settings item or a second exception for a night is refused. A refusal rolls the
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

/**
 * The update rules of issue gh-1784. It runs after the update, in the write's transaction, and judges the
 * merged item (the stored properties with the patch applied), so a partial patch is judged as a whole. A patch
 * that names `night` on a night exception also needs the date to be free.
 */
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

/** A sleep plan another plan's write has to take days from: its id and the `wakeDays` it holds once locked. */
interface PlanHoldingDays {
  id: string;
  wakeDays: readonly string[];
}

/** Postgres SQLSTATE `deadlock_detected`. */
const DEADLOCK_DETECTED = "40P01";

/**
 * The clients whose transaction is removing days from other plans right now. The removal is a nested
 * `updateItemWithClient`, which runs every update hook again, this one included; a plan that lost days must not
 * take days back from the plan that took them, so the hook skips a nested run.
 */
const clientsRemovingDays = new WeakSet<PoolClient>();

/**
 * Selects, in a new statement, the other non-deleted plans of the database that hold any of `days` and locks them
 * `FOR UPDATE` in id order. A deadlock between two transactions that lock each other's plans (A takes a day from B
 * while B takes a day from A) ends one of them with `40P01`; that one is answered as a 409 so the client repeats
 * the request. Only this statement is mapped: any other failure, a deadlock of another statement included, passes
 * through unchanged.
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
          FOR UPDATE`,
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
 * The create and update hook of issue gh-1799 for the sleep plans (the same function serves both registries): a
 * wake day is in at most one plan. After a write whose merged item has non-empty `wakeDays`, every other
 * non-deleted plan of the database that holds one of those days loses it, by a nested `updateItemWithClient`
 * without `ifVersion` in this transaction, so the other plan's hooks, realtime invalidation and `updatedAt` apply
 * as for any write. A plan keeps its empty `wakeDays` when it loses all days. Restores from the trash are not
 * checked.
 *
 * The plans are read and locked by a `SELECT ... FOR UPDATE` that is repeated as a new statement. A statement
 * that waited for a plan another transaction was changing rechecks that plan against its new version, but does
 * not see a plan that transaction committed in the meantime and that now holds the day, so an empty result can be
 * stale. The loop therefore ends only after two statements in a row returned no plan: the second one starts after
 * the first one ended, which is after every wait of the first one. A day nobody holds when the loop ends is not
 * serialized by it; two transactions that take the same free day into two plans are not detected.
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
