import type { PoolClient } from "pg";
import { z } from "zod";
import { requireSingleRow } from "../db/pool.js";
import { mailThreadCopyCtes } from "./mailThreadListQuery.js";

export interface MailThreadFacets {
  total: number;
  projects: {
    total: number;
    /** Only projects with a count above 0. Ordered by id. */
    items: Array<{ id: string; count: number }>;
  };
}

const facetsRow = z.object({
  total: z.number().int(),
  projects: z.array(z.object({ id: z.uuid(), count: z.number().int() })),
});

/**
 * The total and the project group in one statement, so they read one snapshot. `$1` is null: list mode, drafts left
 * out.
 *
 * A copy is visible when it has a folder other than Junk/Trash (or none) and none of its folders is in
 * `junk_labels`. The second condition is for label mailboxes (Gmail): there one copy carries all its
 * labels, so a Trash or Junk label hides it whatever else it carries. In folder mailboxes (IMAP, Graph)
 * each folder edge is its own copy, so the first condition decides. A project in the trash counts as absent.
 */
const MAIL_THREAD_FACETS_SQL = `
WITH ${mailThreadCopyCtes(1)}, junk_labels AS (
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
), project_counts AS (
  SELECT project_id AS id, count(DISTINCT thread_id)::int AS n
  FROM thread_project
  GROUP BY project_id
)
SELECT (SELECT count(*)::int FROM visible_threads) AS total,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', pc.id, 'count', pc.n) ORDER BY pc.id), '[]'::jsonb)
   FROM project_counts pc) AS projects
`;

/** RLS and the tenant filters confine every count. */
export async function readMailThreadFacets(client: PoolClient): Promise<MailThreadFacets> {
  const { rows } = await client.query<Record<string, unknown>>(MAIL_THREAD_FACETS_SQL, [null]);
  const row = facetsRow.parse(requireSingleRow(rows, "mail thread facets"));
  return { total: row.total, projects: { total: row.total, items: row.projects } };
}
