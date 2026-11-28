import { buildItemSearchQuery } from "../search/itemSearchQuery.js";
import type { ParsedMailSearchQuery } from "./search.js";

export interface MailThreadFilters {
  /** `all` is the mail search's: any thread with a copy outside Junk and Trash, as global search counts. */
  box: "inbox" | "flagged" | "sempDrafts" | "all";
  folderId: string | null;
  unread: boolean;
  mailboxId: string | null;
  search?: ParsedMailSearchQuery;
}

type FolderIdSql = `$${number}::uuid`;

const threadInFolder = (folderId: FolderIdSql) =>
  `l.thread_id IN (SELECT c.thread_id FROM copies c WHERE ${folderId} = ANY(c.folder_ids))`;

type ThreadIdSql = "l.thread_id" | "p.thread_id";

/**
 * Whether the thread has an unsent agent-created draft whose Emails item is live. A merge leaves
 * `mail_drafts.thread_id` unchanged and records a one-step alias, so the draft is matched by the
 * thread's own id or by the id of a thread merged into it.
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

export const mailThreadPredicates = {
  inbox: "l.thread_id IN (SELECT c.thread_id FROM copies c WHERE c.has_inbox)",
  flagged: "l.thread_id IN (SELECT c.thread_id FROM copies c WHERE c.flagged AND c.has_non_junk)",
  all: "l.thread_id IN (SELECT c.thread_id FROM copies c WHERE c.has_non_junk)",
  /** Like `flagged`, needs a counted message outside Junk and Trash. */
  sempDrafts: `(${mailThreadHasSempDraft("l.thread_id")}
    AND l.thread_id IN (SELECT c.thread_id FROM copies c WHERE c.has_non_junk))`,
  inFolder: (parameter: number) => threadInFolder(`$${parameter}::uuid`),
  unread: "cs.unread",
  inMailbox: (parameter: number) =>
    `l.thread_id IN (SELECT c.thread_id FROM copies c WHERE c.mailbox_item_id = $${parameter}::uuid)`,
} as const;

/** With `messageItemIds`, the satisfying message must also be one of those Emails items. */
export function matchesSearch(
  query: ParsedMailSearchQuery,
  firstParameter: number,
  messageItemIds?: readonly string[],
) {
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${firstParameter + params.length - 1}`;
  };
  const conditions = ["c.thread_id = l.thread_id"];
  if (messageItemIds !== undefined) conditions.push(`c.item_id = ANY(${bind([...messageItemIds])}::uuid[])`);
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
