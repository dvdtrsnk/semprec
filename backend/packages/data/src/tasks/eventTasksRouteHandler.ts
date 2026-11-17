import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { readEventTasks, type EventTasks } from "./taskStateInEvent.js";

/** Structurally matches `semprec-api`'s `AdapterRequestContext`, without depending on its HTTP types. */
interface EventTasksRouteRequestContext {
  params: Record<string, string>;
}

const eventIdSchema = z.uuid();

/**
 * `GET /api/events/:id/tasks`: `{ eventId, tasks: [{ taskId, title, state }], counts: { open, total } }` in edge
 * order. Missing, trashed and foreign Events answer the same `not_found`; a non-UUID `id` is `validation_failed`.
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
