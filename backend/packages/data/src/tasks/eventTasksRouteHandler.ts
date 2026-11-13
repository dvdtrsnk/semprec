import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { readEventTasks, type EventTasks } from "./taskStateInEvent.js";

/**
 * Duck-typed the same way `eventParticipantsRouteHandlers.ts` is: matches `semprec-api`'s `AdapterRequestContext`
 * structurally, with no dependency on that service's HTTP types.
 */
interface EventTasksRouteRequestContext {
  params: Record<string, string>;
}

const eventIdSchema = z.uuid();

/**
 * `GET /api/events/:id/tasks` (issue #1801): the tasks that sit in a live Event of the caller's tenant as
 * `{ eventId, tasks: [{ taskId, title, state }], counts: { open, total } }`, in the order of the Event's edges by
 * `addedAt`. The read runs in the caller's tenant scope, so an Event that is missing, in the Trash or another
 * tenant's answers with the same `not_found` body. An `id` that is not a UUID is `validation_failed` on `id`.
 */
export function createEventTasksRouteHandler(pool: Pool) {
  return async (ctx: EventTasksRouteRequestContext): Promise<{ status: number; body: EventTasks }> => {
    const parsedId = eventIdSchema.safeParse(ctx.params.id);
    if (!parsedId.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const eventTasks = await withTransaction(pool, (client) => readEventTasks(client, parsedId.data));
    if (eventTasks === null) throw new NotFoundError("Event not found");
    return { status: 200, body: eventTasks };
  };
}
