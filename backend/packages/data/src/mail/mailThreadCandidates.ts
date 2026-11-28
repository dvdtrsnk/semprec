import type { PoolClient } from "pg";
import { z } from "zod";

/** A thread's place in the list order, as `YYYY-MM-DDTHH:MI:SS.US` in UTC and the thread id: both compare as text. */
export interface MailThreadOrderKey {
  at: string;
  id: string;
}

export interface MailThreadCandidates {
  threadIds: string[];
  /** The last candidate's key when the window is full; `null` when it holds every candidate there is. */
  boundary: MailThreadOrderKey | null;
}

const candidateRow = z.object({ thread_id: z.uuid(), at: z.string() });

/**
 * The `size` newest threads with a live message in folder `folderId`, or in an Inbox folder when it is `null`, ordered
 * as the list orders threads. Each thread's key is its newest live message of any folder, drafts included, by the
 * list's activity expression: never older than the thread's place in the list, which counts fewer of its messages.
 * Every thread the Inbox or folder list can show is a candidate, so a list computed over a window misses only threads
 * ordered after the window's boundary.
 */
export async function listMailThreadCandidates(
  client: PoolClient,
  folderId: string | null,
  size: number,
): Promise<MailThreadCandidates> {
  const { rows } = await client.query<Record<string, unknown>>(
    `
WITH schema_ids AS (
  SELECT (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'emails') AS emails,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'folders') AS folders
), folder_definition AS (
  SELECT rd.id, rd.property_id_a = p.id AS email_is_a
  FROM properties p JOIN relation_definitions rd ON p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.tenant_id = app_tenant_default() AND p.database_id = (SELECT emails FROM schema_ids) AND p.key = 'folder'
), target_folders AS (
  SELECT f.id FROM items f
  WHERE f.tenant_id = app_tenant_default() AND f.database_id = (SELECT folders FROM schema_ids) AND f.deleted_at IS NULL
    AND CASE WHEN $1::uuid IS NULL THEN f.properties->>'specialPurpose' = 'inbox' ELSE f.id = $1::uuid END
), candidate_threads AS (
  SELECT DISTINCT m.thread_id
  FROM target_folders f
  JOIN folder_definition fd ON true
  -- The OR lets the item_a and item_b indexes find the edges; the CASE keeps the folder's own side.
  JOIN item_relations r ON r.tenant_id = app_tenant_default() AND r.relation_definition_id = fd.id
    AND (r.item_a = f.id OR r.item_b = f.id) AND (CASE WHEN fd.email_is_a THEN r.item_b ELSE r.item_a END) = f.id
  JOIN mail_message_meta m ON m.tenant_id = app_tenant_default()
    AND m.item_id = CASE WHEN fd.email_is_a THEN r.item_a ELSE r.item_b END AND m.thread_id IS NOT NULL
)
SELECT m.thread_id,
  to_char(max(COALESCE(NULLIF(i.properties->>'date', '')::timestamptz, m.ingested_at, i.updated_at)) AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US') AS at
FROM mail_message_meta m
JOIN items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id AND i.database_id = (SELECT emails FROM schema_ids)
  AND i.deleted_at IS NULL
WHERE m.tenant_id = app_tenant_default() AND m.thread_id IN (SELECT thread_id FROM candidate_threads)
GROUP BY m.thread_id
ORDER BY max(COALESCE(NULLIF(i.properties->>'date', '')::timestamptz, m.ingested_at, i.updated_at)) DESC, m.thread_id DESC
LIMIT $2`,
    [folderId, size],
  );
  const candidates = rows.map((row) => candidateRow.parse(row));
  const last = candidates.at(-1);
  return {
    threadIds: candidates.map((candidate) => candidate.thread_id),
    boundary: candidates.length === size && last !== undefined ? { at: last.at, id: last.thread_id } : null,
  };
}

/** Whether `key` orders at or before `boundary` in the list (newest first): no thread after the boundary outranks it. */
export function ordersAtOrBefore(key: MailThreadOrderKey, boundary: MailThreadOrderKey): boolean {
  return key.at > boundary.at || (key.at === boundary.at && key.id >= boundary.id);
}
