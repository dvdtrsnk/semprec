import { buildItemSearchQuery } from "../search/itemSearchQuery.js";
import type { ParsedMailSearchQuery } from "./search.js";

export interface MailThreadFilters {
  box: "inbox" | "flagged";
  folderId: string | null;
  unread: boolean;
  mailboxId: string | null;
  search?: ParsedMailSearchQuery;
}

// These fragments use only fixed SQL and refer to the list query's copy aggregate.
export const mailThreadPredicates = {
  inbox: "EXISTS (SELECT 1 FROM copies c WHERE c.thread_id = l.thread_id AND c.has_inbox)",
  flagged: "EXISTS (SELECT 1 FROM copies c WHERE c.thread_id = l.thread_id AND c.flagged AND c.has_non_junk)",
  inFolder: (parameter: number) =>
    `EXISTS (SELECT 1 FROM copies c WHERE c.thread_id = l.thread_id AND $${parameter}::uuid = ANY(c.folder_ids))`,
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
