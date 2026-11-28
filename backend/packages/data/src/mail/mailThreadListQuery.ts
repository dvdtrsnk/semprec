import type { PoolClient } from "pg";
import { z } from "zod";
import { getValueLinksForItems, type ValueLinkEntry } from "../chokePoint/valueLinkReads.js";
import { NotFoundError, ValidationError } from "../errors.js";
import {
  mailThreadHasSempDraft,
  mailThreadPredicates,
  matchesSearch,
  type MailThreadFilters,
} from "./mailThreadPredicates.js";
import type { ParsedMailSearchQuery } from "./search.js";
import { listMailThreadCandidates, ordersAtOrBefore, type MailThreadCandidates } from "./mailThreadCandidates.js";

const address = z.object({ name: z.string(), address: z.string() });
const namedItem = z.object({ id: z.uuid(), name: z.string() });
const thread = z.object({
  threadId: z.uuid(),
  subject: z.string(),
  lastMessageAt: z.string(),
  lastSender: address.extend({ personId: z.uuid().nullable() }),
  participants: z.array(address),
  messageCount: z.number().int(),
  preview: z.string().nullable(),
  hasAttachment: z.boolean(),
  unread: z.boolean(),
  flagged: z.boolean(),
  mailboxes: z.array(z.object({ id: z.uuid(), name: z.string(), provider: z.string().nullable() })),
  senderPerson: z.object({ id: z.uuid(), name: z.string(), relationship: z.string().nullable() }).nullable(),
  project: namedItem.nullable(),
  company: namedItem.nullable(),
  hasSempDraft: z.boolean(),
});

/** The tenant's live mailbox addresses, lowercased: a message from one of them is the user's own. */
export const MAIL_OWN_ADDRESSES_SQL = `
  SELECT DISTINCT lower(btrim(a.address, E' \\t\\n\\r')) AS address
  FROM items i CROSS JOIN LATERAL regexp_split_to_table(
    CASE WHEN jsonb_typeof(i.properties->'addresses') = 'string' THEN i.properties->>'addresses' ELSE '' END,
    E'[,\\n\\r]+') a(address)
  WHERE i.tenant_id = app_tenant_default() AND i.database_id = (SELECT mailboxes FROM schema_ids)
    AND i.deleted_at IS NULL AND btrim(a.address, E' \\t\\n\\r') <> ''
`;

/**
 * The CTEs the thread list and the mail summary share, so a count reads the same copies the list
 * shows. Drafts are left out unless the bind parameter numbered `threadIdParameter` names one thread.
 * `unreadCandidatesOnly` keeps only the threads with a live copy that is not read: every thread whose `copy_stats`
 * says `unread` is among them, and each kept thread still has all of its copies, so an unread count is unchanged.
 * `threadIdsParameter` numbers a `uuid[]` bind parameter that, when not null, keeps only the copies of those threads,
 * each thread with all of its copies.
 */
export function mailThreadCopyCtes(
  threadIdParameter: number,
  options: { unreadCandidatesOnly?: boolean; threadIdsParameter?: number } = {},
): string {
  const threadId = `$${threadIdParameter}`;
  const threadIds = options.threadIdsParameter === undefined ? null : `$${options.threadIdsParameter}::uuid[]`;
  const threadIdsFilter =
    threadIds === null ? "" : `\n    AND (${threadIds} IS NULL OR m.thread_id = ANY(${threadIds}))`;
  const threadIdsEdgeFilter =
    threadIds === null
      ? ""
      : `\n      AND (${threadIds} IS NULL OR (CASE WHEN fd.email_is_a THEN r.item_a ELSE r.item_b END) IN (
        SELECT t.item_id FROM mail_message_meta t WHERE t.tenant_id = app_tenant_default() AND t.thread_id = ANY(${threadIds})))`;
  const unreadCandidates = options.unreadCandidatesOnly
    ? `unread_candidates AS (
  SELECT DISTINCT m.thread_id FROM mail_message_meta m
  JOIN items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id AND i.database_id = (SELECT emails FROM schema_ids)
  WHERE m.tenant_id = app_tenant_default() AND m.thread_id IS NOT NULL AND i.deleted_at IS NULL
    AND NOT COALESCE(i.properties->'read' = 'true'::jsonb, false)
), `
    : "";
  const candidateFilter = options.unreadCandidatesOnly
    ? "\n    AND m.thread_id IN (SELECT thread_id FROM unread_candidates)"
    : "";
  const candidateEdgeFilter = options.unreadCandidatesOnly
    ? `\n      AND (CASE WHEN fd.email_is_a THEN r.item_a ELSE r.item_b END) IN (SELECT t.item_id FROM mail_message_meta t
        WHERE t.tenant_id = app_tenant_default() AND t.thread_id IN (SELECT thread_id FROM unread_candidates))`
    : "";
  return `schema_ids AS (
  SELECT (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'emails') AS emails,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'folders') AS folders,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'mailboxes') AS mailboxes,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'people') AS people,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'threads') AS threads,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'projects') AS projects
), folder_definition AS (
  SELECT rd.id, rd.property_id_a = p.id AS email_is_a
  FROM properties p JOIN relation_definitions rd ON p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.database_id = (SELECT emails FROM schema_ids) AND p.key = 'folder'
), own_addresses AS (${MAIL_OWN_ADDRESSES_SQL}), ${unreadCandidates}copies AS (
  SELECT m.thread_id, m.item_id, m.message_id, m.mailbox_item_id, m.envelope, m.preview_text,
    pr.date AS message_date,
    COALESCE(pr.date, m.ingested_at, i.updated_at) AS activity,
    COALESCE(pr.name, '') AS subject,
    COALESCE(pr.read = 'true'::jsonb, false) AS is_read,
    COALESCE(pr.flagged = 'true'::jsonb, false) AS flagged,
    EXISTS (SELECT 1 FROM mail_attachments a WHERE a.tenant_id = m.tenant_id AND a.message_item_id = m.item_id) AS attached,
    EXISTS (SELECT 1 FROM own_addresses o WHERE o.address = lower(btrim(m.envelope->'from'->>'address', E' \\t\\n\\r'))) AS own,
    COALESCE(f.has_sent, false) AS has_sent,
    -- Received: delivered to an Inbox or Junk folder, a copy of its own beside a Sent copy that carries a UID (an IMAP
    -- server keeps a self-addressed message twice), or from no address of the tenant and in no Sent folder. Mail to
    -- oneself is therefore received although its sender is the tenant's; only its Sent copy is the user's own.
    COALESCE(f.delivered, false) OR (NOT COALESCE(f.has_sent, false) AND NOT EXISTS (
      SELECT 1 FROM own_addresses o WHERE o.address = lower(btrim(m.envelope->'from'->>'address', E' \\t\\n\\r'))
    )) AS received,
    COALESCE(f.has_inbox, false) AS has_inbox, COALESCE(f.has_non_junk, true) AS has_non_junk,
    COALESCE(f.folder_ids, ARRAY[]::uuid[]) AS folder_ids
  FROM mail_message_meta m
  JOIN items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id AND i.database_id = (SELECT emails FROM schema_ids)
  -- The properties read in one pass: each -> or ->> on a compressed jsonb decompresses it again, which across every
  -- message of the tenant cost as much as the rest of the list.
  CROSS JOIN LATERAL (
    SELECT NULLIF(p.date, '')::timestamptz AS date, p.name, p.read, p.flagged
    FROM jsonb_to_record(i.properties) AS p(date text, name text, read jsonb, flagged jsonb)
  ) pr
  -- One aggregate per email over every folder edge, hash-joined; per-email lookups cost a loop per copy.
  LEFT JOIN (
    SELECT CASE WHEN fd.email_is_a THEN r.item_a ELSE r.item_b END AS email_id,
      count(*) AS n, bool_and(COALESCE(folder.properties->>'specialPurpose' = 'drafts', false)) AS only_drafts,
      bool_or(COALESCE(folder.properties->>'specialPurpose' = 'sent', false)) AS has_sent,
      bool_or(COALESCE(folder.properties->>'specialPurpose' = 'inbox', false)) AS has_inbox,
      bool_or(COALESCE(folder.properties->>'specialPurpose' IN ('inbox', 'junk'), false))
        OR (bool_or(COALESCE(folder.properties->>'specialPurpose' = 'sent', false) AND r.metadata ? 'uid')
          AND bool_or(COALESCE(folder.properties->>'specialPurpose' NOT IN ('sent', 'drafts'), true))) AS delivered,
      bool_or(COALESCE(folder.properties->>'specialPurpose' NOT IN ('junk', 'trash'), true)) AS has_non_junk,
      array_agg(folder.id) AS folder_ids
    FROM folder_definition fd JOIN item_relations r ON r.relation_definition_id = fd.id AND r.tenant_id = app_tenant_default()
    JOIN items folder ON folder.tenant_id = r.tenant_id AND folder.database_id = (SELECT folders FROM schema_ids)
      AND folder.id = CASE WHEN fd.email_is_a THEN r.item_b ELSE r.item_a END AND folder.deleted_at IS NULL
    WHERE (${threadId}::uuid IS NULL OR (CASE WHEN fd.email_is_a THEN r.item_a ELSE r.item_b END) IN (
      SELECT t.item_id FROM mail_message_meta t WHERE t.tenant_id = app_tenant_default() AND t.thread_id = ${threadId}::uuid))${candidateEdgeFilter}${threadIdsEdgeFilter}
    GROUP BY 1
  ) f ON f.email_id = i.id
  WHERE m.tenant_id = app_tenant_default() AND m.thread_id IS NOT NULL AND i.deleted_at IS NULL
    AND (${threadId}::uuid IS NULL OR m.thread_id = ${threadId}::uuid)${candidateFilter}${threadIdsFilter}
    -- The list leaves drafts out; the detail-only mode (${threadId}) aggregates every live copy, drafts included.
    AND (${threadId}::uuid IS NOT NULL OR (NOT (f.n > 0 AND COALESCE(f.only_drafts, false))
      AND NOT EXISTS (SELECT 1 FROM mail_drafts d WHERE d.tenant_id = m.tenant_id AND d.email_item_id = i.id AND d.sent_at IS NULL)))
), copy_stats AS (
  SELECT thread_id, bool_or(attached) AS has_attachment, bool_or(flagged) AS flagged,
    bool_or(received AND NOT is_read) AS unread
  FROM copies GROUP BY thread_id
), thread_subject AS (
  -- The conversation's subject is its earliest message's, so a reply or a bounce threaded later does not rename it.
  SELECT DISTINCT ON (thread_id) thread_id, subject
  FROM copies ORDER BY thread_id, activity ASC NULLS LAST, item_id ASC
)`;
}

/** The `search_messages` CTE the `matchesSearch` fragments read; needs `mailThreadCopyCtes` in scope. */
export const MAIL_SEARCH_MESSAGES_CTE = `search_messages AS (
  SELECT m.thread_id, m.item_id, m.envelope,
    NULLIF(i.properties->>'date', '')::timestamptz AS message_date,
    COALESCE(i.properties->'read' = 'true'::jsonb, false) AS is_read,
    COALESCE(i.properties->'flagged' = 'true'::jsonb, false) AS flagged,
    EXISTS (SELECT 1 FROM mail_attachments a WHERE a.tenant_id = m.tenant_id AND a.message_item_id = m.item_id) AS attached,
    EXISTS (SELECT 1 FROM folder_definition fd JOIN item_relations r ON r.tenant_id = m.tenant_id AND r.relation_definition_id = fd.id
      -- The OR lets the item_a and item_b indexes find the edges; the CASE keeps the email's own side.
      AND (r.item_a = i.id OR r.item_b = i.id)
      AND (CASE WHEN fd.email_is_a THEN r.item_a ELSE r.item_b END) = i.id
      JOIN items f ON f.tenant_id = m.tenant_id AND f.database_id = (SELECT folders FROM schema_ids)
        AND f.id = CASE WHEN fd.email_is_a THEN r.item_b ELSE r.item_a END AND f.deleted_at IS NULL
      WHERE f.properties->>'specialPurpose' IN ('drafts', 'sent')) AS excluded_from_unread
  FROM mail_message_meta m JOIN items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id
    AND i.database_id = (SELECT emails FROM schema_ids)
  WHERE m.tenant_id = app_tenant_default() AND m.thread_id IS NOT NULL AND i.deleted_at IS NULL
)`;

export interface MailThreadLinks {
  company?: ValueLinkEntry;
  project?: ValueLinkEntry;
}

const THREAD_LINK_KEYS = ["company", "project"] as const;

/**
 * Names the one live item the thread's `propertyKey` edge reaches, or no row (`null`) when there is
 * no edge or the item is in the Trash. Both arguments are literal unions, never input, which is why
 * they are interpolated. With several edges the lowest item id wins.
 */
function threadRelationNameJoin(propertyKey: "project" | "company", ownerModuleId: "projects" | "companies"): string {
  return `LEFT JOIN LATERAL (
  SELECT jsonb_build_object('id', target.id, 'name', COALESCE(target.properties->>'name', '')) AS value
  FROM mail_threads t
  JOIN properties tp ON tp.tenant_id = t.tenant_id AND tp.database_id = (SELECT threads FROM schema_ids) AND tp.key = '${propertyKey}'
  JOIN relation_definitions rd ON rd.tenant_id = t.tenant_id AND tp.id IN (rd.property_id_a, rd.property_id_b)
  JOIN item_relations r ON r.tenant_id = t.tenant_id AND r.relation_definition_id = rd.id
    AND (CASE WHEN rd.property_id_a = tp.id THEN r.item_a ELSE r.item_b END) = t.item_id
  JOIN items target ON target.tenant_id = t.tenant_id
    AND target.database_id = (SELECT d.id FROM databases d WHERE d.tenant_id = app_tenant_default() AND d.system AND d.owner_module_id = '${ownerModuleId}')
    AND target.id = CASE WHEN rd.property_id_a = tp.id THEN r.item_b ELSE r.item_a END AND target.deleted_at IS NULL
  WHERE t.tenant_id = app_tenant_default() AND t.id = p.thread_id
  ORDER BY target.id LIMIT 1
) ${propertyKey}_name ON true`;
}

const cursorSchema = z.object({ at: z.iso.datetime({ precision: 6 }), id: z.uuid() }).strict();

/** Decodes the base64url JSON `nextCursor`; throws a `ValidationError` naming `cursor` when malformed. */
export function parseMailThreadListCursor(rawCursor: string): { at: string; id: string } {
  if (rawCursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(rawCursor))
    throw new ValidationError("Invalid cursor", { field: "cursor" });
  let decoded: unknown;
  try {
    const bytes = Buffer.from(rawCursor, "base64url");
    if (bytes.toString("base64url") !== rawCursor) throw new Error("Invalid encoding");
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ValidationError("Invalid cursor", { field: "cursor" });
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success) throw new ValidationError("Invalid cursor", { field: "cursor" });
  return parsed.data;
}

/** Rejects operands that are not ISO dates or offset date-times, which Postgres would misread or refuse. */
export function hasInvalidMailSearchDate(search: ParsedMailSearchQuery): boolean {
  return [search.before, search.after].some(
    (date) =>
      date !== undefined &&
      !z.iso.date().safeParse(date).success &&
      !z.iso.datetime({ offset: true }).safeParse(date).success,
  );
}

/**
 * The Inbox and folder lists read a window of candidate threads (`listMailThreadCandidates`) instead of every message
 * of the tenant: the page computed over the window is final up to the window's boundary, and a page that reaches past
 * it is computed again over a window four times larger. Every other list reads every message.
 */
async function listPage<Row extends { thread: unknown; activity_key: string }>(
  limit: number,
  filters: {
    box: string;
    folderId: string | null;
    threadId?: string | null;
    threadIds?: readonly string[] | null;
    changedThreadIds?: readonly string[] | null;
  },
  queryPage: (window: readonly string[] | null) => Promise<{ rows: Row[] }>,
  candidates: (size: number) => Promise<MailThreadCandidates>,
): Promise<Row[]> {
  const windowed =
    (filters.box === "inbox" || filters.folderId !== null) &&
    !filters.threadId &&
    !filters.threadIds &&
    !filters.changedThreadIds;
  if (!windowed) return (await queryPage(null)).rows;
  for (let size = 4 * (limit + 1); ; size *= 4) {
    const window = await candidates(size);
    const { rows } = await queryPage(window.threadIds);
    const { boundary } = window;
    if (boundary === null) return rows;
    const final = rows.filter((row) =>
      ordersAtOrBefore({ at: row.activity_key, id: thread.parse(row.thread).threadId }, boundary),
    );
    if (final.length === limit + 1) return final;
  }
}

export async function listMailThreads(
  client: PoolClient,
  limit: number,
  cursor: { at: string; id: string } | null,
  filters: MailThreadFilters & {
    projectId?: string | null;
    personId?: string | null;
    /** Detail-only mode: one thread in any box or folder, drafts included. The list never sets it. */
    threadId?: string | null;
    /** Only these threads, in any box or folder. */
    threadIds?: readonly string[] | null;
    /** Only these threads, each still in the box, folder and other filters above. */
    changedThreadIds?: readonly string[] | null;
    /** With `search`: the message satisfying it must be one of these Emails items. */
    searchMessageItemIds?: readonly string[];
  } = {
    box: "inbox",
    folderId: null,
    unread: false,
    mailboxId: null,
  },
) {
  if (filters.folderId) {
    const folder = await client.query<{ id: string }>(
      `SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
       WHERE i.tenant_id = app_tenant_default() AND d.system AND d.owner_module_id = 'folders'
         AND i.id = $1 AND i.deleted_at IS NULL`,
      [filters.folderId],
    );
    if (!folder.rows.length) throw new NotFoundError("Folder not found");
  }
  const predicates: string[] = [
    `($4::uuid IS NOT NULL OR $8::uuid IS NOT NULL OR $9::uuid[] IS NOT NULL OR ${mailThreadPredicates[filters.box]})`,
    `($8::uuid IS NULL OR l.thread_id = $8::uuid)`,
    `($9::uuid[] IS NULL OR l.thread_id = ANY($9::uuid[]))`,
    `($10::uuid[] IS NULL OR l.thread_id = ANY($10::uuid[]))`,
    `($4::uuid IS NULL OR ${mailThreadPredicates.inFolder(4)})`,
    `($5::uuid IS NULL OR ${mailThreadPredicates.inMailbox(5)})`,
  ];
  if (filters.unread) predicates.push(mailThreadPredicates.unread);
  predicates.push(
    `($6::uuid IS NULL OR EXISTS (SELECT 1 FROM thread_project tp WHERE tp.thread_id = l.thread_id AND tp.project_id = $6))`,
  );
  predicates.push(
    `($7::uuid IS NULL OR EXISTS (SELECT 1 FROM message_person mp WHERE mp.thread_id = l.thread_id AND mp.person_id = $7))`,
  );
  const search = filters.search ? matchesSearch(filters.search, 11, filters.searchMessageItemIds) : null;
  if (search) predicates.push(search.sql);
  const queryPage = (window: readonly string[] | null) =>
    client.query<{ thread: unknown; thread_item_id: string | null; activity_key: string }>(
      `
WITH ${mailThreadCopyCtes(8, { threadIdsParameter: 10 })}, thread_project AS (
  SELECT t.id AS thread_id, project.id AS project_id
  FROM mail_threads t
  JOIN properties p ON p.tenant_id = t.tenant_id AND p.database_id = (SELECT threads FROM schema_ids) AND p.key = 'project'
  JOIN relation_definitions rd ON rd.tenant_id = t.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  JOIN item_relations r ON r.tenant_id = t.tenant_id AND r.relation_definition_id = rd.id
    AND (CASE WHEN rd.property_id_a = p.id THEN r.item_a ELSE r.item_b END) = t.item_id
  CROSS JOIN LATERAL (SELECT i.id FROM items i WHERE i.tenant_id = t.tenant_id AND i.database_id = (SELECT projects FROM schema_ids)
    AND i.id = CASE WHEN rd.property_id_a = p.id THEN r.item_b ELSE r.item_a END OFFSET 0) project
  WHERE t.tenant_id = app_tenant_default()
), message_person AS (
  SELECT m.thread_id, person.id AS person_id
  FROM mail_message_meta m
  CROSS JOIN LATERAL (SELECT i.id FROM items i WHERE i.tenant_id = m.tenant_id AND i.database_id = (SELECT emails FROM schema_ids) AND i.id = m.item_id AND i.deleted_at IS NULL OFFSET 0) email
  JOIN properties p ON p.tenant_id = m.tenant_id AND p.database_id = (SELECT emails FROM schema_ids) AND p.key IN ('senderPeople', 'recipientsPeople')
  JOIN relation_definitions rd ON rd.tenant_id = m.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  JOIN item_relations r ON r.tenant_id = m.tenant_id AND r.relation_definition_id = rd.id
    AND (CASE WHEN rd.property_id_a = p.id THEN r.item_a ELSE r.item_b END) = email.id
  CROSS JOIN LATERAL (SELECT i.id FROM items i WHERE i.tenant_id = m.tenant_id AND i.database_id = (SELECT people FROM schema_ids)
    AND i.id = CASE WHEN rd.property_id_a = p.id THEN r.item_b ELSE r.item_a END OFFSET 0) person
  WHERE m.tenant_id = app_tenant_default()
), ${MAIL_SEARCH_MESSAGES_CTE}, dedup AS (
  SELECT DISTINCT ON (thread_id, message_id) thread_id, message_id, item_id, activity, subject, envelope, preview_text
  FROM copies ORDER BY thread_id, message_id, activity DESC NULLS LAST, item_id DESC
), thread_stats AS (
  SELECT thread_id, count(*)::int AS message_count FROM dedup GROUP BY thread_id
), latest AS (
  SELECT DISTINCT ON (thread_id) * FROM dedup ORDER BY thread_id, activity DESC NULLS LAST, item_id DESC
), page AS (
  SELECT l.*, s.message_count, cs.has_attachment, cs.flagged, cs.unread
  FROM latest l JOIN thread_stats s USING (thread_id) JOIN copy_stats cs USING (thread_id)
  WHERE ${predicates.join(" AND ")}
    AND ($1::timestamptz IS NULL OR (l.activity, l.thread_id) < ($1::timestamptz, $2::uuid))
  ORDER BY l.activity DESC NULLS LAST, l.thread_id DESC LIMIT $3
), page_copies AS MATERIALIZED (
  -- The page's threads' rows, read once: a CTE has no index, so a lookup per thread scanned every message.
  SELECT c.thread_id, c.mailbox_item_id FROM copies c WHERE c.thread_id IN (SELECT thread_id FROM page)
), page_dedup AS MATERIALIZED (
  SELECT d.* FROM dedup d WHERE d.thread_id IN (SELECT thread_id FROM page)
)
SELECT jsonb_build_object(
  'threadId', p.thread_id, 'subject', ts.subject,
  'lastMessageAt', to_char(p.activity AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'lastSender', jsonb_build_object('name', COALESCE(p.envelope->'from'->>'name', ''), 'address', COALESCE(p.envelope->'from'->>'address', ''), 'personId', person.id),
  'participants', COALESCE(parts.value, '[]'::jsonb), 'messageCount', p.message_count,
  'preview', p.preview_text, 'hasAttachment', p.has_attachment, 'unread', p.unread, 'flagged', p.flagged,
  'mailboxes', COALESCE(boxes.value, '[]'::jsonb),
  'senderPerson', CASE WHEN person.id IS NULL THEN NULL ELSE jsonb_build_object('id', person.id, 'name', COALESCE(person.properties->>'name', ''), 'relationship', person.properties->>'relationship') END,
  'project', project_name.value, 'company', company_name.value, 'hasSempDraft', ${mailThreadHasSempDraft("p.thread_id")}
) AS thread,
  (SELECT mt.item_id FROM mail_threads mt WHERE mt.tenant_id = app_tenant_default() AND mt.id = p.thread_id) AS thread_item_id,
  to_char(p.activity AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS activity_key
FROM page p
JOIN thread_subject ts ON ts.thread_id = p.thread_id
${threadRelationNameJoin("project", "projects")}
${threadRelationNameJoin("company", "companies")}
LEFT JOIN person_email_index pei ON pei.tenant_id = app_tenant_default() AND pei.email = lower(btrim(p.envelope->'from'->>'address', E' \\t\\n\\r'))
LEFT JOIN items person ON person.tenant_id = app_tenant_default() AND person.database_id = (SELECT people FROM schema_ids) AND person.id = pei.item_id AND person.deleted_at IS NULL
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('id', box.id, 'name', COALESCE(box.properties->>'name', ''), 'provider', box.properties->>'provider') ORDER BY box.id) AS value
  FROM items box WHERE box.tenant_id = app_tenant_default() AND box.database_id = (SELECT mailboxes FROM schema_ids) AND box.deleted_at IS NULL
    AND box.id IN (SELECT mailbox_item_id FROM page_copies c WHERE c.thread_id = p.thread_id)
) boxes ON true
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('name', x.name, 'address', x.address) ORDER BY x.activity, x.item_id, x.position) AS value
  FROM (
    SELECT DISTINCT ON (a.name, a.address) a.name, a.address, d.activity, d.item_id, a.position
    FROM page_dedup d CROSS JOIN LATERAL (
      SELECT COALESCE(entry.value->>'name', '') AS name, entry.value->>'address' AS address, entry.ordinality AS position
      FROM jsonb_array_elements(
        jsonb_build_array(d.envelope->'from') ||
        CASE WHEN jsonb_typeof(d.envelope->'to') = 'array' THEN d.envelope->'to' ELSE '[]'::jsonb END ||
        CASE WHEN jsonb_typeof(d.envelope->'cc') = 'array' THEN d.envelope->'cc' ELSE '[]'::jsonb END
      ) WITH ORDINALITY entry(value, ordinality)
      WHERE jsonb_typeof(entry.value) = 'object' AND jsonb_typeof(entry.value->'address') = 'string'
    ) a WHERE d.thread_id = p.thread_id
    ORDER BY a.name, a.address, d.activity, d.item_id, a.position
  ) x
) parts ON true
ORDER BY p.activity DESC NULLS LAST, p.thread_id DESC
`,
      [
        cursor?.at ?? null,
        cursor?.id ?? null,
        limit + 1,
        filters.folderId,
        filters.mailboxId,
        filters.projectId ?? null,
        filters.personId ?? null,
        filters.threadId ?? null,
        filters.threadIds ?? null,
        window ?? filters.changedThreadIds ?? null,
        ...(search?.params ?? []),
      ],
    );
  const result = await listPage(limit, filters, queryPage, (size) =>
    listMailThreadCandidates(client, filters.folderId, size),
  );
  const rows = result.map((row) => ({
    thread: thread.parse(row.thread),
    itemId: z.uuid().nullable().parse(row.thread_item_id),
  }));
  const linksByItem = await getValueLinksForItems(
    client,
    rows.flatMap((row) => (row.itemId === null ? [] : [row.itemId])),
  );
  return rows.map(({ thread: row, itemId }) => {
    const all = itemId === null ? undefined : linksByItem.get(itemId);
    const links: MailThreadLinks = {};
    for (const key of THREAD_LINK_KEYS) {
      if (all && Object.hasOwn(all, key)) links[key] = all[key];
    }
    return { ...row, links };
  });
}
