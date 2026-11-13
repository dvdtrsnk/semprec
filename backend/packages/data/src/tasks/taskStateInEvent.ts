// Issue #1801: what happened to a task in relation to one Event it sits in. The state is decided by the pure
// `taskStateInEvent`; `readEventTasks` and `eventTaskCounts` read the rows of one or several Events in a fixed number
// of queries and apply it. The edges come from `Tasks.hostEvents` (issue #1764) and `Tasks.completedInEvent` (issue
// #1781), the Event end from `calendarTime.ts` (issue #1418). The route `GET /api/events/:id/tasks` is in
// `eventTasksRouteHandler.ts`.
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

/** The Tasks-side key of the relation that records where a task was completed; its inverse is `completedTasks`. */
const COMPLETED_IN_EVENT_KEY = "completedInEvent";

/**
 * The state of a task in an Event. `doneElsewhere` carries either the day the task was completed on (completed from
 * the list on another day) or the name of the other Event it was completed in.
 */
export type EventTaskState =
  | { kind: "open" | "missed" | "done" }
  | { kind: "doneElsewhere"; completedOn: string }
  | { kind: "doneElsewhere"; eventName: string }
  | { kind: "moved"; lastEventName: string };

/** `open` counts the rows whose state is `open` or `missed`; `total` counts all rows. */
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

/** A live Event a task sits in, with the name the `moved` state reports. A missing name reads as `""`. */
export interface NamedHostEvent extends TaskHostEvent {
  name: string;
}

export interface TaskStateInEventInput {
  task: {
    /** The task's stored `status`. */
    status: string | null;
    /** The task's stored `completedOn`, a calendar day; `null` when it stores none. */
    completedOn: string | null;
    /** The Event the task's `completedInEvent` edge points to, `null` when it has no edge. */
    completedIn: { eventId: string; eventName: string } | null;
  };
  /** The Event the state is read in. */
  event: TaskHostEvent;
  /** The task's live host events, ordered by the edge's `addedAt`, the one added last at the end. */
  hostEvents: readonly NamedHostEvent[];
  now: Date;
  /** The tenant's IANA zone. */
  timezone: string;
}

/**
 * The state of a task in `event`, the first of these that applies:
 *
 * 1. The task is `done`, has no `completedInEvent` edge and its `completedOn` differs from the Event's `date`:
 *    `doneElsewhere` with that `completedOn`.
 * 2. Its edge points to this Event, or it is `done` without an edge and `completedOn` equals the Event's `date` (or
 *    the task stores no `completedOn`, so nothing places the completion on another day): `done`.
 * 3. Its edge points to another Event: `doneElsewhere` with that Event's name.
 * 4. The Event is not the last of `hostEvents`: `moved` with the name of the last one.
 * 5. The Event has ended (its end is at or before `now`; an Event without a `date` has none): `missed`.
 * 6. Otherwise `open`.
 *
 * A task that reaches step 5 is not `done`, whatever else its status is: a `done` task has either an edge or none,
 * and steps 1 to 3 answer both. Its status may be `notDone`, `wontDo` or `missed`.
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

/** The Tasks `completedInEvent` relation of the caller's tenant, and which side of its definition the task is. */
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

/** The task and the Event of one edge of a relation whose task side is `taskIsItemA`. */
function edgeEnds(edge: ItemRelationRow, taskIsItemA: boolean): { taskId: string; eventId: string } {
  return taskIsItemA ? { taskId: edge.itemA, eventId: edge.itemB } : { taskId: edge.itemB, eventId: edge.itemA };
}

/** A live task that sits in an Event, with the Events its `completedInEvent` edges point to. */
export interface HostedTask {
  task: ItemRow;
  /** The `addedAt` of the task's edge to the Event this row belongs to, `""` for an edge that stores none. */
  addedAt: string;
  completedInEventIds: string[];
}

/**
 * The live tasks of each Event in `eventIds` (a trashed task is left out), in the order of the Event's edges: `addedAt`
 * ascending, then task id, in a fixed number of queries however many Events and tasks there are. An Event need not be live: the edges
 * of an Event in the Trash stay stored. A tenant without the `hostEvents` relation has no hosted tasks.
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

/** The Events each of `taskIds` has a `completedInEvent` edge to, in event id order. */
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

/**
 * The tasks of each Event in `events` with their states and counts, keyed by Event id. The queries are batched: the
 * edges of all Events, their tasks, the host edges and `completedInEvent` edges of those tasks, and the Events those
 * edges name, so the number of queries does not depend on the number of rows.
 */
async function buildEventTasks(client: PoolClient, events: readonly ItemRow[]): Promise<Map<string, EventTasks>> {
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
  // Events in the Trash are read too: the name of the Event a task was completed in is still true after its trash.
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
  const now = new Date();
  return new Map(
    events.map((event) => {
      const rows = (hosted.get(event.id) ?? []).map(({ task, completedInEventIds }): EventTaskRow => {
        // The edge to this Event wins; a task has one edge, so the second choice is only a fallback for stray data.
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
 * The tasks that sit in a live Event with their per-event state and the counts, in the order of the Event's edges
 * by `addedAt` ascending. A trashed task and a trashed host event do not count. `null` when `eventId` names no live
 * Event: an unknown id, an item of another database, an Event in the Trash and another tenant's Event (row-level
 * security hides it) all answer alike.
 */
export async function readEventTasks(client: PoolClient, eventId: string): Promise<EventTasks | null> {
  const [event] = await liveEvents(client, [eventId]);
  if (event === undefined) return null;
  return (await buildEventTasks(client, [event])).get(event.id) ?? null;
}

/**
 * The counts of the tasks of each live Event in `eventIds`, keyed by Event id, as `readEventTasks` counts them; an Event
 * with no tasks has `{ open: 0, total: 0 }`. An id that names no live Event is absent from the result.
 */
export async function eventTaskCounts(
  client: PoolClient,
  eventIds: readonly string[],
): Promise<Map<string, EventTaskCounts>> {
  const events = await liveEvents(client, [...new Set(eventIds)]);
  const built = await buildEventTasks(client, events);
  return new Map([...built].map(([eventId, { counts }]) => [eventId, counts] as const));
}
