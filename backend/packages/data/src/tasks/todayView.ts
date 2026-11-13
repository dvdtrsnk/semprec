// Owns the single definition of the Tasks "today" list: which tasks are visible, which of them belong to today, the
// system view that stores that filter, and the count of its open tasks. It does not own the derivation of
// `effectiveDate`, `hiddenUntil` or the `completedInEvent` edge (taskHostEventState.ts, taskCompletedInEventHook.ts),
// the `item.count` operation, or the overview route that shows the count.
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

/** The `config.systemKey` of the Today view of the Tasks database; clients find the view by it, never by its name. */
export const TASKS_TODAY_VIEW_KEY = "today";

/** The stored name of the seeded view. It is not a key: nothing looks the view up by it. */
const TASKS_TODAY_VIEW_NAME = "Today";

/**
 * The tasks that are not hidden: `hiddenUntil` is empty or already passed, and the task has no `completedInEvent`
 * edge. A deleted task is never visible, which the item reads apply on their own. This is the one definition of
 * visibility; the Today view and every count of it use it.
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
 * The visible tasks the user looks at today, in the tenant time zone: an unfinished task whose effective day is
 * today, a `notDone` task whose effective day is past, and a `done` task completed today (a `done` task without a
 * `completedOn` falls back to its effective day). `openOnly` keeps only `notDone` tasks of that list.
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

/** Creates the Today system view on the Tasks database. The caller holds the transaction and decides whether it exists. */
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
 * The number of open (`notDone`) tasks of the Today list, the count behind the badge of the overview. It runs the
 * statement `item.count` runs for `tasksTodayFilter({ openOnly: true })` over the Tasks database, in the caller's
 * transaction and tenant. `now` is the clock the relative dates are evaluated at; it defaults to the current time.
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
