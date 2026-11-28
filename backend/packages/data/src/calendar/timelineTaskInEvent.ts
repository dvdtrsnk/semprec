// Task-in-event state, added after the sources are read: Events get their tasks and counts, Tasks the host event
// that decided their day. States match `GET /api/events/:id/tasks`, read in one batch.
import type { PoolClient } from "pg";
import { eventEnd } from "../calendarTime.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  byAddedAtThenEventId,
  readHostEventAddedAt,
  toTaskHostEvent,
  type TaskHostEvent,
} from "../tasks/taskHostEventState.js";
import { readEventsTasksIn, type EventTasks } from "../tasks/taskStateInEvent.js";
import type { CalendarTimelineLookups } from "./timelineLookups.js";
import type {
  CalendarEventOccurrence,
  CalendarTimelineContext,
  CalendarTimelineEntry,
  CalendarTimelineHostEvent,
  CalendarTimelineItem,
} from "./timelineSources.js";

/** The series Event for a virtual occurrence; `null` for a source's own entry, whose `id` is no item id. */
function storedEventId(entry: CalendarTimelineItem | CalendarEventOccurrence): string | null {
  if ("overridden" in entry) return entry.overridden ? entry.id : entry.seriesId;
  return entry.readOnly ? null : entry.id;
}

export interface NamedHostEvent extends TaskHostEvent {
  title: string;
  date: string;
}

/**
 * The live dated Event each task was added to last; `computeTaskHostState` ignores undated Events too. The number
 * of statements does not depend on the number of tasks.
 */
export async function readDecidingHostEvents(
  client: PoolClient,
  lookups: CalendarTimelineLookups,
  taskIds: readonly string[],
): Promise<Map<string, NamedHostEvent>> {
  const relation = await lookups.hostEventsRelation();
  if (relation === null || taskIds.length === 0) return new Map();
  const edges = await relationsStore.listRelationsForItems(client, relation.definitionId, [...taskIds]);
  const taskOf = (edge: (typeof edges)[number]): string => (relation.taskIsItemA ? edge.itemA : edge.itemB);
  const eventOf = (edge: (typeof edges)[number]): string => (relation.taskIsItemA ? edge.itemB : edge.itemA);
  const events = new Map(
    (await lookups.itemsByIds([...new Set(edges.map(eventOf))])).map((event) => [event.id, event]),
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

/** Keeps the input order. The number of statements does not depend on the number of Events or Tasks. */
export async function attachTaskInEventState(
  client: PoolClient,
  entries: CalendarTimelineEntry[],
  context: Pick<CalendarTimelineContext, "timezone" | "at" | "lookups">,
): Promise<CalendarTimelineEntry[]> {
  const taskIds = entries.flatMap((entry) => (entry.kind === "task" && !entry.readOnly ? [entry.id] : []));
  const deciding = await readDecidingHostEvents(client, context.lookups, taskIds);
  const eventIds = [...deciding.values()].map((hostEvent) => hostEvent.eventId);
  for (const entry of entries) {
    const eventId = entry.kind === "event" ? storedEventId(entry) : null;
    if (eventId !== null) eventIds.push(eventId);
  }
  const eventTasks: Map<string, EventTasks> = await readEventsTasksIn(client, eventIds, context.at, {
    eventsDatabaseId: (await context.lookups.database(EVENTS_MODULE_ID))?.id ?? null,
    hostEventsRelation: await context.lookups.hostEventsRelation(),
    timezone: context.timezone,
  });

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
