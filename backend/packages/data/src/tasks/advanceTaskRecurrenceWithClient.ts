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

/** The Tasks module's own process identity: it writes the system-owned series properties and re-links carried edges. */
const TASKS_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: TASKS_MODULE_ID };

/** The `owner: 'system'` Tasks properties the advance writes on the next instance (issue #1605). */
const SERIES_PROPERTY_KEYS = ["seriesId", "occurrenceDate", "recurrence"] as const;

/**
 * The Tasks-side relation keys whose edges the next instance keeps (issue #1673); edge metadata is copied unchanged.
 * Every other relation (`hostEvents`, `completedInEvent`, `sourceEvents`, the Events-side `actionItems`, and any
 * relation added later) is not carried over until its key is added here.
 */
const CARRIED_RELATION_KEYS: readonly string[] = ["project", "people", "files"];

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface AdvanceTaskRecurrenceInput {
  databaseId: string;
  itemId: string;
  timezone: string;
}

/**
 * The choke point's `createItemWithClient`, passed in by the caller rather than imported:
 * `chokePoint/itemWrites.ts` calls this module from `updateItemWithClient`, and importing it
 * back would form the import cycle the `no-choke-point-rollup-cycle` dependency rule forbids.
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
 * Advances the series of a completed or `wontDo` occurrence (issues #1605, #1670, #1673), inside the caller's
 * transaction — the choke point's status write calls it, so that write and the next occurrence commit or roll
 * back together. It does not change the old occurrence; the caller's own write does that.
 *
 * - An item without a `seriesId`, or whose series row is missing or inactive, is a no-op.
 * - Locks the item first, then the series row (docs/adr/2026-10-25-task-and-event-recurrence-model.md).
 * - Only the occurrence the locked series row points at (its current open instance) advances the series. Any other
 *   occurrence of the series, an older one set to `done` or `wontDo` again on a later day included, is a no-op: its
 *   own status write still commits, but it creates no occurrence, moves no pointer and carries no edges or value-link
 *   sources (issue #1670).
 * - The next date is `firstOccurrenceAfter(rule, occurrenceDate, today)`, today being the server's day in
 *   `input.timezone`. A floating rule counts from the occurrence's `completedOn`, or from today when it has none
 *   (a `wontDo` occurrence, issue #1544).
 * - When a non-deleted occurrence of the series already has that date, nothing is created, so repeated
 *   transitions of one occurrence create at most one occurrence per date.
 * - Otherwise the next instance is created with that `date` and `occurrenceDate`, the same `seriesId` and a copy
 *   of `recurrence`; its `name`, `timeFrom`, `timeTo`, `notifications` and `persistent` come from the series
 *   template, its `flagged` and `description` from the completed occurrence (issue #1673). The series row is moved to
 *   it; the `project`, `people` and `files` edges are re-created on it; and the value-link sources naming the old
 *   instance are moved to it. The series template itself is not changed.
 *
 * Every item/relation write goes through the choke-point's own logic — `createItemWithClient` /
 * `createRelationWithClient` — so idempotency handling, ownership checks, onItemEvent heartbeat triggering and
 * rollup-recompute enqueueing all still happen exactly as they would through the public API.
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
 * The next instance's properties taken from the series template: an explicit allowlist of template keys. A null
 * `name` is left out. Any string `name`, an empty or whitespace-only one included, is passed on unchanged, so the
 * Tasks pre-write transform refuses a blank title and the completion rolls back
 * (docs/adr/2026-10-29-tasks-date-and-time-rules-in-pre-write-transform.md).
 */
function templateProperties(template: TaskRecurrenceTemplate): Record<string, unknown> {
  return {
    ...(template.name !== null ? { name: template.name } : {}),
    timeFrom: template.timeFrom,
    timeTo: template.timeTo,
    notifications: template.notifications,
    persistent: template.persistent,
  };
}

/**
 * The next instance's properties copied from the completed occurrence (issue #1673): an explicit allowlist. `flagged`
 * defaults to `false` and `description` to `null` when the occurrence has no such value.
 */
function completedOccurrenceProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    flagged: typeof properties.flagged === "boolean" ? properties.flagged : false,
    description: typeof properties.description === "string" ? properties.description : null,
  };
}

/**
 * Re-creates on `toItemId` every edge of `fromItemId` whose Tasks-side relation key is in `CARRIED_RELATION_KEYS`,
 * with its metadata unchanged (e.g. People edges keep theirs). Skips an edge whose counterpart item has been
 * soft-deleted since the edge was created — the advance must not fail over one stale link; it simply drops that
 * edge, rather than letting `createRelationWithClient`'s endpoint validation abort the whole transaction.
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
