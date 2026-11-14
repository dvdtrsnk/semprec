import type { PoolClient } from "pg";
import { z } from "zod";
import { getValueLinksForItems, type ValueLinkEntry } from "../chokePoint/valueLinkReads.js";

/** The project of an attachment as the thread detail shows it. */
export interface MailAttachmentProject {
  id: string;
  name: string;
}

/**
 * What the thread detail adds to an attachment (issue gh-1922): `project` is the project of its Files item, `links`
 * the value-link entry of that property, under the key `project`, and only when the Files item has a value-link row
 * for `Files.projects`.
 */
export interface MailAttachmentProjects {
  project: MailAttachmentProject | null;
  links: { project?: ValueLinkEntry };
}

const projectRow = z.object({ file_id: z.uuid(), project_id: z.uuid(), project_name: z.string() });

/**
 * One live project per Files item among `$1`: the live project that `Files.projects` of the item reaches. An item with
 * no edge, or only edges to projects in the Trash, has no row. A file with several live projects (the property is
 * many-valued, and a user can add one to the inherited one) answers the one that is first by name and then by item id.
 * The projects are pinned to the Projects database of the tenant. Fixed SQL, `$1` the Files item ids.
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
 * The project and the project link of every Files item in `fileItemIds`, in the caller's transaction and tenant: one
 * statement for the projects (`FILE_PROJECTS_SQL`) and one batched read for the links (`getValueLinksForItems`), so the
 * number of statements does not grow with the number of files. Every id in `fileItemIds` has an entry; a file with no
 * live project reads `project: null`, and a file with no link row for `Files.projects` has no `links.project`. No id
 * means no statement.
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
