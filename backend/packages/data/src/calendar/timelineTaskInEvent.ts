// Issue gh-1880: the task-in-event state of the calendar timeline. After the sources have been read, the Events of
// the timeline get the tasks that sit in them with their states and counts, and each Task gets the host event that
// decided its day. The states are those of `GET /api/events/:id/tasks` (`readEventsTasks`), read for every Event of
// the range and every host event in one batch.
import type { PoolClient } from "pg";
import { eventEnd } from "../calendarTime.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import {
  byAddedAtThenEventId,
  loadHostEventsRelation,
  readHostEventAddedAt,
  toTaskHostEvent,
  type TaskHostEvent,
} from "../tasks/taskHostEventState.js";
import { readEventsTasks, type EventTasks } from "../tasks/taskStateInEvent.js";
import type {
  CalendarEventOccurrence,
  CalendarTimelineContext,
  CalendarTimelineEntry,
  CalendarTimelineHostEvent,
  CalendarTimelineItem,
} from "./timelineSources.js";

/**
 * The stored Event whose tasks an Event entry shows: its own item, or the series Event for a virtual occurrence.
 * `null` for an entry that is not a stored row and not an occurrence either (a source's own entry: its `id` is no
 * item id).
 */
function storedEventId(entry: CalendarTimelineItem | CalendarEventOccurrence): string | null {
  if ("overridden" in entry) return entry.overridden ? entry.id : entry.seriesId;
  return entry.readOnly ? null : entry.id;
}

/** A host event of a task with the name the timeline shows. */
export interface NamedHostEvent extends TaskHostEvent {
  title: string;
  date: string;
}

/**
 * The live host event that decided the day of each of `taskIds`: the one the task was added to last among the live
 * Events that have a `date` (`computeTaskHostState` ignores an Event without one). A task in no such Event has no
 * entry. The number of statements does not depend on the number of tasks.
 */
export async function readDecidingHostEvents(
  client: PoolClient,
  taskIds: readonly string[],
): Promise<Map<string, NamedHostEvent>> {
  const relation = await loadHostEventsRelation(client);
  if (relation === null || taskIds.length === 0) return new Map();
  const edges = await relationsStore.listRelationsForItems(client, relation.definitionId, [...taskIds]);
  const taskOf = (edge: (typeof edges)[number]): string => (relation.taskIsItemA ? edge.itemA : edge.itemB);
  const eventOf = (edge: (typeof edges)[number]): string => (relation.taskIsItemA ? edge.itemB : edge.itemA);
  const events = new Map(
    (await itemsStore.getItemsByIds(client, [...new Set(edges.map(eventOf))])).map((event) => [event.id, event]),
  );
  const hostEventsByTask = new Map<string, NamedHostEvent[]>();
  for (const edge of edges) {
    const event = events.get(eventOf(edge));
    if (event === undefined) continue;
    const hostEvent = toTaskHostEvent(event, readHostEventAddedAt(edge.metadata));
    if (hostEvent.date === null) continue;
    const title = typeof event.properties.name === "string" ? event.properties.name : "";
    const named: NamedHostEvent = { ...hostEvent, date: hostEvent.date, title };
    hostEventsByTask.set(taskOf(edge), [...(hostEventsByTask.get(taskOf(edge)) ?? []), named]);
  }
  const deciding = new Map<string, NamedHostEvent>();
  for (const [taskId, hostEvents] of hostEventsByTask) {
    const last = hostEvents.sort(byAddedAtThenEventId).at(-1);
    if (last !== undefined) deciding.set(taskId, last);
  }
  return deciding;
}

/**
 * Adds the task-in-event state to the entries of one timeline read and returns them in the order they came in. An
 * Event entry gets `tasks` and `counts`, those of its stored Event (`storedEventId`); a Task entry gets `hostEvent`
 * when it sits in a live Event with a date, `null` otherwise. Entries that are not stored Events or Tasks are
 * returned as they are, and so are the Event and Task entries a source made up (`readOnly` and no occurrence). The
 * number of statements does not depend on the number of Events or Tasks.
 */
export async function attachTaskInEventState(
  client: PoolClient,
  entries: CalendarTimelineEntry[],
  context: Pick<CalendarTimelineContext, "timezone" | "at">,
): Promise<CalendarTimelineEntry[]> {
  const taskIds = entries.flatMap((entry) => (entry.kind === "task" && !entry.readOnly ? [entry.id] : []));
  const deciding = await readDecidingHostEvents(client, taskIds);
  const eventIds = [...deciding.values()].map((hostEvent) => hostEvent.eventId);
  for (const entry of entries) {
    const eventId = entry.kind === "event" ? storedEventId(entry) : null;
    if (eventId !== null) eventIds.push(eventId);
  }
  const eventTasks: Map<string, EventTasks> = await readEventsTasks(client, eventIds, context.at);

  return entries.map((entry): CalendarTimelineEntry => {
    if (entry.kind === "event") {
      const eventId = storedEventId(entry);
      if (eventId === null) return entry;
      const own = eventTasks.get(eventId);
      return { ...entry, tasks: own?.tasks ?? [], counts: own?.counts ?? { open: 0, total: 0 } };
    }
    if (entry.kind !== "task") return entry;
    const host = deciding.get(entry.id);
    if (host === undefined) return entry;
    // The Task is live and the Event is live, so the Event's batch lists the Task; without a row there is no state.
    const state = eventTasks.get(host.eventId)?.tasks.find((row) => row.taskId === entry.id)?.state;
    if (state === undefined) return entry;
    const hostEvent: CalendarTimelineHostEvent = {
      id: host.eventId,
      title: host.title,
      ended: eventEnd(host, context.timezone).toMillis() <= context.at.getTime(),
      date: host.date,
      timeFrom: host.timeFrom,
      timeTo: host.timeTo,
      state,
    };
    return { ...entry, hostEvent };
  });
}
