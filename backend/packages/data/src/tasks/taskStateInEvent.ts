// What happened to a task in relation to one Event it sits in: decided by the pure `taskStateInEvent`, applied by
// readers that load one or several Events in a fixed number of queries.
import type { PoolClient } from "pg";
import { eventEnd, getCalendarClock } from "../calendarTime.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRelationRow, ItemRow } from "../types.js";
import {
  byAddedAtThenEventId,
  loadHostEventsRelation,
  readHostEventAddedAt,
  toTaskHostEvent,
  type HostEventsRelation,
  type TaskHostEvent,
} from "./taskHostEventState.js";

/** Its inverse is `completedTasks`. */
const COMPLETED_IN_EVENT_KEY = "completedInEvent";

/** `doneElsewhere` carries the completion day (completed from the list) or the other Event's name. */
export type EventTaskState =
  | { kind: "open" | "missed" | "done" }
  | { kind: "doneElsewhere"; completedOn: string }
  | { kind: "doneElsewhere"; eventName: string }
  | { kind: "moved"; lastEventName: string };

/** `open` counts `open` and `missed` rows; `total` counts all. */
export interface EventTaskCounts {
  open: number;
  total: number;
}

export interface EventTaskRow {
  taskId: string;
  title: string;
  state: EventTaskState;
}

export interface EventTasks {
  eventId: string;
  tasks: EventTaskRow[];
  counts: EventTaskCounts;
}

/** A missing name reads as `""`. */
export interface NamedHostEvent extends TaskHostEvent {
  name: string;
}

export interface TaskStateInEventInput {
  task: {
    status: string | null;
    completedOn: string | null;
    /** `null` without a `completedInEvent` edge. */
    completedIn: { eventId: string; eventName: string } | null;
  };
  event: TaskHostEvent;
  /** Ordered by `addedAt`, the last added at the end. */
  hostEvents: readonly NamedHostEvent[];
  now: Date;
  timezone: string;
}

/**
 * The state of a task in `event`, the first that applies:
 *
 * 1. `done`, no `completedInEvent` edge, `completedOn` differs from the Event's `date`: `doneElsewhere` (that day).
 * 2. The edge points here, or `done` without an edge on the Event's `date` (or with no `completedOn`): `done`.
 * 3. The edge points to another Event: `doneElsewhere` with its name.
 * 4. Not the last of `hostEvents`: `moved` to the last one.
 * 5. The Event has ended (end at or before `now`; no `date` means no end): `missed`.
 * 6. Otherwise `open`.
 *
 * Steps 1-3 answer every `done` task, so from step 5 on the status is `notDone`, `wontDo` or `missed`.
 */
export function taskStateInEvent({ task, event, hostEvents, now, timezone }: TaskStateInEventInput): EventTaskState {
  const done = task.status === "done";
  if (done && task.completedIn === null && task.completedOn !== null && task.completedOn !== event.date) {
    return { kind: "doneElsewhere", completedOn: task.completedOn };
  }
  if (task.completedIn?.eventId === event.eventId || (done && task.completedIn === null)) return { kind: "done" };
  if (task.completedIn !== null) return { kind: "doneElsewhere", eventName: task.completedIn.eventName };
  const last = hostEvents.at(-1);
  if (last !== undefined && last.eventId !== event.eventId) return { kind: "moved", lastEventName: last.name };
  if (event.date !== null && eventEnd({ ...event, date: event.date }, timezone).toMillis() <= now.getTime()) {
    return { kind: "missed" };
  }
  return { kind: "open" };
}

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readCompletedOn(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function countRows(rows: readonly EventTaskRow[]): EventTaskCounts {
  return {
    open: rows.filter((row) => row.state.kind === "open" || row.state.kind === "missed").length,
    total: rows.length,
  };
}

interface CompletedInEventRelation {
  definitionId: string;
  taskIsItemA: boolean;
}

async function loadCompletedInEventRelation(
  client: PoolClient,
  tasksDatabaseId: string,
): Promise<CompletedInEventRelation | null> {
  const property = await propertiesStore.getPropertyByKey(client, tasksDatabaseId, COMPLETED_IN_EVENT_KEY);
  const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
  if (!property || !definition) return null;
  return { definitionId: definition.id, taskIsItemA: definition.propertyIdA === property.id };
}

function edgeEnds(edge: ItemRelationRow, taskIsItemA: boolean): { taskId: string; eventId: string } {
  return taskIsItemA ? { taskId: edge.itemA, eventId: edge.itemB } : { taskId: edge.itemB, eventId: edge.itemA };
}

export interface HostedTask {
  task: ItemRow;
  addedAt: string;
  completedInEventIds: string[];
}

/**
 * Live tasks of each Event, in edge order (`addedAt`, then task id), in a fixed number of queries. The Event need
 * not be live: a trashed Event keeps its edges. A tenant without `hostEvents` has none.
 */
export async function readHostedTasks(
  client: PoolClient,
  relation: HostEventsRelation | null,
  eventIds: readonly string[],
): Promise<Map<string, HostedTask[]>> {
  const hosted = new Map<string, HostedTask[]>(eventIds.map((eventId) => [eventId, []]));
  if (relation === null || eventIds.length === 0) return hosted;
  const edges = (await relationsStore.listRelationsForItems(client, relation.definitionId, [...eventIds])).map(
    (edge) => ({ ...edgeEnds(edge, relation.taskIsItemA), addedAt: readHostEventAddedAt(edge.metadata) }),
  );
  const tasks = new Map(
    (await itemsStore.getItemsByIds(client, [...new Set(edges.map((edge) => edge.taskId))])).map((task) => [
      task.id,
      task,
    ]),
  );
  const completedIn = await readCompletedInEventIds(client, relation.tasksDatabaseId, [...tasks.keys()]);
  edges.sort((a, b) => (a.addedAt === b.addedAt ? (a.taskId < b.taskId ? -1 : 1) : a.addedAt < b.addedAt ? -1 : 1));
  for (const edge of edges) {
    const task = tasks.get(edge.taskId);
    if (task === undefined) continue;
    hosted.get(edge.eventId)?.push({
      task,
      addedAt: edge.addedAt,
      completedInEventIds: completedIn.get(task.id) ?? [],
    });
  }
  return hosted;
}

async function readCompletedInEventIds(
  client: PoolClient,
  tasksDatabaseId: string,
  taskIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byTask = new Map<string, string[]>();
  const relation = await loadCompletedInEventRelation(client, tasksDatabaseId);
  if (relation === null || taskIds.length === 0) return byTask;
  for (const edge of await relationsStore.listRelationsForItems(client, relation.definitionId, [...taskIds])) {
    const { taskId, eventId } = edgeEnds(edge, relation.taskIsItemA);
    byTask.set(taskId, [...(byTask.get(taskId) ?? []), eventId].sort());
  }
  return byTask;
}

async function buildEventTasks(
  client: PoolClient,
  events: readonly ItemRow[],
  now: Date,
): Promise<Map<string, EventTasks>> {
  const relation = await loadHostEventsRelation(client);
  const hosted = await readHostedTasks(
    client,
    relation,
    events.map((event) => event.id),
  );
  const taskIds = [...new Set([...hosted.values()].flatMap((rows) => rows.map((row) => row.task.id)))];
  const hostEdges =
    relation === null || taskIds.length === 0
      ? []
      : (await relationsStore.listRelationsForItems(client, relation.definitionId, taskIds)).map((edge) => ({
          ...edgeEnds(edge, relation.taskIsItemA),
          addedAt: readHostEventAddedAt(edge.metadata),
        }));
  const namedEventIds = new Set([
    ...hostEdges.map((edge) => edge.eventId),
    ...[...hosted.values()].flatMap((rows) => rows.flatMap((row) => row.completedInEventIds)),
  ]);
  // Trashed Events are read too: the name of the Event a task was completed in stays true after its trash.
  const known = new Map(
    (await itemsStore.getItemsByIdsIncludingDeleted(client, [...namedEventIds])).map((event) => [event.id, event]),
  );
  const hostEventsByTask = new Map<string, NamedHostEvent[]>();
  for (const edge of hostEdges) {
    const event = known.get(edge.eventId);
    if (event === undefined || event.deletedAt !== null) continue;
    hostEventsByTask.set(edge.taskId, [
      ...(hostEventsByTask.get(edge.taskId) ?? []),
      { ...toTaskHostEvent(event, edge.addedAt), name: readText(event.properties.name) },
    ]);
  }
  for (const hostEvents of hostEventsByTask.values()) hostEvents.sort(byAddedAtThenEventId);

  const clock = await getCalendarClock(client);
  return new Map(
    events.map((event) => {
      const rows = (hosted.get(event.id) ?? []).map(({ task, completedInEventIds }): EventTaskRow => {
        // A task has one edge; the fallback is only for stray data.
        const completedInId = completedInEventIds.includes(event.id) ? event.id : completedInEventIds[0];
        const completedInEvent = completedInId === undefined ? undefined : known.get(completedInId);
        return {
          taskId: task.id,
          title: readText(task.properties.name),
          state: taskStateInEvent({
            task: {
              status: typeof task.properties.status === "string" ? task.properties.status : null,
              completedOn: readCompletedOn(task.properties.completedOn),
              completedIn:
                completedInId === undefined
                  ? null
                  : { eventId: completedInId, eventName: readText(completedInEvent?.properties.name) },
            },
            event: toTaskHostEvent(event, ""),
            hostEvents: hostEventsByTask.get(task.id) ?? [],
            now,
            timezone: clock.zone,
          }),
        };
      });
      return [event.id, { eventId: event.id, tasks: rows, counts: countRows(rows) }] as const;
    }),
  );
}

async function liveEvents(client: PoolClient, eventIds: readonly string[]): Promise<ItemRow[]> {
  const eventsDatabase = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  if (eventsDatabase === null) return [];
  return (await itemsStore.getItemsByIds(client, [...eventIds])).filter(
    (item) => item.databaseId === eventsDatabase.id,
  );
}

/**
 * Tasks of a live Event with states and counts, in edge order. Trashed tasks and host events do not count.
 * `null` for an unknown id, another database's item, a trashed Event or another tenant's (RLS) alike.
 */
export async function readEventTasks(client: PoolClient, eventId: string): Promise<EventTasks | null> {
  const [event] = await liveEvents(client, [eventId]);
  if (event === undefined) return null;
  return (await buildEventTasks(client, [event], new Date())).get(event.id) ?? null;
}

/**
 * As `readEventTasks` for many Events, in the same fixed number of queries. States are evaluated at one `now`.
 * Ids naming no live Event are absent.
 */
export async function readEventsTasks(
  client: PoolClient,
  eventIds: readonly string[],
  now: Date,
): Promise<Map<string, EventTasks>> {
  return buildEventTasks(client, await liveEvents(client, [...new Set(eventIds)]), now);
}

/** An Event without tasks has `{ open: 0, total: 0 }`; ids naming no live Event are absent. */
export async function eventTaskCounts(
  client: PoolClient,
  eventIds: readonly string[],
): Promise<Map<string, EventTaskCounts>> {
  const built = await readEventsTasks(client, eventIds, new Date());
  return new Map([...built].map(([eventId, { counts }]) => [eventId, counts] as const));
}
