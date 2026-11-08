import { DateTime } from "luxon";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { rolloverTaskWithClient } from "../chokePoint/itemWrites.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import { withTransaction } from "../db/pool.js";
import type { ActionHandler } from "../scheduler/actions.js";
import { MAX_SWEEP_CHUNKS_PER_TENANT } from "../scheduler/sweep.js";
import { getSystemTimezone } from "../systemSettings.js";
import { assertValidTimezone } from "../timezone.js";

export const TASKS_DAY_ROLLOVER_ACTION_ID = "core.tasksDayRollover";

/**
 * The rollover's heartbeat, shared by `seedSystem` (fresh install) and
 * `runTasksDayRolloverHeartbeatCutoverMigration` (populated upgrade) so both create the same one: midnight in the
 * tenant's system time zone.
 */
export const TASKS_DAY_ROLLOVER_HEARTBEAT = {
  name: "Tasks day rollover",
  rule: { kind: "dailyTime", at: "00:00" },
} as const;

/** The heartbeat's `action_config`: the Tasks database it moves tasks in, resolved once at seed time. */
const configSchema = z.object({ tasksDatabaseId: z.uuid() });

/** Rows one transaction moves. */
const CHUNK_SIZE = 100;

/** How the `completedInEvent` edge names the task: the side of its relation definition the Tasks property is. */
type CompletedInEventSide = "item_a" | "item_b" | null;

/**
 * The candidates of one chunk, locked: live, `notDone`, not recurring (no `seriesId`), whose effective day
 * (`effectiveDate` when set, else `date`, until #1780 and #1798 define it fully) is a calendar day before `today`, and
 * visible as in the Tasks today view: `hiddenUntil` empty or before now, and no `completedInEvent` edge. The first pass
 * skips rows another transaction holds and pages by id; the second waits for them.
 */
async function lockCandidates(
  client: PoolClient,
  input: {
    tasksDatabaseId: string;
    today: string;
    completedInEvent: { definitionId: string; side: CompletedInEventSide } | null;
    afterId: string | null;
    skipLocked: boolean;
  },
): Promise<string[]> {
  // Both texts are closed literals chosen here, never input.
  const completedClause =
    input.completedInEvent === null
      ? "true"
      : input.completedInEvent.side === "item_a"
        ? "NOT EXISTS (SELECT 1 FROM item_relations r WHERE r.relation_definition_id = $5 AND r.item_a = i.id)"
        : "NOT EXISTS (SELECT 1 FROM item_relations r WHERE r.relation_definition_id = $5 AND r.item_b = i.id)";
  const { rows } = await client.query<{ id: string }>(
    `SELECT i.id FROM items i
     WHERE i.database_id = $1 AND i.deleted_at IS NULL
       AND i.properties->>'status' = 'notDone'
       AND COALESCE(i.properties->>'seriesId', '') = ''
       AND COALESCE(NULLIF(i.properties->>'effectiveDate', ''), i.properties->>'date') ~ '^\\d{4}-\\d{2}-\\d{2}$'
       AND COALESCE(NULLIF(i.properties->>'effectiveDate', ''), i.properties->>'date') < $2
       AND (COALESCE(i.properties->>'hiddenUntil', '') = '' OR (i.properties->>'hiddenUntil')::timestamptz < now())
       AND ${completedClause}
       AND ($3::uuid IS NULL OR i.id > $3::uuid)
     ORDER BY i.id LIMIT $4 FOR UPDATE${input.skipLocked ? " SKIP LOCKED" : ""}`,
    [
      input.tasksDatabaseId,
      input.today,
      input.afterId,
      CHUNK_SIZE,
      ...(input.completedInEvent === null ? [] : [input.completedInEvent.definitionId]),
    ],
  );
  return rows.map((row) => row.id);
}

async function completedInEventEdge(
  client: PoolClient,
  tasksDatabaseId: string,
): Promise<{ definitionId: string; side: CompletedInEventSide } | null> {
  const property = await getPropertyByKey(client, tasksDatabaseId, "completedInEvent");
  if (!property) return null;
  const definition = await getRelationDefinitionByPropertyId(client, property.id);
  if (!definition) return null;
  return { definitionId: definition.id, side: definition.propertyIdA === property.id ? "item_a" : "item_b" };
}

/**
 * Registered as the `dailyTime` 00:00 heartbeat action `core.tasksDayRollover` (issue #1674): moves every unfinished
 * one-off task of the tenant whose day has passed to today, in the tenant's system time zone, through
 * `rolloverTaskWithClient` (`date` today, no times, `since`/`sinceTime` by the first-planned-day rule).
 *
 * Runs in the firing heartbeat's tenant. The first pass pages through the candidates by id in chunks of
 * `CHUNK_SIZE`, each its own transaction, with `FOR UPDATE SKIP LOCKED`; the second pass waits (`FOR UPDATE`) for the
 * rows the first one skipped, chunk after chunk from the start, until no candidate is left. Each pass runs at most
 * `MAX_SWEEP_CHUNKS_PER_TENANT` chunks, the cap of the heartbeat sweep; what is left after that waits for the next
 * run. A moved task's day is today, so it is no candidate again: a second run on the same day changes nothing, and a
 * run after an outage of several days writes each task once. See
 * docs/adr/2026-11-08-nightly-task-rollover-writes-user-owned-schedule.md.
 */
export function createTasksDayRolloverAction(pool: Pool): ActionHandler {
  return async (actionConfig) => {
    const { tasksDatabaseId } = configSchema.parse(actionConfig);
    const context = await withTransaction(pool, async (client) => {
      const zone = await getSystemTimezone(client);
      assertValidTimezone(zone);
      return {
        today: DateTime.now().setZone(zone).toFormat("yyyy-MM-dd"),
        completedInEvent: await completedInEventEdge(client, tasksDatabaseId),
      };
    });
    const move = async (ids: string[], client: PoolClient): Promise<void> => {
      for (const itemId of ids) {
        await rolloverTaskWithClient(client, { databaseId: tasksDatabaseId, itemId, date: context.today });
      }
    };

    let afterId: string | null = null;
    for (let chunk = 0; chunk < MAX_SWEEP_CHUNKS_PER_TENANT; chunk++) {
      const ids: string[] = await withTransaction(pool, async (client) => {
        const locked = await lockCandidates(client, { tasksDatabaseId, ...context, afterId, skipLocked: true });
        await move(locked, client);
        return locked;
      });
      if (ids.length < CHUNK_SIZE) break;
      afterId = ids[ids.length - 1]!;
    }
    for (let chunk = 0; chunk < MAX_SWEEP_CHUNKS_PER_TENANT; chunk++) {
      const ids: string[] = await withTransaction(pool, async (client) => {
        const locked = await lockCandidates(client, { tasksDatabaseId, ...context, afterId: null, skipLocked: false });
        await move(locked, client);
        return locked;
      });
      if (ids.length === 0) break;
    }
  };
}
