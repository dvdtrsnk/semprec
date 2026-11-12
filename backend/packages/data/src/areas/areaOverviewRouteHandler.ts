import { DateTime } from "luxon";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { readTime } from "../calendar/eventTime.js";
import { isCalendarDate } from "../calendar/eventValidationHook.js";
import { getCalendarClock } from "../calendarTime.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { countItemsGrouped, getItemById } from "../chokePoint/itemsStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { AREAS_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { TaskRecurrenceMode, TaskRecurrenceRule } from "../tasks/taskRecurrenceRule.js";
import { getTaskRecurrence } from "../tasks/taskRecurrenceStore.js";
import { compileFilterNode, type FilterProperties } from "../views/filterCompiler.js";
import { buildFilterProperties } from "../views/filterProperties.js";
import type { FilterNode } from "../views/filterTree.js";

/** The horizon of `upcoming`, in days counting today. */
const HORIZON_DAYS = 14;
/** The largest number of entries `upcoming` holds. */
const UPCOMING_LIMIT = 20;
const OPEN_TASK_STATUS = "notDone";
const ARCHIVED_PROJECT_STATUS = "archived";

/**
 * The active-project rule (issue #1760): a project of the user's own whose status is `inProgress` or `longTerm`.
 * A system project stores a `systemActive` value, `true` or `false`, and a user's project stores none.
 */
const ACTIVE_PROJECTS_FILTER: FilterNode = {
  type: "and",
  nodes: [
    { type: "is_empty", property: "systemActive" },
    { type: "in", property: "status", value: ["inProgress", "longTerm"] },
  ],
};

/** One entry of `upcoming`, as `GET /api/areas/:id/overview` returns it. */
interface AreaOverviewEntry {
  kind: "task" | "event";
  itemId: string;
  /** The item's `name`, or `""` when it has none. */
  title: string;
  date: string;
  timeFrom: string | null;
  timeTo: string | null;
  /** `notDone` for a task, `null` for an event. */
  status: string | null;
  /**
   * The mode and rule of the active `task_recurrence` row that points at the task; `null` for a task without
   * such a row and for an event.
   */
  recurrence: { mode: TaskRecurrenceMode; rule: TaskRecurrenceRule } | null;
  /** The project the item belongs to: its id, its `name` (`""` when it has none) and its own `color`. */
  project: { id: string; title: string; color: string | null };
}

interface AreaOverview {
  activeProjectCount: number;
  todayTaskCount: number;
  openTaskCount: number;
  upcomingEventCount: number;
  upcoming: AreaOverviewEntry[];
}

/** One relation of the Projects database, as its edges are stored in `item_relations`. */
interface ProjectRelation {
  definitionId: string;
  /** The side of the definition a project sits on. */
  projectSide: "a" | "b";
  /** The database of the items at the other end. */
  otherDatabaseId: string;
}

interface ProjectsSchema {
  databaseId: string;
  properties: FilterProperties;
  area: ProjectRelation;
  tasks: ProjectRelation;
  events: ProjectRelation;
}

/**
 * The Projects database of the tenant in scope with its relations to Areas, Tasks and Events. The system seed
 * creates all of them, so a tenant that holds an area and lacks one of them has a broken schema: that is an
 * error, not an empty overview.
 */
async function readProjectsSchema(client: PoolClient): Promise<ProjectsSchema> {
  const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
  if (!projects) throw new Error("The Projects database is missing");
  const properties = await buildFilterProperties(client, await listPropertiesByDatabase(client, projects.id));
  const relation = (key: string): ProjectRelation => {
    const property = properties.get(key);
    if (!property?.relationDefinitionId || !property.relationSide || !property.targetDatabaseId) {
      throw new Error(`The Projects relation '${key}' has no resolvable definition`);
    }
    return {
      definitionId: property.relationDefinitionId,
      projectSide: property.relationSide,
      otherDatabaseId: property.targetDatabaseId,
    };
  };
  return {
    databaseId: projects.id,
    properties,
    area: relation("area"),
    tasks: relation("tasks"),
    events: relation("events"),
  };
}

/** The two `item_relations` columns of a Projects relation: the one with the project and the one with the other end. */
function edgeColumns(relation: ProjectRelation): { project: "item_a" | "item_b"; other: "item_a" | "item_b" } {
  return relation.projectSide === "a" ? { project: "item_a", other: "item_b" } : { project: "item_b", other: "item_a" };
}

/**
 * The area's number of active projects, read with the grouped count of issue #1709: the live projects that
 * `ACTIVE_PROJECTS_FILTER` matches, grouped by their area. An area without such a project has no group.
 */
async function countActiveProjects(client: PoolClient, schema: ProjectsSchema, areaId: string): Promise<number> {
  const { groups } = await countItemsGrouped(client, schema.databaseId, {
    buildFilterSql: (params) => compileFilterNode(ACTIVE_PROJECTS_FILTER, schema.properties, params),
    grouping: {
      kind: "relation",
      relationDefinitionId: schema.area.definitionId,
      ownSide: schema.area.projectSide,
      targetDatabaseId: schema.area.otherDatabaseId,
    },
  });
  return groups?.find((group) => group.key === areaId)?.count ?? 0;
}

const linkedRow = z.object({
  itemId: z.string(),
  title: z.string().nullable(),
  date: z.string().nullable(),
  timeFrom: z.string().nullable(),
  timeTo: z.string().nullable(),
  projectId: z.string(),
  projectTitle: z.string().nullable(),
  projectColor: z.string().nullable(),
});

type LinkedRow = z.infer<typeof linkedRow>;

/**
 * The live items that the eligible projects of an area hold through `relation`, each with its project. A
 * project is eligible when it is a live project of the area, its status is not `archived` and it stores no
 * `systemActive` value; a project with status `done` is eligible. `condition` narrows the items, which the
 * statement calls `linked`.
 *
 * Parameters: `$1` the definition of the Projects `area` relation, `$2` the Projects database, `$3` the area,
 * `$4` the status `archived`, `$5` the definition of `relation`, `$6` the database of the items. `condition`
 * uses `$7` and up.
 */
function linkedItemsSql(area: ProjectRelation, relation: ProjectRelation, condition: string): string {
  // The four column names below are `item_a` or `item_b`, chosen by the side of each relation definition, and
  // `condition` is one of the two constants of this module: nothing in the statement text comes from a request.
  const areaEdge = edgeColumns(area);
  const linkedEdge = edgeColumns(relation);
  return `
SELECT linked.id AS "itemId", linked.properties->>'name' AS title, linked.properties->>'date' AS date,
       linked.properties->>'timeFrom' AS "timeFrom", linked.properties->>'timeTo' AS "timeTo",
       project.id AS "projectId", project.properties->>'name' AS "projectTitle",
       project.properties->>'color' AS "projectColor"
  FROM item_relations area_edge
  JOIN items project ON project.database_id = $2 AND project.id = area_edge.${areaEdge.project}
   AND project.deleted_at IS NULL
  JOIN item_relations linked_edge ON linked_edge.relation_definition_id = $5
   AND linked_edge.${linkedEdge.project} = project.id
  JOIN items linked ON linked.database_id = $6 AND linked.id = linked_edge.${linkedEdge.other}
   AND linked.deleted_at IS NULL
 WHERE area_edge.relation_definition_id = $1 AND area_edge.${areaEdge.other} = $3
   AND project.properties->>'status' IS DISTINCT FROM $4
   AND coalesce(project.properties->>'systemActive', '') = ''
   AND ${condition}`;
}

/** Every task with status `$7`, with or without a date. */
const OPEN_TASKS_CONDITION = `linked.properties->>'status' = $7`;

/**
 * The events whose stored `date`, compared as text, is from `$7` to `$8`. A stored value that is not a
 * calendar date can pass this comparison; the caller judges each row's whole value.
 */
const EVENTS_IN_RANGE_CONDITION = `(linked.properties->>'date') COLLATE "C" BETWEEN $7 AND $8`;

async function readLinkedItems(
  client: PoolClient,
  schema: ProjectsSchema,
  areaId: string,
  relation: ProjectRelation,
  condition: string,
  conditionParams: string[],
): Promise<LinkedRow[]> {
  const { rows } = await client.query<Record<string, unknown>>(linkedItemsSql(schema.area, relation, condition), [
    schema.area.definitionId,
    schema.databaseId,
    areaId,
    ARCHIVED_PROJECT_STATUS,
    relation.definitionId,
    relation.otherDatabaseId,
    ...conditionParams,
  ]);
  return rows.map((row) => linkedRow.parse(row));
}

/**
 * The rows that have a place in time, as entries: a row whose stored `date` is not a calendar date
 * `YYYY-MM-DD` has none and is left out. A stored time that is not a wall-clock time counts as no time.
 */
function toEntries(kind: AreaOverviewEntry["kind"], rows: LinkedRow[]): AreaOverviewEntry[] {
  return rows.flatMap((row) => {
    if (!isCalendarDate(row.date)) return [];
    return [
      {
        kind,
        itemId: row.itemId,
        title: row.title ?? "",
        date: row.date,
        timeFrom: readTime(row.timeFrom, "timeFrom") ?? null,
        timeTo: readTime(row.timeTo, "timeTo") ?? null,
        status: kind === "task" ? OPEN_TASK_STATUS : null,
        recurrence: null,
        project: { id: row.projectId, title: row.projectTitle ?? "", color: row.projectColor },
      },
    ];
  });
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The overview of a live area of the tenant in scope at the instant `at`, or `null` when `areaId` names no
 * such area: an unknown id, an item of another database, an area in the trash, another tenant's area (the
 * lookup reads the Areas database of the tenant in scope) and a tenant without an Areas database all answer
 * the same way.
 *
 * "Today" and "now" are the date and the wall-clock minute of `at` in the tenant's time zone. The horizon
 * ends with the 14th day counting today.
 *
 * - `activeProjectCount`: see `countActiveProjects`.
 * - `openTaskCount`: the `notDone` tasks of the area's eligible projects (`linkedItemsSql`), dated or not.
 * - `todayTaskCount`: those of them whose date is today or earlier.
 * - `upcoming`: those of them whose date is not after the horizon, and the events of the eligible projects
 *   that start from now to the end of the horizon. An event starts at its `timeFrom` on its `date`, an
 *   all-day event at 00:00, and is compared with now by the minute. The entries are ordered by date, then by
 *   time with the entries without a time first, then by title as `collator` compares it, then by item id, and
 *   cut to the first 20.
 * - `upcomingEventCount`: the number of those events before the cut.
 *
 * A task or an event in the trash is never read. A task of the list gets its `recurrence` from the
 * `task_recurrence` row that points at it, with one lookup for each listed task.
 */
async function readAreaOverview(
  client: PoolClient,
  areaId: string,
  at: Date,
  collator: Intl.Collator,
): Promise<AreaOverview | null> {
  const areas = await getDatabaseByModuleId(client, AREAS_MODULE_ID);
  const area = areas && (await getItemById(client, areas.id, areaId));
  if (!area || area.deletedAt !== null) return null;

  const schema = await readProjectsSchema(client);
  const clock = await getCalendarClock(client);
  const today = clock.today(at);
  const now = clock.now(at);
  const horizonEnd = DateTime.fromISO(today, { zone: "utc" })
    .plus({ days: HORIZON_DAYS - 1 })
    .toFormat("yyyy-MM-dd");

  // `area.id` is the id as the database prints it, which is the form the count's group keys have.
  const activeProjectCount = await countActiveProjects(client, schema, area.id);
  const openTasks = await readLinkedItems(client, schema, area.id, schema.tasks, OPEN_TASKS_CONDITION, [
    OPEN_TASK_STATUS,
  ]);
  const eventsInRange = await readLinkedItems(client, schema, area.id, schema.events, EVENTS_IN_RANGE_CONDITION, [
    today,
    horizonEnd,
  ]);

  const datedTasks = toEntries("task", openTasks);
  const upcomingEvents = toEntries("event", eventsInRange).filter(
    (event) => `${event.date} ${event.timeFrom ?? "00:00"}` >= `${now.date} ${now.time}`,
  );
  const upcoming = [...datedTasks.filter((task) => task.date <= horizonEnd), ...upcomingEvents]
    .sort(
      (a, b) =>
        compareText(a.date, b.date) ||
        compareText(a.timeFrom ?? "", b.timeFrom ?? "") ||
        collator.compare(a.title, b.title) ||
        compareText(a.itemId, b.itemId),
    )
    .slice(0, UPCOMING_LIMIT);
  for (const entry of upcoming) {
    if (entry.kind !== "task") continue;
    const recurrence = await getTaskRecurrence(client, entry.itemId);
    if (recurrence?.active) entry.recurrence = { mode: recurrence.mode, rule: recurrence.rule };
  }

  return {
    activeProjectCount,
    todayTaskCount: datedTasks.filter((task) => task.date <= today).length,
    openTaskCount: openTasks.length,
    upcomingEventCount: upcomingEvents.length,
    upcoming,
  };
}

/**
 * Duck-typed the same way `calendar/eventParticipantsRouteHandlers.ts` is: matches `semprec-api`'s
 * `AdapterRequestContext` structurally, with no dependency on that service's HTTP types.
 */
interface AreaOverviewRouteRequestContext {
  params: Record<string, string>;
  identity: { user: { locale: string } };
}

const areaIdSchema = z.uuid();

/**
 * `GET /api/areas/:id/overview` (issue #1760): what an area's page shows above its content, as
 * `{ activeProjectCount, todayTaskCount, openTaskCount, upcomingEventCount, upcoming }`; `readAreaOverview`
 * states each value. Titles are compared in Czech or English by the caller's `users.locale`
 * (`toManifestLocale`). Every statement runs in one REPEATABLE READ transaction in the caller's tenant scope,
 * so the counts and the list describe one state of the data, and another tenant's area answers exactly like
 * an unknown id: the same `not_found` body. An `id` that is not a UUID is `validation_failed` on `id`.
 */
export function createAreaOverviewRouteHandler(pool: Pool) {
  return async (ctx: AreaOverviewRouteRequestContext): Promise<{ status: number; body: unknown }> => {
    const parsedId = areaIdSchema.safeParse(ctx.params.id);
    if (!parsedId.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const collator = new Intl.Collator(toManifestLocale(ctx.identity.user.locale));
    const overview = await withTransaction(
      pool,
      (client) => readAreaOverview(client, parsedId.data, new Date(), collator),
      { isolation: "repeatable_read" },
    );
    if (overview === null) throw new NotFoundError("Area not found");
    return { status: 200, body: overview };
  };
}
