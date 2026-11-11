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
import { getTaskRecurrence } from "./taskRecurrenceStore.js";

interface Context {
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string } };
}

/** One event a task sits in, and the instant the task was last put into it. */
interface TaskHostEvent {
  eventId: string;
  addedAt: string;
}

/** What the three routes answer: the task's host events that are not in the trash, the one added last at the end. */
interface TaskHostEventsBody {
  taskId: string;
  hostEvents: TaskHostEvent[];
}

/** The `Tasks.hostEvents` relation of the caller's tenant. */
interface HostEventsRelation {
  propertyId: string;
  definitionId: string;
  eventsDatabaseId: string;
}

/** The Tasks-side key of the relation; its inverse on Events is `hostedTasks` (issue #1540). */
const HOST_EVENTS_KEY = "hostEvents";

/** The Tasks module's own process identity: both sides of the relation are system-owned with this owner process. */
const TASKS_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: TASKS_MODULE_ID };

const USER_WRITER: WriterIdentity = { writerKind: "user" };

/** The Tasks properties `DELETE /api/tasks/:id/host-events` may set while it removes the task from its events. */
const RESCHEDULE_KEYS: ReadonlySet<string> = new Set(["date", "timeFrom", "timeTo"]);

/**
 * The edge metadata these routes write. `addedAt` has the form `Date.prototype.toISOString` produces (UTC,
 * milliseconds), so two values order as instants when they are compared as strings.
 */
const hostEventMetadataSchema = z.object({ addedAt: z.iso.datetime({ precision: 3 }) });

/** The path parameter `name` as a lower-case UUID, the form stored ids have. */
function uuidParam(ctx: Context, name: "id" | "eventId"): string {
  const result = z.uuid().safeParse(ctx.params[name]);
  if (!result.success) throw new ValidationError(`Path parameter '${name}' must be a UUID`, { field: name });
  return result.data.toLowerCase();
}

/** The Tasks database and the task `id`, locked; a missing task, a trashed one and another tenant's are not found alike. */
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

/** Every stored host event edge of the task, edges to trashed events included, in no particular order. */
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

/** `addedAt` ascending; two edges with the same `addedAt` are ordered by event id, so the order is total. */
function byAddedAtThenEventId(a: TaskHostEvent, b: TaskHostEvent): number {
  if (a.addedAt !== b.addedAt) return a.addedAt < b.addedAt ? -1 : 1;
  return a.eventId < b.eventId ? -1 : 1;
}

/**
 * The response of the three routes, read after the write: the task's host events ordered by `addedAt` ascending. An
 * edge to an event that is in the trash stays stored and is left out, as the generic relation list leaves it out.
 */
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
 * The `addedAt` of a new or replaced edge: the server's clock, or one millisecond after the latest `addedAt` the task
 * already stores when the clock is not past it. The caller holds the task's row lock, so no other call of these
 * routes writes an edge of the same task between this read and the write.
 */
function nextAddedAt(stored: readonly TaskHostEvent[]): string {
  const latest = stored.reduce((max, entry) => Math.max(max, Date.parse(entry.addedAt)), Number.NEGATIVE_INFINITY);
  return new Date(Math.max(Date.now(), latest + 1)).toISOString();
}

/** The body of `DELETE /api/tasks/:id/host-events`: an object whose keys are among `date`, `timeFrom` and `timeTo`. */
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
 * `PUT /api/tasks/:id/host-events/:eventId` (issue #1764): puts a task into an event. In one transaction it locks the
 * task, then its `task_recurrence` row (items before `task_recurrence`,
 * docs/adr/2026-10-25-task-and-event-recurrence-model.md), and writes the `Tasks.hostEvents` edge as the Tasks process
 * with the metadata `{ addedAt }` (`nextAddedAt`). An edge that already exists gets the new `addedAt`, which makes
 * that event the last of the task's host events. The request body is not read.
 *
 * A task or an event that is missing, in the trash or another tenant's is not found alike. A task whose recurrence is
 * active is refused with 400 on `taskId`. The event row is not locked: the edge write checks both endpoints again, and
 * an event trashed after that check keeps its edge, as an event trashed after the request does.
 */
export function createTaskHostEventPutRouteHandler(pool: Pool) {
  return async (ctx: Context): Promise<{ status: number; body: TaskHostEventsBody }> => {
    const id = uuidParam(ctx, "id");
    const eventId = uuidParam(ctx, "eventId");
    const userId = ctx.identity.user.id;
    return withTransaction(pool, async (client) => {
      const { tasksDatabaseId, taskId } = await lockLiveTask(client, id);
      const relation = await hostEventsRelation(client, tasksDatabaseId);
      const event = await itemsStore.getItemById(client, relation.eventsDatabaseId, eventId);
      if (!event || event.deletedAt) throw new NotFoundError(`Event ${eventId} not found`);
      const recurrence = await getTaskRecurrence(client, taskId, true);
      if (recurrence?.active) {
        throw new ValidationError("A task with an active recurrence cannot be put into an event", { field: "taskId" });
      }
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
        USER_WRITER,
        userId,
      );
      return { status: 200, body: await hostEventsBody(client, relation, taskId) };
    });
  };
}

/**
 * `DELETE /api/tasks/:id/host-events/:eventId` (issue #1764): takes a task out of one event. In one transaction it
 * locks the task and deletes that edge as the Tasks process; the task's other host event edges stay. A task that does
 * not sit in the event, whatever the event id names, answers 200 with the current list. A task that is missing, in the
 * trash or another tenant's is not found alike.
 */
export function createTaskHostEventRemoveRouteHandler(pool: Pool) {
  return async (ctx: Context): Promise<{ status: number; body: TaskHostEventsBody }> => {
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
        USER_WRITER,
        userId,
      );
      return { status: 200, body: await hostEventsBody(client, relation, taskId) };
    });
  };
}

/**
 * `DELETE /api/tasks/:id/host-events` (issue #1764): takes a task out of every event, optionally with a new date and
 * time. In one transaction it locks the task and deletes each of its host event edges as the Tasks process, edges to
 * trashed events included. When the body names `date`, `timeFrom` or `timeTo`, those values are then written to the
 * task through the Tasks write path as the caller, in the same transaction: a value that write refuses fails the
 * request and the edges stay. A body with any other key is refused on that key before anything is written. A task
 * that is missing, in the trash or another tenant's is not found alike.
 */
export function createTaskHostEventsClearRouteHandler(pool: Pool) {
  return async (ctx: Context): Promise<{ status: number; body: TaskHostEventsBody }> => {
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
