// Related collections that are not simply the records connected to the viewed record: records that
// reach a company through a project, and recordings that reach a project through an event.
// `relatedOps.ts` lists a route in place of the directly connected records of the same database.
import {
  EVENTS_MODULE_ID,
  FILES_MODULE_ID,
  HEALTH_RECORDS_MODULE_ID,
  TASKS_MODULE_ID,
  TRANSCRIPTS_MODULE_ID,
} from "../seed/tenDatabaseKeys.js";
import type { FilterNode } from "../views/filterTree.js";

export interface RelatedRoute {
  filter: FilterNode;
  via: "direct" | "project";
}

export type RelatedRoutes = Map<string, RelatedRoute>;

/**
 * The records of a company that reach it through a project. A task and a health record count only
 * through their project; an event or a file counts for its own company only when it has no project.
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

/** Those set on the project itself and those of its events (transcript -> `event` -> `project`). */
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
