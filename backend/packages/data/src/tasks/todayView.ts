// The single definition of the Tasks "today" list: visibility, membership, the system view storing that filter,
// and its open count. Host state derivation, `item.count` and the overview route live elsewhere.
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { countItemsGrouped } from "../chokePoint/itemsStore.js";
import { createView } from "../chokePoint/viewsStore.js";
import type { ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ViewRow } from "../types.js";
import { compileFilterNode, resolveFilterCompileContext } from "../views/filterCompiler.js";
import { buildFilterProperties } from "../views/filterProperties.js";
import type { FilterNode } from "../views/filterTree.js";

/** Clients find the view by this key, never by its name. */
export const TASKS_TODAY_VIEW_KEY = "today";

/** Not a key: nothing looks the view up by it. */
const TASKS_TODAY_VIEW_NAME = "Today";

/**
 * `hiddenUntil` empty or passed, and no `completedInEvent` edge; item reads exclude deleted tasks on their own.
 * The one visibility definition used by the view and every count.
 */
export function tasksVisibleFilter(): FilterNode {
  return {
    type: "and",
    nodes: [
      {
        type: "or",
        nodes: [
          { type: "is_empty", property: "hiddenUntil" },
          { type: "date_relative", property: "hiddenUntil", preset: "beforeNow" },
        ],
      },
      { type: "relation_is_empty", property: "completedInEvent" },
    ],
  };
}

/**
 * In the tenant zone: unfinished tasks effective today, `notDone` tasks effective in the past, and `done` tasks
 * completed today (falling back to the effective day without `completedOn`). `openOnly` keeps only `notDone`.
 */
export function tasksTodayFilter(options: { openOnly: boolean }): FilterNode {
  const today: FilterNode = {
    type: "and",
    nodes: [
      tasksVisibleFilter(),
      {
        type: "or",
        nodes: [
          {
            type: "and",
            nodes: [
              { type: "not_equals", property: "status", value: "done" },
              { type: "date_relative", property: "effectiveDate", preset: "today" },
            ],
          },
          {
            type: "and",
            nodes: [
              { type: "date_relative", property: "effectiveDate", preset: "past" },
              { type: "equals", property: "status", value: "notDone" },
            ],
          },
          {
            type: "and",
            nodes: [
              { type: "equals", property: "status", value: "done" },
              { type: "date_relative", property: "completedOn", preset: "today" },
            ],
          },
          {
            type: "and",
            nodes: [
              { type: "equals", property: "status", value: "done" },
              { type: "is_empty", property: "completedOn" },
              { type: "date_relative", property: "effectiveDate", preset: "today" },
            ],
          },
        ],
      },
    ],
  };
  if (!options.openOnly) return today;
  return { type: "and", nodes: [today, { type: "equals", property: "status", value: "notDone" }] };
}

/** The caller holds the transaction and decides whether the view exists. */
export function createTasksTodayView(
  client: PoolClient,
  tasksDatabaseId: string,
  viewTypeRegistry: ViewTypeRegistry,
): Promise<ViewRow> {
  return createView(
    client,
    {
      databaseId: tasksDatabaseId,
      type: "table",
      name: TASKS_TODAY_VIEW_NAME,
      isDefault: false,
      createdBy: "system",
      config: { systemKey: TASKS_TODAY_VIEW_KEY, filter: tasksTodayFilter({ openOnly: false }) },
    },
    viewTypeRegistry,
  );
}

/**
 * The number of open tasks in the Today list: the statement `item.count` runs for `tasksTodayFilter({ openOnly: true })`, in the
 * caller's transaction. `now` evaluates relative dates; defaults to the current time.
 */
export async function countTasksToday(client: PoolClient, now?: Date): Promise<number> {
  const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
  if (!tasks) throw new Error("The Tasks database is missing");
  const filter = tasksTodayFilter({ openOnly: true });
  const properties = await buildFilterProperties(client, await listPropertiesByDatabase(client, tasks.id));
  const context = await resolveFilterCompileContext(client, filter, now);
  const { count } = await countItemsGrouped(client, tasks.id, {
    buildFilterSql: (params) => compileFilterNode(filter, properties, params, context),
  });
  return count;
}
