import type { PoolClient } from "pg";
import { z } from "zod";

const address = z.object({ name: z.string(), address: z.string() });
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
  project: z.null(),
  company: z.null(),
  hasSempDraft: z.literal(false),
});

export async function listMailThreads(client: PoolClient, limit: number, cursor: { at: string; id: string } | null) {
  const result = await client.query<Record<string, unknown>>(
    `
WITH schema_ids AS (
  SELECT (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'emails') AS emails,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'folders') AS folders,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'mailboxes') AS mailboxes,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'people') AS people
), folder_definition AS (
  SELECT rd.id, rd.property_id_a = p.id AS email_is_a
  FROM properties p JOIN relation_definitions rd ON p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.database_id = (SELECT emails FROM schema_ids) AND p.key = 'folder'
), own_addresses AS (
  SELECT DISTINCT lower(btrim(a.address)) AS address
  FROM items i CROSS JOIN LATERAL regexp_split_to_table(
    CASE WHEN jsonb_typeof(i.properties->'addresses') = 'string' THEN i.properties->>'addresses' ELSE '' END,
    E'[,\\n\\r]+') a(address)
  WHERE i.tenant_id = app_tenant_default() AND i.database_id = (SELECT mailboxes FROM schema_ids) AND i.deleted_at IS NULL
), copies AS (
  SELECT m.thread_id, m.item_id, m.message_id, m.mailbox_item_id, m.envelope, m.preview_text,
    COALESCE(NULLIF(i.properties->>'date', '')::timestamptz, m.ingested_at, i.updated_at) AS activity,
    COALESCE(i.properties->>'name', '') AS subject,
    COALESCE(i.properties->'read' = 'true'::jsonb, false) AS is_read,
    COALESCE(i.properties->'flagged' = 'true'::jsonb, false) AS flagged,
    EXISTS (SELECT 1 FROM mail_attachments a WHERE a.tenant_id = m.tenant_id AND a.message_item_id = m.item_id) AS attached,
    EXISTS (SELECT 1 FROM own_addresses o WHERE o.address = lower(btrim(m.envelope->'from'->>'address'))) AS own,
    COALESCE(f.has_sent, false) AS has_sent
  FROM mail_message_meta m
  JOIN items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id AND i.database_id = (SELECT emails FROM schema_ids)
  LEFT JOIN LATERAL (
    SELECT count(*) AS n, bool_and(COALESCE(folder.properties->>'specialPurpose' = 'drafts', false)) AS only_drafts,
      bool_or(COALESCE(folder.properties->>'specialPurpose' = 'sent', false)) AS has_sent
    FROM folder_definition fd JOIN item_relations r ON r.relation_definition_id = fd.id AND r.tenant_id = m.tenant_id
      AND (CASE WHEN fd.email_is_a THEN r.item_a ELSE r.item_b END) = i.id
    JOIN items folder ON folder.tenant_id = m.tenant_id AND folder.database_id = (SELECT folders FROM schema_ids)
      AND folder.id = CASE WHEN fd.email_is_a THEN r.item_b ELSE r.item_a END AND folder.deleted_at IS NULL
  ) f ON true
  WHERE m.tenant_id = app_tenant_default() AND m.thread_id IS NOT NULL AND i.deleted_at IS NULL
    AND NOT (f.n > 0 AND COALESCE(f.only_drafts, false))
    AND NOT EXISTS (SELECT 1 FROM mail_drafts d WHERE d.tenant_id = m.tenant_id AND d.email_item_id = i.id AND d.sent_at IS NULL)
), dedup AS (
  SELECT DISTINCT ON (thread_id, message_id) thread_id, message_id, item_id, activity, subject, envelope, preview_text
  FROM copies ORDER BY thread_id, message_id, activity DESC NULLS LAST, item_id DESC
), thread_stats AS (
  SELECT thread_id, count(*)::int AS message_count FROM dedup GROUP BY thread_id
), copy_stats AS (
  SELECT thread_id, bool_or(attached) AS has_attachment, bool_or(flagged) AS flagged,
    bool_or(NOT own AND NOT has_sent AND NOT is_read) AS unread
  FROM copies GROUP BY thread_id
), latest AS (
  SELECT DISTINCT ON (thread_id) * FROM dedup ORDER BY thread_id, activity DESC NULLS LAST, item_id DESC
), page AS (
  SELECT l.*, s.message_count, cs.has_attachment, cs.flagged, cs.unread
  FROM latest l JOIN thread_stats s USING (thread_id) JOIN copy_stats cs USING (thread_id)
  WHERE ($1::timestamptz IS NULL OR (l.activity, l.thread_id) < ($1::timestamptz, $2::uuid))
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
  'project', NULL, 'company', NULL, 'hasSempDraft', false
) AS thread
FROM page p
LEFT JOIN person_email_index pei ON pei.tenant_id = app_tenant_default() AND pei.email = lower(btrim(p.envelope->'from'->>'address'))
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
    [cursor?.at ?? null, cursor?.id ?? null, limit + 1],
  );
  return result.rows.map((row) => thread.parse(row.thread));
}
