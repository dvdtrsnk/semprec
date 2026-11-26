import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { readEventTasks, type EventTasks } from "./taskStateInEvent.js";
import type { CustomRouteResult, RouteParams, RouteBody, RouteUser } from "../customRoute.js";

interface TaskHostEvent {
  eventId: string;
  addedAt: string;
}

/** Non-trashed host events, the one added last at the end. */
interface TaskHostEventsBody {
  taskId: string;
  hostEvents: TaskHostEvent[];
}

interface HostEventsRelation {
  propertyId: string;
  definitionId: string;
  eventsDatabaseId: string;
}

const HOST_EVENTS_KEY = "hostEvents";

/** Its inverse on Events is `completedTasks`. */
const COMPLETED_IN_EVENT_KEY = "completedInEvent";

/** Both sides of the relation are system-owned by the Tasks process. */
const TASKS_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: TASKS_MODULE_ID };

/** The HTTP writer. Only server-side code (the calendar agent tools) passes another writer to put and remove. */
const USER_WRITER: WriterIdentity = { writerKind: "user" };

const RESCHEDULE_KEYS: ReadonlySet<string> = new Set(["date", "timeFrom", "timeTo"]);

/** `addedAt` is `toISOString` form (UTC, milliseconds), so string comparison orders instants. */
const hostEventMetadataSchema = z.object({ addedAt: z.iso.datetime({ precision: 3 }) });

function uuidParam(ctx: RouteParams & RouteBody & RouteUser, name: "id" | "eventId"): string {
  const result = z.uuid().safeParse(ctx.params[name]);
  if (!result.success) throw new ValidationError(`Path parameter '${name}' must be a UUID`, { field: name });
  return result.data.toLowerCase();
}

/** Locked; missing, trashed and other tenants' tasks are not found alike. */
async function lockLiveTask(client: PoolClient, id: string): Promise<{ tasksDatabaseId: string; taskId: string }> {
  const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
  const task = tasks ? await itemsStore.lockItemById(client, tasks.id, id) : null;
  if (!tasks || !task || task.deletedAt) throw new NotFoundError(`Task ${id} not found`);
  return { tasksDatabaseId: tasks.id, taskId: task.id };
}

async function hostEventsRelation(client: PoolClient, tasksDatabaseId: string): Promise<HostEventsRelation> {
  const property = await propertiesStore.getPropertyByKey(client, tasksDatabaseId, HOST_EVENTS_KEY);
  const definition = property ? await relationsStore.getRelationDefinitionByPropertyId(client, property.id) : null;
  const eventsDatabaseId = property?.config.targetDatabaseId;
  if (!property || !definition || typeof eventsDatabaseId !== "string") {
    throw new Error("Tasks has no 'hostEvents' relation");
  }
  return { propertyId: property.id, definitionId: definition.id, eventsDatabaseId };
}

/** Edges to trashed events included, in no particular order. */
async function storedHostEvents(
  client: PoolClient,
  relation: HostEventsRelation,
  taskId: string,
): Promise<TaskHostEvent[]> {
  const edges = await relationsStore.listRelationsForItem(client, relation.definitionId, taskId);
  return edges.map((edge) => {
    const metadata = hostEventMetadataSchema.safeParse(edge.metadata);
    if (!metadata.success) throw new Error(`Host event edge ${edge.id} has no valid addedAt`);
    return { eventId: relationsStore.otherSide(edge, taskId), addedAt: metadata.data.addedAt };
  });
}

function byAddedAtThenEventId(a: TaskHostEvent, b: TaskHostEvent): number {
  if (a.addedAt !== b.addedAt) return a.addedAt < b.addedAt ? -1 : 1;
  return a.eventId < b.eventId ? -1 : 1;
}

/** Read after the write. Edges to trashed events stay stored but are left out, as the generic relation list does. */
async function hostEventsBody(
  client: PoolClient,
  relation: HostEventsRelation,
  taskId: string,
): Promise<TaskHostEventsBody> {
  const stored = await storedHostEvents(client, relation, taskId);
  const live = await relationsStore.listLiveRelationTargets(
    client,
    stored.map((entry) => entry.eventId),
  );
  const liveIds = new Set(live.map((target) => target.id));
  return {
    taskId,
    hostEvents: stored.filter((entry) => liveIds.has(entry.eventId)).sort(byAddedAtThenEventId),
  };
}

/**
 * The server clock, or one millisecond past the latest stored `addedAt` when the clock is not past it. The
 * caller holds the task row lock, so no concurrent call writes an edge of this task in between.
 */
function nextAddedAt(stored: readonly TaskHostEvent[]): string {
  const latest = stored.reduce((max, entry) => Math.max(max, Date.parse(entry.addedAt)), Number.NEGATIVE_INFINITY);
  return new Date(Math.max(Date.now(), latest + 1)).toISOString();
}

function parseReschedule(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("The body must be an object", { field: "body" });
  }
  const fields = z.record(z.string(), z.unknown()).parse(body);
  const unknownKey = Object.keys(fields).find((key) => !RESCHEDULE_KEYS.has(key));
  if (unknownKey !== undefined) throw new ValidationError("Unknown field", { field: unknownKey });
  return fields;
}

/**
 * `PUT /api/tasks/:id/host-events/:eventId`: locks the task and writes the edge as the Tasks process with a new
 * `addedAt` (also on an existing edge, making that event the last). The body is not read; `writer` is the user or
 * the calendar tool's agent.
 *
 * A recurring occurrence is put like any task: only its own edge is written, never `task_recurrence` or other
 * occurrences.
 *
 * Missing, trashed and foreign tasks or events are not found alike. The event row is not locked: the edge write
 * re-checks both endpoints, and an event trashed afterwards keeps its edge.
 */
export function createTaskHostEventPutRouteHandler(pool: Pool) {
  return async (
    ctx: RouteParams & RouteBody & RouteUser,
    writer: WriterIdentity = USER_WRITER,
  ): Promise<CustomRouteResult<TaskHostEventsBody>> => {
    const id = uuidParam(ctx, "id");
    const eventId = uuidParam(ctx, "eventId");
    const userId = ctx.identity.user.id;
    return withTransaction(pool, async (client) => {
      const { tasksDatabaseId, taskId } = await lockLiveTask(client, id);
      const relation = await hostEventsRelation(client, tasksDatabaseId);
      const event = await itemsStore.getItemById(client, relation.eventsDatabaseId, eventId);
      if (!event || event.deletedAt) throw new NotFoundError(`Event ${eventId} not found`);
      const addedAt = nextAddedAt(await storedHostEvents(client, relation, taskId));
      await createRelationWithClient(
        client,
        {
          relationPropertyId: relation.propertyId,
          callerItemId: taskId,
          targetItemId: event.id,
          metadata: { addedAt },
        },
        TASKS_RELATION_CONTEXT,
        writer,
        userId,
      );
      return { status: 200, body: await hostEventsBody(client, relation, taskId) };
    });
  };
}

/**
 * `DELETE /api/tasks/:id/host-events/:eventId`: locks the task and deletes that one edge as the Tasks process.
 * A task not in the event answers 200 with the current list; missing, trashed and foreign tasks are not found.
 */
export function createTaskHostEventRemoveRouteHandler(pool: Pool) {
  return async (
    ctx: RouteParams & RouteBody & RouteUser,
    writer: WriterIdentity = USER_WRITER,
  ): Promise<CustomRouteResult<TaskHostEventsBody>> => {
    const id = uuidParam(ctx, "id");
    const eventId = uuidParam(ctx, "eventId");
    const userId = ctx.identity.user.id;
    return withTransaction(pool, async (client) => {
      const { tasksDatabaseId, taskId } = await lockLiveTask(client, id);
      const relation = await hostEventsRelation(client, tasksDatabaseId);
      await deleteRelationWithClient(
        client,
        { relationPropertyId: relation.propertyId, callerItemId: taskId, targetItemId: eventId },
        TASKS_RELATION_CONTEXT,
        writer,
        userId,
      );
      return { status: 200, body: await hostEventsBody(client, relation, taskId) };
    });
  };
}

/**
 * `DELETE /api/tasks/:id/host-events`: locks the task and deletes every host edge, trashed events included.
 * Named `date`/`timeFrom`/`timeTo` are then written through the Tasks write path as the caller in the same
 * transaction; a refused value fails the request and the edges stay. Other keys are refused before any write.
 */
export function createTaskHostEventsClearRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody & RouteUser): Promise<CustomRouteResult<TaskHostEventsBody>> => {
    const id = uuidParam(ctx, "id");
    const propertiesPatch = parseReschedule(ctx.body);
    const userId = ctx.identity.user.id;
    return withTransaction(pool, async (client) => {
      const { tasksDatabaseId, taskId } = await lockLiveTask(client, id);
      const relation = await hostEventsRelation(client, tasksDatabaseId);
      const eventIds = (await relationsStore.listRelationsForItem(client, relation.definitionId, taskId)).map((edge) =>
        relationsStore.otherSide(edge, taskId),
      );
      for (const eventId of eventIds.sort()) {
        await deleteRelationWithClient(
          client,
          { relationPropertyId: relation.propertyId, callerItemId: taskId, targetItemId: eventId },
          TASKS_RELATION_CONTEXT,
          USER_WRITER,
          userId,
        );
      }
      if (Object.keys(propertiesPatch).length > 0) {
        await updateItemWithClient(
          client,
          { databaseId: tasksDatabaseId, itemId: taskId, propertiesPatch },
          { writer: USER_WRITER, actingUserId: userId, humanWriterUserId: userId },
        );
      }
      return { status: 200, body: await hostEventsBody(client, relation, taskId) };
    });
  };
}

/**
 * `PUT /api/tasks/:id/completed-in-event/:eventId`: the task is done in that Event, whether or not the Event has
 * ended. Locks the task, requires a `hostEvents` edge to the Event (else not found), replaces any `completedInEvent`
 * edge with one to it as the Tasks process, and writes `status: done` through the Tasks write path as the caller, all
 * in one transaction. The edge is written first, so the completion hook, finding it, adds none of its own. Answers the
 * Event's tasks as `GET /api/events/:id/tasks` does. Reopening goes through a status write, whose hook removes the edge.
 */
export function createTaskCompleteInEventRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody & RouteUser): Promise<CustomRouteResult<EventTasks>> => {
    const id = uuidParam(ctx, "id");
    const eventId = uuidParam(ctx, "eventId");
    const userId = ctx.identity.user.id;
    return withTransaction(pool, async (client) => {
      const { tasksDatabaseId, taskId } = await lockLiveTask(client, id);
      const hostEvents = await hostEventsRelation(client, tasksDatabaseId);
      const hosted = await storedHostEvents(client, hostEvents, taskId);
      if (!hosted.some((entry) => entry.eventId === eventId)) {
        throw new NotFoundError(`Task ${taskId} is not in event ${eventId}`);
      }
      const event = await itemsStore.getItemById(client, hostEvents.eventsDatabaseId, eventId);
      if (!event || event.deletedAt) throw new NotFoundError(`Event ${eventId} not found`);
      const property = await propertiesStore.getPropertyByKey(client, tasksDatabaseId, COMPLETED_IN_EVENT_KEY);
      const definition = property ? await relationsStore.getRelationDefinitionByPropertyId(client, property.id) : null;
      if (!property || !definition) throw new Error("Tasks has no 'completedInEvent' relation");
      const edges = await relationsStore.listRelationsForItem(client, definition.id, taskId);
      const others = edges.map((edge) => relationsStore.otherSide(edge, taskId)).filter((other) => other !== eventId);
      for (const other of others.sort()) {
        await deleteRelationWithClient(
          client,
          { relationPropertyId: property.id, callerItemId: taskId, targetItemId: other },
          TASKS_RELATION_CONTEXT,
          USER_WRITER,
          userId,
        );
      }
      if (others.length === edges.length) {
        await createRelationWithClient(
          client,
          { relationPropertyId: property.id, callerItemId: taskId, targetItemId: eventId },
          TASKS_RELATION_CONTEXT,
          USER_WRITER,
          userId,
        );
      }
      await updateItemWithClient(
        client,
        { databaseId: tasksDatabaseId, itemId: taskId, propertiesPatch: { status: "done" } },
        { writer: USER_WRITER, actingUserId: userId, humanWriterUserId: userId },
      );
      const eventTasks = await readEventTasks(client, eventId);
      if (eventTasks === null) throw new NotFoundError(`Event ${eventId} not found`);
      return { status: 200, body: eventTasks };
    });
  };
}
