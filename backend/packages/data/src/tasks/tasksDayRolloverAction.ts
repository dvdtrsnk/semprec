import { closeMissedOccurrence } from "./closeMissedOccurrences.js";
import { DateTime } from "luxon";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { rolloverTaskWithClient } from "../chokePoint/itemWrites.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import { withTransaction } from "../db/pool.js";
import { publishOverviewInvalidation } from "../overview/overviewInvalidation.js";
import type { ActionHandler } from "../scheduler/actions.js";
import { MAX_SWEEP_CHUNKS_PER_TENANT } from "../scheduler/sweep.js";
import { getSystemTimezone } from "../systemSettings.js";
import { assertValidTimezone } from "../timezone.js";

export const TASKS_DAY_ROLLOVER_ACTION_ID = "core.tasksDayRollover";

/** Created by `seedSystem`: midnight in the tenant's system time zone. */
export const TASKS_DAY_ROLLOVER_HEARTBEAT = {
  name: "Tasks day rollover",
  rule: { kind: "dailyTime", at: "00:00" },
} as const;

/** Resolved once at seed time. */
const configSchema = z.object({ tasksDatabaseId: z.uuid() });

/** Rows one transaction moves. */
const CHUNK_SIZE = 100;

/** Which side of the relation definition the Tasks property is. */
type CompletedInEventSide = "item_a" | "item_b" | null;

/**
 * One locked chunk of candidates: live, `notDone`, no `seriesId`, effective day (`effectiveDate`, else `date`)
 * before `today`, and visible (`hiddenUntil` empty or past, no `completedInEvent` edge). A task already in the
 * rollover's result state for today (`date` today, no times) is excluded whatever its `effectiveDate`. The first
 * pass skips locked rows and pages by id; the second waits for them.
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
       AND NOT (COALESCE(i.properties->>'date', '') = $2
                AND COALESCE(i.properties->>'timeFrom', '') = ''
                AND COALESCE(i.properties->>'timeTo', '') = '')
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
 * The `core.tasksDayRollover` 00:00 heartbeat action: moves every passed one-off unfinished task to today in the
 * tenant zone via `rolloverTaskWithClient` (`date` today, no times, `since` by the first-planned-day rule).
 *
 * The first pass pages by id with `FOR UPDATE SKIP LOCKED`, one transaction per chunk; the second waits for the
 * skipped rows. Each pass is capped at `MAX_SWEEP_CHUNKS_PER_TENANT`; the rest waits for the next run. After every
 * chunk and missed-occurrence close commits, one `overview` invalidation is announced even if nothing moved,
 * because today's count changes with the day. A moved task is in the result state and never a candidate again,
 * so reruns are no-ops and a run after an outage writes each task once. See
 * docs/architecture/domain-calendar-tasks-and-media.md#nightly-rollover.
 */
export function createTasksDayRolloverAction(pool: Pool, options: { recurringLimit?: number } = {}): ActionHandler {
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

    for (const skipLocked of [true, false]) {
      let afterRecurringId: string | null = null;
      for (let count = 0; count < (options.recurringLimit ?? MAX_SWEEP_CHUNKS_PER_TENANT * CHUNK_SIZE); count++) {
        const id: string | null = await withTransaction(pool, async (client) => {
          const result = await client.query<{ id: string }>(
            `SELECT i.id FROM items i
             JOIN task_recurrence s ON s.tenant_id = i.tenant_id AND s.series_id =
               (CASE WHEN i.deleted_at IS NULL AND i.properties->>'status' = 'notDone'
                 AND jsonb_typeof(i.properties->'seriesId') = 'string'
                 AND COALESCE(i.properties->>'seriesId', '') <> ''
                 AND jsonb_typeof(i.properties->'occurrenceDate') = 'string'
                 AND i.properties->>'occurrenceDate' < $2
                 THEN (i.properties->>'seriesId')::uuid END)
             WHERE i.tenant_id = app_tenant_default() AND i.database_id = $1 AND i.deleted_at IS NULL
               AND i.properties->>'status' = 'notDone'
               AND jsonb_typeof(i.properties->'occurrenceDate') = 'string'
               AND i.properties->>'occurrenceDate' < $2 AND s.active
               AND s.anchor_date IS NOT NULL AND s.template IS NOT NULL
               AND task_recurrence_due_for_rollover(s.mode, s.rule,
                 (CASE WHEN jsonb_typeof(i.properties->'occurrenceDate') = 'string'
                   AND i.properties->>'occurrenceDate' < $2 THEN (i.properties->>'occurrenceDate')::date END),
                 s.anchor_date, $2::date)
               AND ($3::uuid IS NULL OR i.id > $3::uuid)
             ORDER BY i.id LIMIT 1 FOR UPDATE OF i${skipLocked ? " SKIP LOCKED" : ""}`,
            [tasksDatabaseId, context.today, afterRecurringId],
          );
          const id = result.rows[0]?.id;
          if (!id) return null;
          await closeMissedOccurrence(client, tasksDatabaseId, id, context.today);
          return id;
        });
        if (!id) break;
        afterRecurringId = id;
      }
    }

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
    // Its own transaction after all others committed, so it is sent when nothing moved as well.
    await withTransaction(pool, async (client) => publishOverviewInvalidation(client));
  };
}
