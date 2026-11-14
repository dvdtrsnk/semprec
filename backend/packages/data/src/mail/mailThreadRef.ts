// The `mailThread` Semp message ref (issue gh-1933): a thread is named by its public thread id, which a merge can
// leave only as an alias (issue gh-1493), never by the id of its Threads item. This file owns the reads that turn
// such an id into the current thread id, its label and its state; the callers are the ref validation, the history
// resolver and the expansion of a ref for the agent (`semp/`).
import type { PoolClient } from "pg";

/** The thread a ref names after the aliases, with what a history entry and an agent turn show of it. */
export interface MailThreadRefTarget {
  /** The thread the ref leads to now: the id itself, or the thread that absorbed it in a merge. */
  currentThreadId: string;
  /**
   * The subject of the thread's latest live message (the activity order of the thread list, latest first, then the
   * higher item id); the thread's subject hint when it has no live message, `null` when it has neither.
   */
  label: string | null;
  /**
   * `trashed` when every live message copy of the thread is in the Trash folder, or when no live copy is left; `active`
   * otherwise. A thread id that names no thread has no target at all.
   */
  state: "active" | "trashed";
}

/**
 * The thread ids `$1` lead to, in order, with the alias of a merged-away id replaced by the thread that absorbed it
 * (aliases are always one step, see `reassignThread`): one row per input id, `thread_id` NULL for an id that is
 * neither a live thread nor an alias. Fixed SQL; `$1` is a uuid array.
 */
const WANTED_THREADS_SQL = `SELECT r.ordinal::int AS ordinal, COALESCE(a.to_thread_id, t.id) AS thread_id
  FROM unnest($1::uuid[]) WITH ORDINALITY AS r(id, ordinal)
  LEFT JOIN mail_thread_aliases a ON a.tenant_id = app_tenant_default() AND a.from_thread_id = r.id
  LEFT JOIN mail_threads t ON t.tenant_id = app_tenant_default() AND t.id = r.id`;

/**
 * The current thread id of each of `threadIds`, in order, through the aliases of a merge, in one statement: `null` for
 * an id that is neither a live thread of the tenant nor an alias of one. A Threads item id is not a thread id and
 * resolves to `null`.
 */
export async function resolveMailThreadRefIds(
  client: PoolClient,
  threadIds: readonly string[],
): Promise<Array<string | null>> {
  const { rows } = await client.query<{ ordinal: number; thread_id: string | null }>(
    `${WANTED_THREADS_SQL} ORDER BY r.ordinal`,
    [threadIds],
  );
  if (rows.length !== threadIds.length) throw new Error("Invalid mail thread reference resolution result");
  return rows.map((row) => row.thread_id);
}

/**
 * The target of each of `threadIds`, in order, in one statement whatever the number of ids: `null` for an id that is
 * neither a live thread of the tenant nor an alias of one (a purged thread). A message copy is in Trash when it has
 * live folders and every one of them is a Trash folder; the subject is read from the same live copies the thread
 * detail reads (drafts included).
 */
export async function resolveMailThreadRefTargets(
  client: PoolClient,
  threadIds: readonly string[],
): Promise<Array<MailThreadRefTarget | null>> {
  const { rows } = await client.query<{
    ordinal: number;
    thread_id: string | null;
    subject: string | null;
    live_copies: number;
    all_in_trash: boolean | null;
  }>(
    `WITH wanted AS (${WANTED_THREADS_SQL}), schema_ids AS (
  SELECT (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'emails') AS emails,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'folders') AS folders
), folder_definition AS (
  SELECT rd.id, rd.property_id_a = p.id AS email_is_a
  FROM properties p JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.tenant_id = app_tenant_default() AND p.database_id = (SELECT emails FROM schema_ids) AND p.key = 'folder'
), live AS (
  SELECT m.thread_id, m.item_id, COALESCE(i.properties->>'name', '') AS subject,
    COALESCE(NULLIF(i.properties->>'date', '')::timestamptz, m.ingested_at, i.updated_at) AS activity,
    COALESCE(f.all_trash, false) AS in_trash
  FROM mail_message_meta m
  JOIN items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id AND i.database_id = (SELECT emails FROM schema_ids)
  LEFT JOIN LATERAL (
    SELECT bool_and(COALESCE(folder.properties->>'specialPurpose' = 'trash', false)) AS all_trash
    FROM folder_definition fd JOIN item_relations r ON r.tenant_id = m.tenant_id AND r.relation_definition_id = fd.id
      AND (CASE WHEN fd.email_is_a THEN r.item_a ELSE r.item_b END) = i.id
    JOIN items folder ON folder.tenant_id = m.tenant_id AND folder.database_id = (SELECT folders FROM schema_ids)
      AND folder.id = CASE WHEN fd.email_is_a THEN r.item_b ELSE r.item_a END AND folder.deleted_at IS NULL
  ) f ON true
  WHERE m.tenant_id = app_tenant_default() AND i.deleted_at IS NULL
    AND m.thread_id IN (SELECT thread_id FROM wanted WHERE thread_id IS NOT NULL)
)
SELECT w.ordinal, w.thread_id, COALESCE(s.subject, t.subject_hint) AS subject, COALESCE(s.live_copies, 0) AS live_copies,
  s.all_in_trash
FROM wanted w
LEFT JOIN mail_threads t ON t.tenant_id = app_tenant_default() AND t.id = w.thread_id
LEFT JOIN LATERAL (
  SELECT count(*)::int AS live_copies, bool_and(l.in_trash) AS all_in_trash,
    (array_agg(l.subject ORDER BY l.activity DESC NULLS LAST, l.item_id DESC))[1] AS subject
  FROM live l WHERE l.thread_id = w.thread_id
) s ON true
ORDER BY w.ordinal`,
    [threadIds],
  );
  if (rows.length !== threadIds.length) throw new Error("Invalid mail thread reference resolution result");
  return rows.map((row) =>
    row.thread_id === null
      ? null
      : {
          currentThreadId: row.thread_id,
          label: row.subject,
          state: row.live_copies === 0 || row.all_in_trash === true ? "trashed" : "active",
        },
  );
}
