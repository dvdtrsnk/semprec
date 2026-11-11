import type { PoolClient } from "pg";
import { z } from "zod";
import { requireSingleRow } from "../db/pool.js";
import { mailThreadCopyCtes } from "./mailThreadListQuery.js";

/** The thread counts of the mailbox filter bar (issue gh-1747): one group per area, one per project. */
export interface MailThreadFacets {
  /** The visible threads, whatever is selected. */
  total: number;
  areas: {
    /** The visible threads, or those of the selected project when one is selected. */
    total: number;
    /** One row for every area that is not in the trash, with 0 for an area that counts no thread. Ordered by id. */
    items: Array<{ id: string; count: number }>;
  };
  projects: {
    /** The visible threads, or those whose project is in the selected area when one is selected. */
    total: number;
    /** One row for every project whose count is above 0, `areaId` null for a project that has no area. Ordered by id. */
    items: Array<{ id: string; areaId: string | null; count: number }>;
  };
}

const facetsRow = z.object({
  total: z.number().int(),
  areasTotal: z.number().int(),
  projectsTotal: z.number().int(),
  areas: z.array(z.object({ id: z.uuid(), count: z.number().int() })),
  projects: z.array(z.object({ id: z.uuid(), areaId: z.uuid().nullable(), count: z.number().int() })),
});

/**
 * Both groups of counts in one statement, so they read one snapshot. `$1` is the selected project or
 * null, `$2` the selected area or null. `$3` is the thread id parameter of `mailThreadCopyCtes` and is
 * null: the list mode, which leaves drafts out.
 *
 * - `visible_threads`: a thread with a visible copy in the thread list's `copies`. A copy is visible
 *   when it has a folder other than Junk and Trash, or no folder, and none of its folders is in
 *   `junk_labels`. The second condition is for a mailbox of labels (Folders `behavior` 'label',
 *   Gmail): there a copy is one message and each folder edge is a label it carries, so a message
 *   that carries the Trash or the Junk label is in Trash or Junk whatever else it carries (the Sent
 *   label, a user label). In a mailbox of folders (`behavior` 'folder', IMAP and Graph) each folder
 *   edge of a copy is a message of its own, so the first condition alone decides and the one outside
 *   Junk and Trash is visible. A deleted message has no copy, so a thread whose messages are all
 *   deleted, or all in Junk or Trash, is in no count. No box, folder or mailbox filter applies.
 * - `junk_labels`: one row with the ids of the tenant's live Junk and Trash folders that are labels,
 *   an empty array when there is none.
 * - `thread_project`: the thread's project through `Threads.project`. `project_area`: that project's
 *   area through `Projects.area`. `live_areas` are the areas of `areas.items`. A project or an area in
 *   the trash is not read: a thread whose project is in the trash counts like a thread without a
 *   project, and a project whose area is in the trash has no area.
 * - `thread_facets` has a row for every visible thread, so a thread without a project counts in
 *   `total`, in a group's total while no selection narrows that group, and in no item.
 *
 * The area counts are narrowed by the selected project and the project counts by the selected area;
 * neither group is narrowed by its own selection. `visible_threads` holds a thread once and every
 * count is over distinct thread ids. The two item lookups keyed by a relation row pin `database_id`
 * in the lateral shape that `scheduler/itemRelationFilter.ts` describes.
 */
const MAIL_THREAD_FACETS_SQL = `
WITH ${mailThreadCopyCtes(3)}, junk_labels AS (
  SELECT COALESCE(array_agg(f.id), ARRAY[]::uuid[]) AS folder_ids
  FROM items f
  WHERE f.tenant_id = app_tenant_default() AND f.database_id = (SELECT folders FROM schema_ids) AND f.deleted_at IS NULL
    AND f.properties->>'behavior' = 'label' AND f.properties->>'specialPurpose' IN ('junk', 'trash')
), visible_threads AS (
  SELECT DISTINCT c.thread_id FROM copies c
  WHERE c.has_non_junk AND NOT (c.folder_ids && (SELECT folder_ids FROM junk_labels))
), thread_project AS (
  SELECT v.thread_id, project.id AS project_id
  FROM visible_threads v
  JOIN mail_threads t ON t.tenant_id = app_tenant_default() AND t.id = v.thread_id
  JOIN properties p ON p.tenant_id = t.tenant_id AND p.database_id = (SELECT threads FROM schema_ids) AND p.key = 'project'
  JOIN relation_definitions rd ON rd.tenant_id = t.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  JOIN item_relations r ON r.tenant_id = t.tenant_id AND r.relation_definition_id = rd.id
    AND (CASE WHEN rd.property_id_a = p.id THEN r.item_a ELSE r.item_b END) = t.item_id
  CROSS JOIN LATERAL (SELECT i.id FROM items i WHERE i.tenant_id = t.tenant_id AND i.database_id = (SELECT projects FROM schema_ids)
    AND i.id = CASE WHEN rd.property_id_a = p.id THEN r.item_b ELSE r.item_a END AND i.deleted_at IS NULL OFFSET 0) project
), live_areas AS (
  SELECT i.id FROM items i
  WHERE i.tenant_id = app_tenant_default() AND i.database_id = (SELECT areas FROM schema_ids) AND i.deleted_at IS NULL
), project_area AS (
  SELECT linked.project_id, area.id AS area_id
  FROM (SELECT DISTINCT project_id FROM thread_project) linked
  JOIN properties p ON p.tenant_id = app_tenant_default() AND p.database_id = (SELECT projects FROM schema_ids) AND p.key = 'area'
  JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  JOIN item_relations r ON r.tenant_id = p.tenant_id AND r.relation_definition_id = rd.id
    AND (CASE WHEN rd.property_id_a = p.id THEN r.item_a ELSE r.item_b END) = linked.project_id
  CROSS JOIN LATERAL (SELECT i.id FROM items i WHERE i.tenant_id = p.tenant_id AND i.database_id = (SELECT areas FROM schema_ids)
    AND i.id = CASE WHEN rd.property_id_a = p.id THEN r.item_b ELSE r.item_a END AND i.deleted_at IS NULL OFFSET 0) area
), thread_facets AS (
  SELECT v.thread_id, tp.project_id, pa.area_id
  FROM visible_threads v
  LEFT JOIN thread_project tp ON tp.thread_id = v.thread_id
  LEFT JOIN project_area pa ON pa.project_id = tp.project_id
), totals AS (
  SELECT count(DISTINCT thread_id)::int AS total,
    count(DISTINCT thread_id) FILTER (WHERE $1::uuid IS NULL OR project_id = $1::uuid)::int AS areas_total,
    count(DISTINCT thread_id) FILTER (WHERE $2::uuid IS NULL OR area_id = $2::uuid)::int AS projects_total
  FROM thread_facets
), area_counts AS (
  SELECT a.id, count(DISTINCT f.thread_id)::int AS n
  FROM live_areas a
  LEFT JOIN thread_facets f ON f.area_id = a.id AND ($1::uuid IS NULL OR f.project_id = $1::uuid)
  GROUP BY a.id
), project_counts AS (
  SELECT f.project_id AS id, f.area_id, count(DISTINCT f.thread_id)::int AS n
  FROM thread_facets f
  WHERE f.project_id IS NOT NULL AND ($2::uuid IS NULL OR f.area_id = $2::uuid)
  GROUP BY f.project_id, f.area_id
)
SELECT t.total, t.areas_total AS "areasTotal", t.projects_total AS "projectsTotal",
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', ac.id, 'count', ac.n) ORDER BY ac.id), '[]'::jsonb)
   FROM area_counts ac) AS areas,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', pc.id, 'areaId', pc.area_id, 'count', pc.n) ORDER BY pc.id), '[]'::jsonb)
   FROM project_counts pc) AS projects
FROM totals t
`;

/**
 * The facets of the caller's tenant for the selected project and area, either of which may be null.
 * Row-level security and the tenant filters confine every count to that tenant, so an id of another
 * tenant selects what an unknown id selects: no thread.
 */
export async function readMailThreadFacets(
  client: PoolClient,
  selection: { projectId: string | null; areaId: string | null },
): Promise<MailThreadFacets> {
  const { rows } = await client.query<Record<string, unknown>>(MAIL_THREAD_FACETS_SQL, [
    selection.projectId,
    selection.areaId,
    null,
  ]);
  const row = facetsRow.parse(requireSingleRow(rows, "mail thread facets"));
  return {
    total: row.total,
    areas: { total: row.areasTotal, items: row.areas },
    projects: { total: row.projectsTotal, items: row.projects },
  };
}
