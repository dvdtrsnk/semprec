// The stored host state of a task, `hiddenUntil` and `effectiveDate`, derived from the live Events it sits in
// (`Tasks.hostEvents`). Both are owned by the Tasks process and computed only here. See
// docs/architecture/domain-calendar-tasks-and-media.md#host-events-task-in-event.
import type { Pool, PoolClient } from "pg";
import { DateTime } from "luxon";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@alldots/queue";
import { eventEnd, getCalendarClock } from "../calendarTime.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { withTransaction } from "../db/pool.js";
import type { ItemRow } from "../types.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { firstPlannedDay } from "./taskSinceRule.js";

/** Its inverse on Events is `hostedTasks`. */
const HOST_EVENTS_KEY = "hostEvents";

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WALL_CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;

const HOST_STATE_WRITE_KEYS = ["hiddenUntil", "effectiveDate", "since", "sinceTime"] as const;

const hostEventMetadataSchema = z.object({ addedAt: z.iso.datetime({ precision: 3 }) });

/** Dates and times are wall-clock values in the tenant zone. */
export interface TaskHostEvent {
  eventId: string;
  /** `toISOString` form; `""` for an edge that stores none. */
  addedAt: string;
  date: string | null;
  endDate: string | null;
  timeFrom: string | null;
  timeTo: string | null;
}

export interface TaskHostState {
  hiddenUntil: string | null;
  effectiveDate: string | null;
}

export interface ComputeTaskHostStateInput {
  date: string | null;
  hostEvents: readonly TaskHostEvent[];
  timezone: string;
  now: Date;
}

/**
 * Events without a `date` are ignored.
 *
 * - No host event: not hidden, `effectiveDate` is the task's `date`.
 * - `hiddenUntil` is the latest event end as a UTC instant while it is later than `now`, otherwise `null`.
 * - While hidden, `effectiveDate` is the `date` of the event added last; once all ended, the later of the task's
 *   `date` and that event's `date`.
 */
export function computeTaskHostState({ date, hostEvents, timezone, now }: ComputeTaskHostStateInput): TaskHostState {
  const dated = hostEvents.filter((event): event is TaskHostEvent & { date: string } => event.date !== null);
  const last = dated.at(-1);
  if (last === undefined) return { hiddenUntil: null, effectiveDate: date };
  const latestEnd = Math.max(...dated.map((event) => eventEnd(event, timezone).toMillis()));
  if (latestEnd > now.getTime()) {
    return { hiddenUntil: new Date(latestEnd).toISOString(), effectiveDate: last.date };
  }
  return { hiddenUntil: null, effectiveDate: date !== null && date > last.date ? date : last.date };
}

/** Which side of the relation definition the task is. */
export interface HostEventsRelation {
  tasksDatabaseId: string;
  definitionId: string;
  taskIsItemA: boolean;
}

/** `null` without a Tasks database or the relation. */
export async function loadHostEventsRelation(client: PoolClient): Promise<HostEventsRelation | null> {
  const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
  return tasks && loadHostEventsRelationIn(client, tasks.id);
}

/** `loadHostEventsRelation` for a Tasks database the caller already resolved; `null` without the relation. */
export async function loadHostEventsRelationIn(
  client: PoolClient,
  tasksDatabaseId: string,
): Promise<HostEventsRelation | null> {
  const property = await propertiesStore.getPropertyByKey(client, tasksDatabaseId, HOST_EVENTS_KEY);
  const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
  if (!property || !definition) return null;
  return { tasksDatabaseId, definitionId: definition.id, taskIsItemA: definition.propertyIdA === property.id };
}

function readCalendarDate(value: unknown): string | null {
  return typeof value === "string" &&
    CALENDAR_DATE_PATTERN.test(value) &&
    DateTime.fromISO(value, { zone: "utc" }).isValid
    ? value
    : null;
}

function readWallClock(value: unknown): string | null {
  return typeof value === "string" && WALL_CLOCK_PATTERN.test(value) ? value : null;
}

/** Ties on `addedAt` are ordered by event id, so the order is total. */
export function byAddedAtThenEventId(a: TaskHostEvent, b: TaskHostEvent): number {
  if (a.addedAt !== b.addedAt) return a.addedAt < b.addedAt ? -1 : 1;
  return a.eventId < b.eventId ? -1 : 1;
}

export function readHostEventAddedAt(metadata: unknown): string {
  const parsed = hostEventMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data.addedAt : "";
}

export function toTaskHostEvent(event: ItemRow, addedAt: string): TaskHostEvent {
  return {
    eventId: event.id,
    addedAt,
    date: readCalendarDate(event.properties.date),
    endDate: readCalendarDate(event.properties.endDate),
    timeFrom: readWallClock(event.properties.timeFrom),
    timeTo: readWallClock(event.properties.timeTo),
  };
}

/**
 * Live Events of the task, by `addedAt`. Malformed dates and times read as `null` so a legacy value never fails
 * the write that reads it; an edge without a valid `addedAt` orders first.
 */
export async function readLiveHostEvents(
  client: PoolClient,
  relation: HostEventsRelation,
  taskId: string,
): Promise<TaskHostEvent[]> {
  const edges = await relationsStore.listRelationsForItem(client, relation.definitionId, taskId);
  const addedAtByEvent = new Map(
    edges.map((edge) => [relationsStore.otherSide(edge, taskId), readHostEventAddedAt(edge.metadata)] as const),
  );
  const events = await itemsStore.getItemsByIds(client, [...addedAtByEvent.keys()]);
  return events.map((event) => toTaskHostEvent(event, addedAtByEvent.get(event.id) ?? "")).sort(byAddedAtThenEventId);
}

function readFilled(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function taskHostEventEndedJobKey(taskId: string): string {
  return `taskHostEventEnded:${taskId}`;
}

async function enqueueTaskHostEventEnded(client: PoolClient, taskId: string, runAt: Date): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.TASK_HOST_EVENT_ENDED,
    { taskId },
    { runAt, jobKey: taskHostEventEndedJobKey(taskId), jobKeyMode: "replace" },
  );
}

/**
 * Brings the stored host state of one task in line with its live host events in the caller's transaction. Locks
 * the task row first; a missing or trashed task is left alone. Writes only differing values, through the choke
 * point as the Tasks process, so transforms, hooks and invalidation apply.
 *
 * When the effective day of a `notDone` task that was overdue and has no `since` changes, records `since` and
 * `sinceTime` (`firstPlannedDay`).
 *
 * While `hiddenUntil` is set, enqueues `taskHostEventEnded` for that instant (even when nothing else is written).
 * The per-task job key replaces, leaving one pending job at the latest end.
 *
 * Events are read without a lock, so an uncommitted Event update by another transaction is not seen; see
 * docs/architecture/domain-calendar-tasks-and-media.md#host-events-task-in-event.
 */
export async function recomputeTaskHostState(client: PoolClient, taskId: string): Promise<void> {
  const relation = await loadHostEventsRelation(client);
  if (!relation) return;
  const task = await itemsStore.lockItemById(client, relation.tasksDatabaseId, taskId);
  if (!task || task.deletedAt) return;
  const clock = await getCalendarClock(client);
  const now = new Date();
  const state = computeTaskHostState({
    date: readCalendarDate(task.properties.date),
    hostEvents: await readLiveHostEvents(client, relation, taskId),
    timezone: clock.zone,
    now,
  });

  if (state.hiddenUntil !== null) await enqueueTaskHostEventEnded(client, task.id, new Date(state.hiddenUntil));

  const patch: Record<string, unknown> = {};
  if (readFilled(task.properties.hiddenUntil) !== state.hiddenUntil) patch.hiddenUntil = state.hiddenUntil;
  const storedEffectiveDate = readFilled(task.properties.effectiveDate);
  if (storedEffectiveDate !== state.effectiveDate) patch.effectiveDate = state.effectiveDate;
  const previousDay = storedEffectiveDate ?? readFilled(task.properties.date);
  if (state.effectiveDate !== previousDay) Object.assign(patch, firstPlannedDay(task.properties, clock.today(now)));
  if (Object.keys(patch).length === 0) return;
  await updateItemWithClient(
    client,
    { databaseId: relation.tasksDatabaseId, itemId: task.id, propertiesPatch: patch },
    { allowedSystemKeys: HOST_STATE_WRITE_KEYS, systemOwnerProcess: TASKS_MODULE_ID },
  );
}

const taskHostEventEndedPayloadSchema = z.object({ taskId: z.uuid() }).strict();

/**
 * Recomputes from current edges and Events in the envelope's tenant, never clearing `hiddenUntil` blindly. While
 * still hidden, the recomputation has already queued the next run.
 */
export async function handleTaskHostEventEndedTask(pool: Pool, payload: unknown): Promise<void> {
  const { taskId } = taskHostEventEndedPayloadSchema.parse(payload);
  await withTransaction(pool, (client) => recomputeTaskHostState(client, taskId));
}
