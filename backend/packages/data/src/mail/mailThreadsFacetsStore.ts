import type { PoolClient } from "pg";
import { z } from "zod";
import { requireSingleRow } from "../db/pool.js";
import { mailThreadCopyCtes } from "./mailThreadListQuery.js";

export interface MailThreadFacets {
  total: number;
  areas: {
    total: number;
    /** Every live area, 0 included. Ordered by id. */
    items: Array<{ id: string; count: number }>;
  };
  projects: {
    total: number;
    /** Only projects with a count above 0. Ordered by id. */
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
 * Both groups in one statement, so they read one snapshot. `$3` is null: list mode, drafts left out.
 *
 * A copy is visible when it has a folder other than Junk/Trash (or none) and none of its folders is in
 * `junk_labels`. The second condition is for label mailboxes (Gmail): there one copy carries all its
 * labels, so a Trash or Junk label hides it whatever else it carries. In folder mailboxes (IMAP, Graph)
 * each folder edge is its own copy, so the first condition decides. A project or area in the trash
 * counts as absent. Neither group is narrowed by its own selection.
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

/** RLS and the tenant filters confine every count, so another tenant's id selects no thread. */
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
