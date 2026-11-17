import type { PoolClient } from "pg";
import { z } from "zod";
import { getValueLinksForItems, type ValueLinkEntry } from "../chokePoint/valueLinkReads.js";

export interface MailAttachmentProject {
  id: string;
  name: string;
}

/** `links.project` is present only when the Files item has a value-link row for `Files.projects`. */
export interface MailAttachmentProjects {
  project: MailAttachmentProject | null;
  links: { project?: ValueLinkEntry };
}

const projectRow = z.object({ file_id: z.uuid(), project_id: z.uuid(), project_name: z.string() });

/**
 * One live project per Files item in `$1`; no row for an item without a live project. Several live projects (a user
 * can add one to the inherited one) answer the first by name, then item id. Pinned to the tenant's Projects database.
 */
const FILE_PROJECTS_SQL = `
WITH schema_ids AS (
  SELECT (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'files') AS files,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'projects') AS projects
), file_projects AS (
  SELECT rd.id, rd.property_id_a = p.id AS file_is_a
  FROM properties p JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.tenant_id = app_tenant_default() AND p.database_id = (SELECT files FROM schema_ids) AND p.key = 'projects'
)
SELECT DISTINCT ON (f.file_id) f.file_id, project.id AS project_id, COALESCE(project.properties->>'name', '') AS project_name
FROM unnest($1::uuid[]) AS f(file_id)
JOIN file_projects fp ON true
JOIN item_relations r ON r.tenant_id = app_tenant_default() AND r.relation_definition_id = fp.id
  AND (CASE WHEN fp.file_is_a THEN r.item_a ELSE r.item_b END) = f.file_id
JOIN items project ON project.tenant_id = app_tenant_default() AND project.database_id = (SELECT projects FROM schema_ids)
  AND project.id = CASE WHEN fp.file_is_a THEN r.item_b ELSE r.item_a END AND project.deleted_at IS NULL
ORDER BY f.file_id, COALESCE(project.properties->>'name', ''), project.id`;

/**
 * Two statements whatever the number of files. Every id gets an entry; a file without a live project reads
 * `project: null`. No id means no statement.
 */
export async function readMailAttachmentProjects(
  client: PoolClient,
  fileItemIds: readonly string[],
): Promise<Map<string, MailAttachmentProjects>> {
  const result = new Map<string, MailAttachmentProjects>();
  if (fileItemIds.length === 0) return result;
  const ids = [...new Set(fileItemIds)];
  const { rows } = await client.query<Record<string, unknown>>(FILE_PROJECTS_SQL, [ids]);
  const projects = new Map(
    rows.map((row) => {
      const parsed = projectRow.parse(row);
      return [parsed.file_id, { id: parsed.project_id, name: parsed.project_name }] as const;
    }),
  );
  const links = await getValueLinksForItems(client, ids);
  for (const id of ids) {
    const link = links.get(id)?.projects;
    result.set(id, { project: projects.get(id) ?? null, links: link ? { project: link } : {} });
  }
  return result;
}
