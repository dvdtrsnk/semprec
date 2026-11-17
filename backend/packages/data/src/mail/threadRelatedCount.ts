// The mail row of a person's related collections: the number of mail threads holding a message the person
// is on, instead of the Emails collection the generic read would list. Read-only.
import type { PoolClient } from "pg";
import type { RelatedCollectionRow, RelatedContributorContext } from "../chokePoint/relatedContributors.js";
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";

interface ThreadCountRow {
  threads_database_id: string | null;
  count: number;
}

/**
 * A message is the person's when its `senderPeople` or `recipientsPeople` edge (read from the Emails side)
 * reaches them. A message counts while its item is live and it is not only in the Trash folder: a copy in
 * Trash plus another folder counts, as does one with no live folder.
 */
const PERSON_THREAD_COUNT_SQL = `
WITH schema_ids AS (
  SELECT (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'emails') AS emails,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'folders') AS folders,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'threads') AS threads
), folder_definition AS (
  SELECT rd.id, rd.property_id_a = p.id AS email_is_a
  FROM properties p JOIN relation_definitions rd ON p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.tenant_id = app_tenant_default() AND p.database_id = (SELECT emails FROM schema_ids) AND p.key = 'folder'
), person_email AS (
  SELECT DISTINCT CASE WHEN rd.property_id_a = p.id THEN r.item_a ELSE r.item_b END AS email_id
  FROM properties p
  JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  JOIN item_relations r ON r.tenant_id = p.tenant_id AND r.relation_definition_id = rd.id
  WHERE p.tenant_id = app_tenant_default() AND p.database_id = (SELECT emails FROM schema_ids)
    AND p.key IN ('senderPeople', 'recipientsPeople')
    AND (CASE WHEN rd.property_id_a = p.id THEN r.item_b ELSE r.item_a END) = $1::uuid
)
SELECT (SELECT threads FROM schema_ids)::text AS threads_database_id,
       count(DISTINCT m.thread_id)::int AS count
FROM person_email pe
JOIN mail_message_meta m ON m.tenant_id = app_tenant_default() AND m.item_id = pe.email_id AND m.thread_id IS NOT NULL
JOIN items email ON email.tenant_id = m.tenant_id AND email.id = m.item_id
  AND email.database_id = (SELECT emails FROM schema_ids) AND email.deleted_at IS NULL
JOIN mail_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id
JOIN items thread_item ON thread_item.tenant_id = t.tenant_id AND thread_item.id = t.item_id
  AND thread_item.database_id = (SELECT threads FROM schema_ids) AND thread_item.deleted_at IS NULL
LEFT JOIN LATERAL (
  SELECT bool_or(COALESCE(folder.properties->>'specialPurpose' <> 'trash', true)) AS has_non_trash
  FROM folder_definition fd
  JOIN item_relations fr ON fr.tenant_id = m.tenant_id AND fr.relation_definition_id = fd.id
    AND (CASE WHEN fd.email_is_a THEN fr.item_a ELSE fr.item_b END) = email.id
  JOIN items folder ON folder.tenant_id = m.tenant_id AND folder.database_id = (SELECT folders FROM schema_ids)
    AND folder.id = CASE WHEN fd.email_is_a THEN fr.item_b ELSE fr.item_a END AND folder.deleted_at IS NULL
) f ON true
WHERE COALESCE(f.has_non_trash, true)`;

/** `null` when the person has none. Runs in the tenant scope of `client`. */
export async function countPersonMailThreads(
  client: PoolClient,
  personId: string,
): Promise<{ databaseId: string; count: number } | null> {
  const { rows } = await client.query<ThreadCountRow>(PERSON_THREAD_COUNT_SQL, [personId]);
  const row = rows[0];
  if (row === undefined || row.threads_database_id === null || row.count <= 0) return null;
  return { databaseId: row.threads_database_id, count: row.count };
}

/** Unfiltered, like every Threads row: a client opens the thread list by the person's id. */
export async function personMailThreadsRelatedRow(
  context: RelatedContributorContext,
): Promise<RelatedCollectionRow | null> {
  const counted = await countPersonMailThreads(context.client, context.itemId);
  if (counted === null) return null;
  return {
    databaseKey: THREADS_MODULE_ID,
    databaseId: counted.databaseId,
    count: counted.count,
    via: "direct",
    filter: null,
  };
}
