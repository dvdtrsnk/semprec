import { buildItemSearchQuery } from "../search/itemSearchQuery.js";
import type { ParsedMailSearchQuery } from "./search.js";

export interface MailThreadFilters {
  box: "inbox" | "flagged" | "sempDrafts";
  folderId: string | null;
  unread: boolean;
  mailboxId: string | null;
  search?: ParsedMailSearchQuery;
}

/**
 * The folder a thread must have a copy in, as SQL: a bind parameter of the list, or the id of a
 * `mailbox_folders` row of the per-folder counts (`mailFolderList.ts`). The type admits no other text.
 */
type FolderIdSql = `$${number}::uuid` | "mf.id";

const threadInFolder = (folderId: FolderIdSql) =>
  `EXISTS (SELECT 1 FROM copies c WHERE c.thread_id = l.thread_id AND ${folderId} = ANY(c.folder_ids))`;

/**
 * The thread a Semp draft is looked up for, as SQL: the `thread_id` of the row `l` the predicates
 * expect, or of a row `p` of the list's page. The type admits no other text.
 */
type ThreadIdSql = "l.thread_id" | "p.thread_id";

/**
 * Whether the thread has a Semp draft (issue gh-1694): a `mail_drafts` row of that thread which the
 * agent created (`created_by`) and which is unsent (`sent_at`), and whose item is a live item of the
 * Emails database. A draft of the user, a sent draft and a draft whose item is deleted do not count.
 *
 * A draft is a draft of the thread its `thread_id` names and, once that thread is merged away, of the
 * thread that absorbed it: `reassignThread` leaves `mail_drafts.thread_id` as it was and records the
 * merge in `mail_thread_aliases` (issue gh-1493). An alias is always one step, so the draft is matched
 * by the thread's own id or by the id of a thread merged into it.
 *
 * The text is fixed SQL around `threadId` and reads the query's `schema_ids`.
 */
export const mailThreadHasSempDraft = (threadId: ThreadIdSql) =>
  `EXISTS (SELECT 1 FROM mail_drafts d
    JOIN items draft ON draft.tenant_id = d.tenant_id AND draft.id = d.email_item_id
      AND draft.database_id = (SELECT emails FROM schema_ids) AND draft.deleted_at IS NULL
    WHERE d.tenant_id = app_tenant_default()
      AND d.thread_id IN (
        SELECT ${threadId}
        UNION ALL
        SELECT a.from_thread_id FROM mail_thread_aliases a
        WHERE a.tenant_id = app_tenant_default() AND a.to_thread_id = ${threadId})
      AND d.created_by = 'agent' AND d.sent_at IS NULL)`;

// These fragments use only fixed SQL and refer to the list query's copy aggregate.
export const mailThreadPredicates = {
  inbox: "EXISTS (SELECT 1 FROM copies c WHERE c.thread_id = l.thread_id AND c.has_inbox)",
  flagged: "EXISTS (SELECT 1 FROM copies c WHERE c.thread_id = l.thread_id AND c.flagged AND c.has_non_junk)",
  /**
   * The box of the threads that have a Semp draft. Like `flagged` it needs a counted message outside
   * Junk and Trash, so a thread whose messages are all there stays out of the box and of its count
   * (issue gh-1633: the list shows such a thread only for a `folderId`).
   */
  sempDrafts: `(${mailThreadHasSempDraft("l.thread_id")}
    AND EXISTS (SELECT 1 FROM copies c WHERE c.thread_id = l.thread_id AND c.has_non_junk))`,
  inFolder: (parameter: number) => threadInFolder(`$${parameter}::uuid`),
  /** `inFolder` for the folder row `mf` of a query that counts per folder, instead of for one bound folder id. */
  inFolderRow: threadInFolder("mf.id"),
  unread: "cs.unread",
  inMailbox: (parameter: number) =>
    `EXISTS (SELECT 1 FROM copies c WHERE c.thread_id = l.thread_id AND c.mailbox_item_id = $${parameter}::uuid)`,
} as const;

export function matchesSearch(query: ParsedMailSearchQuery, firstParameter: number) {
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${firstParameter + params.length - 1}`;
  };
  const conditions = ["c.thread_id = l.thread_id"];
  if (query.contradictory) conditions.push("false");
  if (query.freeText) {
    const built = buildItemSearchQuery(query.freeText, firstParameter + params.length);
    params.push(...built.params);
    conditions.push(
      `EXISTS (SELECT 1 FROM item_search_index s WHERE s.tenant_id = app_tenant_default() AND s.database_id = (SELECT emails FROM schema_ids) AND s.item_id = c.item_id AND s.search_vector @@ ${built.sql})`,
    );
  }
  if (query.from) {
    const value = bind(query.from);
    conditions.push(
      `(strpos(unaccent(lower(COALESCE(c.envelope->'from'->>'name', ''))), unaccent(lower(${value}::text))) > 0 OR strpos(unaccent(lower(COALESCE(c.envelope->'from'->>'address', ''))), unaccent(lower(${value}::text))) > 0)`,
    );
  }
  if (query.hasAttachment) conditions.push("c.attached");
  if (query.before) conditions.push(`c.message_date < ${bind(query.before)}::timestamptz`);
  if (query.after) conditions.push(`c.message_date > ${bind(query.after)}::timestamptz`);
  if (query.read !== undefined) {
    conditions.push(`c.is_read = ${bind(query.read)}::boolean`);
    if (!query.read) conditions.push("NOT c.excluded_from_unread");
  }
  if (query.flagged !== undefined) conditions.push(`c.flagged = ${bind(query.flagged)}::boolean`);
  return { sql: `EXISTS (SELECT 1 FROM search_messages c WHERE ${conditions.join(" AND ")})`, params };
}
