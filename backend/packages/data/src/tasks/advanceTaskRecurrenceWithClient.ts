import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { NotFoundError } from "../errors.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import { moveValueLinkItemSources } from "../chokePoint/valueLinksStore.js";
import { assertValidTimezone } from "../timezone.js";
import type { ItemRow } from "../types.js";
import { firstOccurrenceAfter } from "./nextDueDate.js";
import {
  getTaskRecurrenceBySeriesId,
  hasSeriesOccurrence,
  moveTaskRecurrenceToItem,
  type TaskRecurrenceTemplate,
} from "./taskRecurrenceStore.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

const TASKS_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: TASKS_MODULE_ID };

/** The `owner: 'system'` series properties the advance writes on the next instance. */
const SERIES_PROPERTY_KEYS = ["seriesId", "occurrenceDate", "recurrence"] as const;

/** Relations whose edges (with metadata) the next instance keeps; any other relation is not carried over. */
const CARRIED_RELATION_KEYS: readonly string[] = ["project", "people", "files"];

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface AdvanceTaskRecurrenceInput {
  databaseId: string;
  itemId: string;
  timezone: string;
}

/**
 * Injected rather than imported: `chokePoint/itemWrites.ts` calls this module, and importing it back would form
 * the cycle the `no-choke-point-rollup-cycle` dependency rule forbids.
 */
export type CreateTaskInstance = (
  client: PoolClient,
  input: { databaseId: string; properties: Record<string, unknown> },
  options: { allowedSystemKeys: readonly string[]; systemOwnerProcess: string },
) => Promise<ItemRow>;

function isCalendarDate(value: unknown): value is string {
  return typeof value === "string" && CALENDAR_DATE.test(value) && DateTime.fromISO(value, { zone: "utc" }).isValid;
}

/**
 * Advances the series of a completed or `wontDo` occurrence in the caller's transaction, so the status write and
 * the next occurrence commit or roll back together. The old occurrence is left to the caller's write.
 *
 * - No `seriesId`, or a missing or inactive series row: no-op.
 * - Locks the item first, then the series row.
 * - Only the occurrence the locked row points at advances; any other occurrence is a no-op beyond its own write.
 * - The next date is `firstOccurrenceAfter(rule, occurrenceDate, today)` in `input.timezone`; a floating rule
 *   counts from `completedOn`, or today without one (`wontDo`).
 * - An existing non-deleted occurrence on that date means nothing is created, so at most one per date.
 * - Otherwise the next instance gets the date, `seriesId` and `recurrence`, template `name`/times/`notifications`
 *   and the completed occurrence's `flagged`/`description`. The series row, carried edges and value-link sources
 *   move to it; the template is unchanged.
 *
 * All writes go through the choke point's own functions, so idempotency, ownership checks, triggers and rollup
 * recomputes happen as through the public API.
 */
export async function advanceTaskRecurrenceWithClient(
  client: PoolClient,
  input: AdvanceTaskRecurrenceInput,
  createItemWithClient: CreateTaskInstance,
): Promise<ItemRow | null> {
  const current = await itemsStore.lockItemById(client, input.databaseId, input.itemId);
  if (!current) throw new NotFoundError(`Task ${input.itemId} not found`);
  const seriesId = current.properties.seriesId;
  if (typeof seriesId !== "string") return null;

  const series = await getTaskRecurrenceBySeriesId(client, seriesId, true);
  if (!series || !series.active || series.itemId !== current.id) return null;
  const occurrenceDate = current.properties.occurrenceDate;
  if (!isCalendarDate(occurrenceDate) || series.template === null) {
    throw new Error(`Task ${input.itemId} of series ${seriesId} has no valid occurrenceDate or template`);
  }

  assertValidTimezone(input.timezone);
  const today = DateTime.now().setZone(input.timezone).toFormat("yyyy-MM-dd");
  const completedOn = current.properties.completedOn;
  const nextDate = firstOccurrenceAfter(
    series.rule,
    occurrenceDate,
    today,
    isCalendarDate(completedOn) ? completedOn : today,
  );
  if (await hasSeriesOccurrence(client, input.databaseId, seriesId, nextDate)) return null;

  const newItem = await createItemWithClient(
    client,
    {
      databaseId: input.databaseId,
      properties: {
        ...templateProperties(series.template),
        ...completedOccurrenceProperties(current.properties),
        status: "notDone",
        date: nextDate,
        seriesId,
        occurrenceDate: nextDate,
        recurrence: current.properties.recurrence ?? null,
      },
    },
    { allowedSystemKeys: SERIES_PROPERTY_KEYS, systemOwnerProcess: TASKS_MODULE_ID },
  );
  await moveTaskRecurrenceToItem(client, seriesId, newItem.id);
  await copyCarriedRelationEdges(client, input.databaseId, input.itemId, newItem.id);
  await moveValueLinkItemSources(client, input.itemId, newItem.id);
  return newItem;
}

/**
 * Explicit allowlist of template keys; a null `name` is left out. A blank string `name` is passed on so the Tasks
 * transform refuses it and the completion rolls back.
 */
function templateProperties(template: TaskRecurrenceTemplate): Record<string, unknown> {
  return {
    ...(template.name !== null ? { name: template.name } : {}),
    timeFrom: template.timeFrom,
    timeTo: template.timeTo,
    notifications: template.notifications,
  };
}

/** `flagged` defaults to `false`, `description` to `null`. */
function completedOccurrenceProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    flagged: typeof properties.flagged === "boolean" ? properties.flagged : false,
    description: typeof properties.description === "string" ? properties.description : null,
  };
}

/**
 * Metadata is kept unchanged. An edge whose counterpart was soft-deleted is dropped instead of letting endpoint
 * validation abort the whole advance over one stale link.
 */
async function copyCarriedRelationEdges(
  client: PoolClient,
  tasksDatabaseId: string,
  fromItemId: string,
  toItemId: string,
): Promise<void> {
  const edges = await relationsStore.listAllRelationsForItem(client, fromItemId);
  for (const edge of edges) {
    const reldef = await relationsStore.getRelationDefinition(client, edge.relationDefinitionId);
    if (!reldef) continue;
    const taskIsItemA = edge.itemA === fromItemId;
    const taskPropertyId = taskIsItemA ? reldef.propertyIdA : reldef.propertyIdB;
    if (taskPropertyId === null) continue;
    const taskProperty = await propertiesStore.getProperty(client, taskPropertyId);
    if (
      !taskProperty ||
      taskProperty.databaseId !== tasksDatabaseId ||
      !CARRIED_RELATION_KEYS.includes(taskProperty.key)
    ) {
      continue;
    }
    const targetDatabaseId = taskProperty.config.targetDatabaseId;
    if (typeof targetDatabaseId !== "string") continue;
    const counterpartId = taskIsItemA ? edge.itemB : edge.itemA;
    const counterpart = await itemsStore.getItemById(client, targetDatabaseId, counterpartId);
    if (!counterpart || counterpart.deletedAt) continue;
    await createRelationWithClient(
      client,
      {
        relationPropertyId: taskProperty.id,
        callerItemId: toItemId,
        targetItemId: counterpartId,
        metadata: edge.metadata,
      },
      TASKS_RELATION_CONTEXT,
    );
  }
}
