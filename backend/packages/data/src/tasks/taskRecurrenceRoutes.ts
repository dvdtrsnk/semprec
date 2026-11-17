import { applyRecurrenceCommand, parseRequest } from "./taskRecurrenceOwner.js";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow } from "../types.js";
import type { RouteParams, RouteBody, RouteUser } from "../customRoute.js";

/** The `owner: 'system'` properties these routes write as the Tasks module. */
const SERIES_PROPERTY_KEYS = ["seriesId", "occurrenceDate", "recurrence"] as const;
function taskId(ctx: RouteParams & RouteBody & RouteUser): string {
  const result = z.uuid().safeParse(ctx.params.id);
  if (!result.success) throw new ValidationError("Task id must be a UUID", { field: "id" });
  return result.data;
}

/** Locked; foreign and trashed tasks are not found alike. */
async function lockTask(client: PoolClient, id: string): Promise<{ databaseId: string; task: ItemRow }> {
  const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
  const task = tasks ? await itemsStore.lockItemById(client, tasks.id, id) : null;
  if (!tasks || !task || task.deletedAt) throw new NotFoundError(`Task ${id} not found`);
  return { databaseId: tasks.id, task };
}

async function writeSeriesProperties(
  client: PoolClient,
  ctx: RouteParams & RouteBody & RouteUser,
  databaseId: string,
  taskId: string,
  propertiesPatch: Record<string, unknown>,
): Promise<ItemRow> {
  const userId = ctx.identity.user.id;
  await updateItemWithClient(
    client,
    { databaseId, itemId: taskId, propertiesPatch },
    {
      allowedSystemKeys: SERIES_PROPERTY_KEYS,
      systemOwnerProcess: TASKS_MODULE_ID,
      writer: { writerKind: "user" },
      actingUserId: userId,
      humanWriterUserId: userId,
    },
  );
  const updated = await itemsStore.getItemById(client, databaseId, taskId);
  if (!updated) throw new Error(`Task ${taskId} disappeared during its recurrence write`);
  return updated;
}

/**
 * `PUT /api/tasks/:id/recurrence`: sets a recurrence from `{preset}` or `{mode, rule}`, optionally with a new
 * `date`. Locks the task, then its `task_recurrence` row. A task without a series gets a new one (or its inactive
 * row restarted); a current occurrence gets the rule replaced. Task properties are written through the Tasks write
 * path in the same transaction; a sent `date` also moves the anchor. A task without a date is refused on `date`.
 */
export function createTaskRecurrenceSetRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody & RouteUser): Promise<{ status: number; item: ItemRow }> => {
    const id = taskId(ctx);
    parseRequest(ctx.body);
    return withTransaction(pool, async (client) => {
      const { databaseId, task } = await lockTask(client, id);
      const propertiesPatch = await applyRecurrenceCommand(client, task, {}, ctx.body, { writerKind: "user" }, true);
      const item = await writeSeriesProperties(client, ctx, databaseId, task.id, propertiesPatch);
      return { status: 200, item };
    });
  };
}

/**
 * `DELETE /api/tasks/:id/recurrence`: locks the task, then its series row, deactivates the series and clears the
 * series properties; the task keeps its `date`. A task without a series is returned unchanged.
 */
export function createTaskRecurrenceClearRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody & RouteUser): Promise<{ status: number; item: ItemRow }> => {
    const id = taskId(ctx);
    return withTransaction(pool, async (client) => {
      const { databaseId, task } = await lockTask(client, id);
      const propertiesPatch = await applyRecurrenceCommand(client, task, {}, null, { writerKind: "user" }, true);
      if (Object.keys(propertiesPatch).length === 0) return { status: 200, item: task };
      const item = await writeSeriesProperties(client, ctx, databaseId, task.id, propertiesPatch);
      return { status: 200, item };
    });
  };
}
