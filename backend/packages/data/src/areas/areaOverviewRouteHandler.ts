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
import { NotFoundError } from "../errors.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { AREAS_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { TaskRecurrenceMode, TaskRecurrenceRule } from "../tasks/taskRecurrenceRule.js";
import { getTaskRecurrence } from "../tasks/taskRecurrenceStore.js";
import { compileFilterNode, type FilterProperties } from "../views/filterCompiler.js";
import { buildFilterProperties } from "../views/filterProperties.js";
import type { FilterNode } from "../views/filterTree.js";
import type { CustomRouteResult, RouteParams, RouteLocale } from "../customRoute.js";
import { requireUuidParam } from "../customRoute.js";

/** Days counting today. */
const HORIZON_DAYS = 14;
const UPCOMING_LIMIT = 20;
const OPEN_TASK_STATUS = "notDone";
const ARCHIVED_PROJECT_STATUS = "archived";

/** A user's own project (system projects always store `systemActive`) that is `inProgress` or `longTerm`. */
export const ACTIVE_PROJECTS_FILTER: FilterNode = {
  type: "and",
  nodes: [
    { type: "is_empty", property: "systemActive" },
    { type: "in", property: "status", value: ["inProgress", "longTerm"] },
  ],
};

interface AreaOverviewEntry {
  kind: "task" | "event";
  itemId: string;
  title: string;
  date: string;
  timeFrom: string | null;
  timeTo: string | null;
  /** `null` for an event. */
  status: string | null;
  /** From the active `task_recurrence` row; `null` for an event. */
  recurrence: { mode: TaskRecurrenceMode; rule: TaskRecurrenceRule } | null;
  project: { id: string; title: string; color: string | null };
}

interface AreaOverview {
  activeProjectCount: number;
  todayTaskCount: number;
  openTaskCount: number;
  upcomingEventCount: number;
  upcoming: AreaOverviewEntry[];
}

interface ProjectRelation {
  definitionId: string;
  projectSide: "a" | "b";
  otherDatabaseId: string;
}

interface ProjectsSchema {
  databaseId: string;
  properties: FilterProperties;
  area: ProjectRelation;
  tasks: ProjectRelation;
  events: ProjectRelation;
}

/** The system seed creates all of these, so a missing one is a broken schema (an error, not an empty overview). */
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

function edgeColumns(relation: ProjectRelation): { project: "item_a" | "item_b"; other: "item_a" | "item_b" } {
  return relation.projectSide === "a" ? { project: "item_a", other: "item_b" } : { project: "item_b", other: "item_a" };
}

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
 * Eligible projects: live, of the area, not `archived` (`done` counts), and not system projects. `condition` filters
 * the `linked` alias and uses `$7` and up.
 */
function linkedItemsSql(area: ProjectRelation, relation: ProjectRelation, condition: string): string {
  // Interpolated column names and `condition` are module constants; nothing in the SQL text comes from a request.
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

const OPEN_TASKS_CONDITION = `linked.properties->>'status' = $7`;

/** A text comparison that non-date values can pass; the caller validates each row. */
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

/** Drops rows without a valid calendar date; an invalid time counts as no time. */
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
 * `null` for any id that is not a live area of the tenant in scope, so another tenant's area looks unknown. "Today"
 * and "now" are in the tenant's time zone; an all-day event starts at 00:00. `upcomingEventCount` is taken before the
 * `UPCOMING_LIMIT` cut.
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

  // `area.id` is in the database's printed form, matching the group keys.
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
 * `GET /api/areas/:id/overview`. REPEATABLE READ so the counts and the list describe one state of the data. Another
 * tenant's area answers exactly like an unknown id.
 */
export function createAreaOverviewRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteLocale): Promise<CustomRouteResult> => {
    const id = requireUuidParam(ctx.params, "id");
    const collator = new Intl.Collator(toManifestLocale(ctx.identity.user.locale));
    const overview = await withTransaction(pool, (client) => readAreaOverview(client, id, new Date(), collator), {
      isolation: "repeatable_read",
    });
    if (overview === null) throw new NotFoundError("Area not found");
    return { status: 200, body: overview };
  };
}
