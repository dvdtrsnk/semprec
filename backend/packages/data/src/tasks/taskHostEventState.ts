// Issue #1780: the stored host state of a task, `hiddenUntil` and `effectiveDate`, derived from the live Events the
// task sits in (`Tasks.hostEvents`, written by the routes of issue #1764). Both properties are owned by the Tasks
// process; this file is the one place that computes them. The triggers are registered in `../domainWriteHooks.ts`
// (`taskHostEventHooks.ts`, the Tasks pre-write transform); issue #1782 adds the delayed job that runs the
// recomputation once the hiding ends (`handleTaskHostEventEndedTask`). See
// docs/adr/2026-11-12-task-host-state-is-recomputed-in-the-writing-transaction.md.
import type { Pool, PoolClient } from "pg";
import { DateTime } from "luxon";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
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

/** The Tasks-side key of the relation; its inverse on Events is `hostedTasks` (issue #1540). */
const HOST_EVENTS_KEY = "hostEvents";

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WALL_CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;

/** The Tasks keys the recomputation writes as the Tasks process. */
const HOST_STATE_WRITE_KEYS = ["hiddenUntil", "effectiveDate", "since", "sinceTime"] as const;

/** The edge metadata the routes of issue #1764 write: the instant the task was put into the event. */
const hostEventMetadataSchema = z.object({ addedAt: z.iso.datetime({ precision: 3 }) });

/** One live Event a task sits in. Dates and times are wall-clock values in the tenant zone. */
export interface TaskHostEvent {
  eventId: string;
  /** When the task was put into the event, `Date.prototype.toISOString` form; `""` for an edge that stores none. */
  addedAt: string;
  date: string | null;
  endDate: string | null;
  timeFrom: string | null;
  timeTo: string | null;
}

export interface TaskHostState {
  /** A UTC ISO instant while the task is hidden, otherwise `null`. */
  hiddenUntil: string | null;
  effectiveDate: string | null;
}

export interface ComputeTaskHostStateInput {
  /** The task's own `date`. */
  date: string | null;
  /** The task's live host events, ordered by `addedAt`, the one added last at the end. */
  hostEvents: readonly TaskHostEvent[];
  /** The tenant's IANA zone. */
  timezone: string;
  now: Date;
}

/**
 * The host state of a task. Events without a `date` are ignored.
 *
 * - No host event: not hidden, `effectiveDate` is the task's `date`.
 * - `hiddenUntil` is the latest end among the events (the event end of `calendarTime.ts`) as a UTC instant while
 *   that end is later than `now`, otherwise `null`.
 * - While hidden, `effectiveDate` is the `date` of the event added last. Once every event has ended it is the later
 *   of the task's `date` and that event's `date`.
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

/** The Tasks `hostEvents` relation of the caller's tenant, and which side of its definition the task is. */
export interface HostEventsRelation {
  tasksDatabaseId: string;
  definitionId: string;
  /** Whether the task is `itemA` of the relation's edges; the Event is the other item. */
  taskIsItemA: boolean;
}

/** The relation, or `null` in a tenant without a Tasks database or without the relation. */
export async function loadHostEventsRelation(client: PoolClient): Promise<HostEventsRelation | null> {
  const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
  const property = tasks && (await propertiesStore.getPropertyByKey(client, tasks.id, HOST_EVENTS_KEY));
  const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
  if (!tasks || !property || !definition) return null;
  return {
    tasksDatabaseId: tasks.id,
    definitionId: definition.id,
    taskIsItemA: definition.propertyIdA === property.id,
  };
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

/** `addedAt` ascending; two edges with the same `addedAt` are ordered by event id, so the order is total. */
export function byAddedAtThenEventId(a: TaskHostEvent, b: TaskHostEvent): number {
  if (a.addedAt !== b.addedAt) return a.addedAt < b.addedAt ? -1 : 1;
  return a.eventId < b.eventId ? -1 : 1;
}

/** The `addedAt` of a host event edge's metadata; `""` for an edge that stores no valid one. */
export function readHostEventAddedAt(metadata: unknown): string {
  const parsed = hostEventMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data.addedAt : "";
}

/** An Event item read as a host event, with its dates and times as stored (see `readLiveHostEvents`). */
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
 * The live (not trashed) Events the task sits in, ordered by the edge's `addedAt`, the one added last at the end.
 * Event properties are read as stored: a `date` or `endDate` that is not a calendar day and a time that is not
 * `HH:MM` (or `24:00`) read as `null`, so a malformed legacy value never fails the write that reads it. An edge
 * without a valid `addedAt`, which the routes never write, orders before every edge that has one.
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

/** A stored string property, with `""` and a missing value both read as empty. */
function readFilled(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The one pending `taskHostEventEnded` job of a task. */
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
 * Brings the stored `hiddenUntil` and `effectiveDate` of one task in line with its live host events, in the
 * caller's transaction. Locks the task row first; a missing or trashed task is left alone. Writes only the values
 * that differ, through the choke point as the Tasks process, so the Tasks transform, the update hooks and the
 * realtime invalidation apply as for any other write.
 *
 * When the write changes the effective day of a `notDone` task whose effective day was before today and whose
 * `since` is empty, it also records `since` and `sinceTime` with the rule of issue #1602 (`firstPlannedDay`).
 *
 * While the state leaves `hiddenUntil` set, it also enqueues `taskHostEventEnded` for that instant, in the same
 * transaction and also when nothing else is written, so the task is recomputed and announced once the hiding ends.
 * The job key is per task and replaces: repeated recomputations, a moved end and a job that ran too early all leave
 * one pending job, at the latest end.
 *
 * The Events are read without a lock. The caller holds the task's row lock only, so an Event update that another
 * transaction has not yet committed is not seen here; see the ADR named in the header.
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
  // The effective day before this recomputation: the stored one, or the task's own date while none is stored.
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
 * `taskHostEventEnded`: runs in the job envelope's tenant. Recomputes the host state of the task from its current
 * edges and Events, never clearing `hiddenUntil` blindly, in one transaction. A missing or trashed task and a state
 * that did not change end without a write; while `hiddenUntil` is still in the future the recomputation has queued
 * the next run.
 */
export async function handleTaskHostEventEndedTask(pool: Pool, payload: unknown): Promise<void> {
  const { taskId } = taskHostEventEndedPayloadSchema.parse(payload);
  await withTransaction(pool, (client) => recomputeTaskHostState(client, taskId));
}
