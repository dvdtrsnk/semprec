import type { PoolClient } from "pg";
import type { Queryable } from "../db/pool.js";
import { assertAgentDatabaseAccess } from "../agentGrants/agentDatabaseAccess.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { loadSleepNights, type SleepNightsResponse } from "../sleep/sleepRouteHandlers.js";
import type { SempRefContext } from "./sempRefReadContext.js";

// The context of a `sleepNight` message ref: the resolved night, read from the three sleep databases, which are
// sensitive and so closed to an agent without a grant.

export const NO_SLEEP_PLANNED_NOTE = "no sleep planned for this night";

export interface SleepNightAccess {
  /** The agent's Projects item, whose grants on the sleep databases let the night be read. */
  agentProjectItemId: string | undefined;
  /**
   * True when the ref belongs to the message of the starting turn. That turn's one-run read allowance opens the
   * night's rows, but the run row it is keyed by does not exist yet when the prompt is built, so the prompt relies
   * on this flag instead.
   */
  attachedThisTurn: boolean;
}

async function sleepDatabaseIds(client: PoolClient): Promise<string[] | null> {
  const ids: string[] = [];
  for (const moduleId of [SLEEP_SETTINGS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_NIGHTS_MODULE_ID]) {
    const database = await getDatabaseByModuleId(client, moduleId);
    if (!database) return null;
    ids.push(database.id);
  }
  return ids;
}

/** The turn attached the night, or the agent has grants on all three databases. The refusal names no content. */
async function assertSleepNightReadable(
  client: PoolClient,
  databaseIds: readonly string[],
  access: SleepNightAccess,
): Promise<void> {
  if (access.attachedThisTurn) return;
  if (access.agentProjectItemId === undefined) {
    throw new ForbiddenError("No agent project is known to read a sleep night for", { resource: "sleepNight" });
  }
  for (const databaseId of databaseIds) {
    await assertAgentDatabaseAccess(client, {
      agentProjectItemId: access.agentProjectItemId,
      databaseId,
      access: "read",
    });
  }
}

/** With two live night items, the later by id, as `resolveSleepNights` does. */
async function exceptionItemId(client: PoolClient, nightsDatabaseId: string, night: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
      WHERE database_id = $1 AND deleted_at IS NULL AND (properties ->> 'night') COLLATE "C" = $2
      ORDER BY id DESC LIMIT 1`,
    [nightsDatabaseId, night],
  );
  return rows[0]?.id ?? null;
}

/**
 * The resolved `night`. The label is the night itself, so no sleep content is kept in a stored label.
 *
 * `client` must be in a REPEATABLE READ transaction so settings, plans and exception describe one state; any
 * other level throws. Throws `ForbiddenError` when `access` denies the read; returns null without a sleep module
 * or settings item.
 */
export async function readSleepNightContext(
  client: PoolClient,
  night: string,
  access: SleepNightAccess,
): Promise<SempRefContext | null> {
  const isolation = await client.query<{ level: string }>("SELECT current_setting('transaction_isolation') AS level");
  if (isolation.rows[0]?.level !== "repeatable read") {
    throw new Error("A sleep night is read in a REPEATABLE READ transaction");
  }
  const databaseIds = await sleepDatabaseIds(client);
  if (!databaseIds) return null;
  await assertSleepNightReadable(client, databaseIds, access);
  const [, , nightsDatabaseId] = databaseIds;
  if (nightsDatabaseId === undefined) throw new Error("Missing sleep nights database");
  let resolved: SleepNightsResponse;
  try {
    resolved = await loadSleepNights(client, { from: night, to: night });
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
  const exceptionId = await exceptionItemId(client, nightsDatabaseId, night);
  const [entry] = resolved.nights;
  return {
    label: night,
    state: "active",
    details: entry
      ? {
          night,
          planName: entry.planName,
          bedTime: entry.bedTime,
          wakeTime: entry.wakeTime,
          alarm: entry.alarm,
          changed: entry.changed,
          durationMinutes: entry.durationMinutes,
          prepReminderAt: entry.prepReminderAt,
          planItemId: entry.planId,
          exceptionItemId: exceptionId,
        }
      : { night, note: NO_SLEEP_PLANNED_NOTE, planItemId: null, exceptionItemId: exceptionId },
    blob: null,
  };
}

/**
 * The item ids the one-run read allowance of a turn attaching `sleepNight` refs opens: live settings, live plans
 * and those nights' live items. The nights come from the message's persisted refs, never from a tool argument.
 */
export async function listSleepNightReadItemIds(client: Queryable, nights: readonly string[]): Promise<string[]> {
  if (nights.length === 0) return [];
  const { rows } = await client.query<{ id: string }>(
    `SELECT i.id FROM items i JOIN databases d ON d.tenant_id = i.tenant_id AND d.id = i.database_id
      WHERE i.deleted_at IS NULL AND d.system AND (
        d.owner_module_id = ANY($1::text[])
        OR (d.owner_module_id = $2 AND (i.properties ->> 'night') COLLATE "C" = ANY($3::text[])))
      ORDER BY i.id`,
    [[SLEEP_SETTINGS_MODULE_ID, SLEEP_PLANS_MODULE_ID], SLEEP_NIGHTS_MODULE_ID, nights],
  );
  return rows.map((row) => row.id);
}
