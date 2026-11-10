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

interface Context {
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string } };
}

/** The `owner: 'system'` Tasks properties these routes write as the Tasks module (issue #1605). */
const SERIES_PROPERTY_KEYS = ["seriesId", "occurrenceDate", "recurrence"] as const;
function taskId(ctx: Context): string {
  const result = z.uuid().safeParse(ctx.params.id);
  if (!result.success) throw new ValidationError("Task id must be a UUID", { field: "id" });
  return result.data;
}

/** The Tasks database and the task `id`, locked; another tenant's task and a trashed one are not found alike. */
async function lockTask(client: PoolClient, id: string): Promise<{ databaseId: string; task: ItemRow }> {
  const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
  const task = tasks ? await itemsStore.lockItemById(client, tasks.id, id) : null;
  if (!tasks || !task || task.deletedAt) throw new NotFoundError(`Task ${id} not found`);
  return { databaseId: tasks.id, task };
}

async function writeSeriesProperties(
  client: PoolClient,
  ctx: Context,
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
 * `PUT /api/tasks/:id/recurrence` (issue #1665): sets or changes a task's recurrence from `{preset}` or `{mode, rule}`,
 * optionally with a new `date`. In one transaction it locks the task, then its `task_recurrence` row. A task without a
 * series gets a new one (a new row, or its own inactive row restarted with a new `seriesId`); the current occurrence of
 * a series gets the rule replaced. The task's `date` (when sent), `seriesId`, `occurrenceDate` and
 * `recurrence` (`{preset, mode, rule}`) are written through the Tasks write path in the same transaction; a sent
 * `date` also moves the series anchor. A task without a date is refused on `date`.
 */
export function createTaskRecurrenceSetRouteHandler(pool: Pool) {
  return async (ctx: Context): Promise<{ status: number; item: ItemRow }> => {
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
 * `DELETE /api/tasks/:id/recurrence` (issue #1665): turns a task's recurrence off. It locks the task, then its series
 * row, deactivates the series and clears `seriesId`, `occurrenceDate` and `recurrence` on the task, which keeps its
 * `date` as a non-recurring task. A task without a series is returned unchanged.
 */
export function createTaskRecurrenceClearRouteHandler(pool: Pool) {
  return async (ctx: Context): Promise<{ status: number; item: ItemRow }> => {
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
