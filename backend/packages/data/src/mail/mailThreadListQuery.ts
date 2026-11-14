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

/**
 * The lowercased, trimmed addresses of the tenant's live mailboxes (their `addresses` property): a
 * message whose sender is one of them is the user's own. Fixed SQL over the query's `schema_ids`.
 */
export const MAIL_OWN_ADDRESSES_SQL = `
  SELECT DISTINCT lower(btrim(a.address, E' \\t\\n\\r')) AS address
  FROM items i CROSS JOIN LATERAL regexp_split_to_table(
    CASE WHEN jsonb_typeof(i.properties->'addresses') = 'string' THEN i.properties->>'addresses' ELSE '' END,
    E'[,\\n\\r]+') a(address)
  WHERE i.tenant_id = app_tenant_default() AND i.database_id = (SELECT mailboxes FROM schema_ids)
    AND i.deleted_at IS NULL AND btrim(a.address, E' \\t\\n\\r') <> ''
`;

/**
 * The CTEs the thread list and the mail summary (`mailSummary.ts`) both start from, so a count reads
 * the same copies the list shows: `schema_ids`, `folder_definition`, `own_addresses`, `copies` (one
 * row per live copy of a threaded message; drafts are left out unless the bind parameter numbered
 * `threadIdParameter` names one thread) and `copy_stats` (one row per thread of `copies`). The
 * fragments of `mailThreadPredicates.ts` refer to `schema_ids`, `copies` and `copy_stats`. The text
 * is fixed SQL except for that parameter number, which is a `number` the caller chooses.
 */
export function mailThreadCopyCtes(threadIdParameter: number): string {
  const threadId = `$${threadIdParameter}`;
  return `schema_ids AS (
  SELECT (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'emails') AS emails,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'folders') AS folders,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'mailboxes') AS mailboxes,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'people') AS people,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'threads') AS threads,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'projects') AS projects,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'areas') AS areas
), folder_definition AS (
  SELECT rd.id, rd.property_id_a = p.id AS email_is_a
  FROM properties p JOIN relation_definitions rd ON p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.database_id = (SELECT emails FROM schema_ids) AND p.key = 'folder'
), own_addresses AS (${MAIL_OWN_ADDRESSES_SQL}), copies AS (
  SELECT m.thread_id, m.item_id, m.message_id, m.mailbox_item_id, m.envelope, m.preview_text,
    NULLIF(i.properties->>'date', '')::timestamptz AS message_date,
    COALESCE(NULLIF(i.properties->>'date', '')::timestamptz, m.ingested_at, i.updated_at) AS activity,
    COALESCE(i.properties->>'name', '') AS subject,
    COALESCE(i.properties->'read' = 'true'::jsonb, false) AS is_read,
    COALESCE(i.properties->'flagged' = 'true'::jsonb, false) AS flagged,
    EXISTS (SELECT 1 FROM mail_attachments a WHERE a.tenant_id = m.tenant_id AND a.message_item_id = m.item_id) AS attached,
    EXISTS (SELECT 1 FROM own_addresses o WHERE o.address = lower(btrim(m.envelope->'from'->>'address', E' \\t\\n\\r'))) AS own,
    COALESCE(f.has_sent, false) AS has_sent,
    COALESCE(f.has_inbox, false) AS has_inbox, COALESCE(f.has_non_junk, true) AS has_non_junk,
    COALESCE(f.folder_ids, ARRAY[]::uuid[]) AS folder_ids
  FROM mail_message_meta m
  JOIN items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id AND i.database_id = (SELECT emails FROM schema_ids)
  LEFT JOIN LATERAL (
    SELECT count(*) AS n, bool_and(COALESCE(folder.properties->>'specialPurpose' = 'drafts', false)) AS only_drafts,
      bool_or(COALESCE(folder.properties->>'specialPurpose' = 'sent', false)) AS has_sent,
      bool_or(COALESCE(folder.properties->>'specialPurpose' = 'inbox', false)) AS has_inbox,
      bool_or(COALESCE(folder.properties->>'specialPurpose' NOT IN ('junk', 'trash'), true)) AS has_non_junk,
      array_agg(folder.id) AS folder_ids
    FROM folder_definition fd JOIN item_relations r ON r.relation_definition_id = fd.id AND r.tenant_id = m.tenant_id
      AND (CASE WHEN fd.email_is_a THEN r.item_a ELSE r.item_b END) = i.id
    JOIN items folder ON folder.tenant_id = m.tenant_id AND folder.database_id = (SELECT folders FROM schema_ids)
      AND folder.id = CASE WHEN fd.email_is_a THEN r.item_b ELSE r.item_a END AND folder.deleted_at IS NULL
  ) f ON true
  WHERE m.tenant_id = app_tenant_default() AND m.thread_id IS NOT NULL AND i.deleted_at IS NULL
    AND (${threadId}::uuid IS NULL OR m.thread_id = ${threadId}::uuid)
    -- The list leaves drafts out; the detail-only mode (${threadId}) aggregates every live copy, drafts included.
    AND (${threadId}::uuid IS NOT NULL OR (NOT (f.n > 0 AND COALESCE(f.only_drafts, false))
      AND NOT EXISTS (SELECT 1 FROM mail_drafts d WHERE d.tenant_id = m.tenant_id AND d.email_item_id = i.id AND d.sent_at IS NULL)))
), copy_stats AS (
  SELECT thread_id, bool_or(attached) AS has_attachment, bool_or(flagged) AS flagged,
    bool_or(NOT own AND NOT has_sent AND NOT is_read) AS unread
  FROM copies GROUP BY thread_id
)`;
}

/**
 * The `search_messages` CTE that the fragments of `matchesSearch` (`mailThreadPredicates.ts`) read: every live message of
 * the Emails database that has a thread, with the columns the search operators compare. It reads the query's `schema_ids`
 * and `folder_definition`, which `mailThreadCopyCtes` defines, and is fixed SQL. The thread list and the mail group of
 * global search (`mailGlobalSearchGroup.ts`) both put it in their `WITH` list.
 */
export const MAIL_SEARCH_MESSAGES_CTE = `search_messages AS (
  SELECT m.thread_id, m.item_id, m.envelope,
    NULLIF(i.properties->>'date', '')::timestamptz AS message_date,
    COALESCE(i.properties->'read' = 'true'::jsonb, false) AS is_read,
    COALESCE(i.properties->'flagged' = 'true'::jsonb, false) AS flagged,
    EXISTS (SELECT 1 FROM mail_attachments a WHERE a.tenant_id = m.tenant_id AND a.message_item_id = m.item_id) AS attached,
    EXISTS (SELECT 1 FROM folder_definition fd JOIN item_relations r ON r.tenant_id = m.tenant_id AND r.relation_definition_id = fd.id
      AND (CASE WHEN fd.email_is_a THEN r.item_a ELSE r.item_b END) = i.id
      JOIN items f ON f.tenant_id = m.tenant_id AND f.database_id = (SELECT folders FROM schema_ids)
        AND f.id = CASE WHEN fd.email_is_a THEN r.item_b ELSE r.item_a END AND f.deleted_at IS NULL
      WHERE f.properties->>'specialPurpose' IN ('drafts', 'sent')) AS excluded_from_unread
  FROM mail_message_meta m JOIN items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id
    AND i.database_id = (SELECT emails FROM schema_ids)
  WHERE m.tenant_id = app_tenant_default() AND m.thread_id IS NOT NULL AND i.deleted_at IS NULL
)`;

/** The value-link entries of a thread's `company` and `project`, only for a property that has a value-link row. */
export interface MailThreadLinks {
  company?: ValueLinkEntry;
  project?: ValueLinkEntry;
}

/** The Threads properties whose link state the thread list and the detail report (issue gh-1897). */
const THREAD_LINK_KEYS = ["company", "project"] as const;

/**
 * The lateral join that names the one live item a relation property of the Threads item holds (issue gh-1897): the
 * `{ id, name }` of the Projects or Companies item the thread's `propertyKey` edge reaches, or no row when it has no
 * edge or the item is in the Trash, which reads as `null`. The lookup of the target item is pinned to the system
 * database `ownerModuleId`. Both arguments are a literal union and never input, which is why they are interpolated
 * into the fixed SQL. `p.thread_id` is the thread of the page row `p`. A thread that holds several edges (the property
 * is many-valued, but the thread value edge hook admits one) answers the one with the lowest item id.
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

/**
 * The position of a thread in the list order, as the list's `nextCursor` encodes it: base64url of a JSON object with
 * the `lastMessageAt` and the `threadId` of the last listed thread. Throws a `ValidationError` naming `cursor` for a
 * token that is too long, is not canonical base64url, is not JSON or is not that object.
 */
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

/** True when a `before:` or `after:` operand is neither an ISO date nor an ISO date-time with an offset, which Postgres would read differently or refuse. */
export function hasInvalidMailSearchDate(search: ParsedMailSearchQuery): boolean {
  return [search.before, search.after].some(
    (date) =>
      date !== undefined &&
      !z.iso.date().safeParse(date).success &&
      !z.iso.datetime({ offset: true }).safeParse(date).success,
  );
}

export async function listMailThreads(
  client: PoolClient,
  limit: number,
  cursor: { at: string; id: string } | null,
  filters: MailThreadFilters & {
    projectId?: string | null;
    areaId?: string | null;
    personId?: string | null;
    /**
     * Detail-only mode (issue #1632): one thread, in any box or folder, aggregated over every live copy
     * of it, drafts included. The list itself never sets it and keeps leaving drafts out.
     */
    threadId?: string | null;
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
    `($4::uuid IS NOT NULL OR $9::uuid IS NOT NULL OR ${mailThreadPredicates[filters.box]})`,
    `($9::uuid IS NULL OR l.thread_id = $9::uuid)`,
    `($4::uuid IS NULL OR ${mailThreadPredicates.inFolder(4)})`,
    `($5::uuid IS NULL OR ${mailThreadPredicates.inMailbox(5)})`,
  ];
  if (filters.unread) predicates.push(mailThreadPredicates.unread);
  predicates.push(
    `($6::uuid IS NULL OR EXISTS (SELECT 1 FROM thread_project tp WHERE tp.thread_id = l.thread_id AND tp.project_id = $6))`,
  );
  predicates.push(
    `($7::uuid IS NULL OR EXISTS (SELECT 1 FROM thread_project tp JOIN project_area pa ON pa.project_id = tp.project_id WHERE tp.thread_id = l.thread_id AND pa.area_id = $7))`,
  );
  predicates.push(
    `($8::uuid IS NULL OR EXISTS (SELECT 1 FROM message_person mp WHERE mp.thread_id = l.thread_id AND mp.person_id = $8))`,
  );
  const search = filters.search ? matchesSearch(filters.search, 10) : null;
  if (search) predicates.push(search.sql);
  const result = await client.query<{ thread: unknown; thread_item_id: string | null }>(
    `
WITH ${mailThreadCopyCtes(9)}, thread_project AS (
  SELECT t.id AS thread_id, project.id AS project_id
  FROM mail_threads t
  JOIN properties p ON p.tenant_id = t.tenant_id AND p.database_id = (SELECT threads FROM schema_ids) AND p.key = 'project'
  JOIN relation_definitions rd ON rd.tenant_id = t.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  JOIN item_relations r ON r.tenant_id = t.tenant_id AND r.relation_definition_id = rd.id
    AND (CASE WHEN rd.property_id_a = p.id THEN r.item_a ELSE r.item_b END) = t.item_id
  CROSS JOIN LATERAL (SELECT i.id FROM items i WHERE i.tenant_id = t.tenant_id AND i.database_id = (SELECT projects FROM schema_ids)
    AND i.id = CASE WHEN rd.property_id_a = p.id THEN r.item_b ELSE r.item_a END OFFSET 0) project
  WHERE t.tenant_id = app_tenant_default()
), project_area AS (
  SELECT project.id AS project_id, area.id AS area_id
  FROM thread_project tp
  CROSS JOIN LATERAL (SELECT i.id FROM items i WHERE i.tenant_id = app_tenant_default() AND i.database_id = (SELECT projects FROM schema_ids) AND i.id = tp.project_id OFFSET 0) project
  JOIN properties p ON p.tenant_id = app_tenant_default() AND p.database_id = (SELECT projects FROM schema_ids) AND p.key = 'area'
  JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  JOIN item_relations r ON r.tenant_id = p.tenant_id AND r.relation_definition_id = rd.id
    AND (CASE WHEN rd.property_id_a = p.id THEN r.item_a ELSE r.item_b END) = project.id
  CROSS JOIN LATERAL (SELECT i.id FROM items i WHERE i.tenant_id = p.tenant_id AND i.database_id = (SELECT areas FROM schema_ids)
    AND i.id = CASE WHEN rd.property_id_a = p.id THEN r.item_b ELSE r.item_a END OFFSET 0) area
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
)
SELECT jsonb_build_object(
  'threadId', p.thread_id, 'subject', p.subject,
  'lastMessageAt', to_char(p.activity AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'lastSender', jsonb_build_object('name', COALESCE(p.envelope->'from'->>'name', ''), 'address', COALESCE(p.envelope->'from'->>'address', ''), 'personId', person.id),
  'participants', COALESCE(parts.value, '[]'::jsonb), 'messageCount', p.message_count,
  'preview', p.preview_text, 'hasAttachment', p.has_attachment, 'unread', p.unread, 'flagged', p.flagged,
  'mailboxes', COALESCE(boxes.value, '[]'::jsonb),
  'senderPerson', CASE WHEN person.id IS NULL THEN NULL ELSE jsonb_build_object('id', person.id, 'name', COALESCE(person.properties->>'name', ''), 'relationship', person.properties->>'relationship') END,
  'project', project_name.value, 'company', company_name.value, 'hasSempDraft', ${mailThreadHasSempDraft("p.thread_id")}
) AS thread,
  (SELECT mt.item_id FROM mail_threads mt WHERE mt.tenant_id = app_tenant_default() AND mt.id = p.thread_id) AS thread_item_id
FROM page p
${threadRelationNameJoin("project", "projects")}
${threadRelationNameJoin("company", "companies")}
LEFT JOIN person_email_index pei ON pei.tenant_id = app_tenant_default() AND pei.email = lower(btrim(p.envelope->'from'->>'address', E' \\t\\n\\r'))
LEFT JOIN items person ON person.tenant_id = app_tenant_default() AND person.database_id = (SELECT people FROM schema_ids) AND person.id = pei.item_id AND person.deleted_at IS NULL
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('id', box.id, 'name', COALESCE(box.properties->>'name', ''), 'provider', box.properties->>'provider') ORDER BY box.id) AS value
  FROM items box WHERE box.tenant_id = app_tenant_default() AND box.database_id = (SELECT mailboxes FROM schema_ids) AND box.deleted_at IS NULL
    AND box.id IN (SELECT mailbox_item_id FROM copies c WHERE c.thread_id = p.thread_id)
) boxes ON true
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('name', x.name, 'address', x.address) ORDER BY x.activity, x.item_id, x.position) AS value
  FROM (
    SELECT DISTINCT ON (a.name, a.address) a.name, a.address, d.activity, d.item_id, a.position
    FROM dedup d CROSS JOIN LATERAL (
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
      filters.areaId ?? null,
      filters.personId ?? null,
      filters.threadId ?? null,
      ...(search?.params ?? []),
    ],
  );
  const rows = result.rows.map((row) => ({
    thread: thread.parse(row.thread),
    itemId: z.uuid().nullable().parse(row.thread_item_id),
  }));
  // One batched read for the whole page (`getValueLinksForItems`), whatever the number of threads.
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
