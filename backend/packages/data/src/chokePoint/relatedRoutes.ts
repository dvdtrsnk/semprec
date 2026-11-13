// The related collections that are not simply the records connected to the viewed record (issue #1839): the
// records of an area or a company that reach it through a project, and the recordings of a project that reach it
// through an event. Each route names the collection by its database key and gives the filter tree that selects
// its records; `relatedOps.ts` counts the records that filter selects and lists the route in place of the
// directly connected records of the same database.
import type { AreaFilterTemplate } from "@semprec/module-registry";
import {
  EVENTS_MODULE_ID,
  FILES_MODULE_ID,
  HEALTH_RECORDS_MODULE_ID,
  TASKS_MODULE_ID,
  TRANSCRIPTS_MODULE_ID,
} from "../seed/tenDatabaseKeys.js";
import { expandAreaFilter } from "../views/areaFilter.js";
import type { FilterNode } from "../views/filterTree.js";

export interface RelatedRoute {
  filter: FilterNode;
  via: "direct" | "project";
}

/** The routes of one record, by the key of the database whose records they select. */
export type RelatedRoutes = Map<string, RelatedRoute>;

/** Whether a declared area filter steps through a project: it names a two-relation path. */
function templateStepsThroughProject(template: AreaFilterTemplate): boolean {
  switch (template.type) {
    case "relation_path_contains":
      return true;
    case "and":
    case "or":
      return template.nodes.some(templateStepsThroughProject);
    default:
      return false;
  }
}

/**
 * The records of an area, by each database's area filter as its module manifest declares it (issue #1597): a
 * project, a company and a journal entry by their own area, a task by the area of its project alone (a task has no
 * area of its own, so a task without a project never matches), and an event, a file and a health record by the area
 * of their project or, when they have none, by their own area. Such a record is counted once whichever way it
 * reaches the area. A database without a declaration has no route.
 */
export function areaRoutes(
  areaId: string,
  declarations: ReadonlyArray<{ databaseKey: string; template: AreaFilterTemplate }>,
): RelatedRoutes {
  const routes: RelatedRoutes = new Map();
  for (const { databaseKey, template } of declarations) {
    routes.set(databaseKey, {
      filter: expandAreaFilter(template, areaId),
      via: templateStepsThroughProject(template) ? "project" : "direct",
    });
  }
  return routes;
}

/**
 * The mail threads of an area are those of its projects: the route steps through the thread's project (the relation
 * `project` of the Threads database). The Threads manifest declares no area filter of its own.
 */
export function areaThreadsRoute(areaId: string): RelatedRoute {
  return { filter: { type: "relation_path_contains", path: ["project", "area"], value: areaId }, via: "project" };
}

/**
 * The records of a company that reach it through a project. A task has no company of its own, so only its project
 * counts. An event or a file that has a project counts for the company of that project, and only an event or a
 * file without a project counts for the company that is set on it directly. A company has no health record
 * of its own either, so a health record counts through its project alone.
 */
export function companyRoutes(companyId: string): RelatedRoutes {
  const throughProject = (projectKey: string): FilterNode => ({
    type: "relation_path_contains",
    path: [projectKey, "company"],
    value: companyId,
  });
  const throughProjectOrOwnCompany = (projectKey: string, companyKey: string): FilterNode => ({
    type: "or",
    nodes: [
      throughProject(projectKey),
      {
        type: "and",
        nodes: [
          { type: "relation_is_empty", property: projectKey },
          { type: "relation_contains", property: companyKey, value: companyId },
        ],
      },
    ],
  });
  return new Map<string, RelatedRoute>([
    [TASKS_MODULE_ID, { filter: throughProject("project"), via: "project" }],
    [EVENTS_MODULE_ID, { filter: throughProjectOrOwnCompany("project", "company"), via: "project" }],
    [FILES_MODULE_ID, { filter: throughProjectOrOwnCompany("projects", "companies"), via: "project" }],
    [HEALTH_RECORDS_MODULE_ID, { filter: throughProject("projects"), via: "project" }],
  ]);
}

/**
 * The recordings of a project: those set on the project itself and those of its events (a transcript reaches its
 * event as `event`, and the event its project as `project`).
 */
export function projectRoutes(projectId: string): RelatedRoutes {
  return new Map<string, RelatedRoute>([
    [
      TRANSCRIPTS_MODULE_ID,
      {
        filter: {
          type: "or",
          nodes: [
            { type: "relation_contains", property: "project", value: projectId },
            { type: "relation_path_contains", path: ["event", "project"], value: projectId },
          ],
        },
        via: "direct",
      },
    ],
  ]);
}
