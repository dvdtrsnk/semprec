import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { readEventTasks, type EventTasks } from "./taskStateInEvent.js";
import type { CustomRouteResult, RouteParams } from "../customRoute.js";
import { requireUuidParam } from "../customRoute.js";

/**
 * `GET /api/events/:id/tasks`: `{ eventId, tasks: [{ taskId, title, state }], counts: { open, total } }` in edge
 * order. Missing, trashed and foreign Events answer the same `not_found`; a non-UUID `id` is `validation_failed`.
 */
export function createEventTasksRouteHandler(pool: Pool) {
  return async (ctx: RouteParams): Promise<CustomRouteResult<EventTasks>> => {
    const id = requireUuidParam(ctx.params, "id");
    const eventTasks = await withTransaction(pool, (client) => readEventTasks(client, id));
    if (eventTasks === null) throw new NotFoundError("Event not found");
    return { status: 200, body: eventTasks };
  };
}
