import type { PoolClient } from "pg";
import { z } from "zod";
import { NotFoundError } from "../errors.js";
import { sanitizeMailHtml } from "./htmlSanitize.js";
import { resolveMergedThreadId } from "./mailMessageMetaStore.js";
import { htmlToPlainText } from "./mailPlainText.js";
import { listMailThreads, MAIL_OWN_ADDRESSES_SQL } from "./mailThreadListQuery.js";

const address = z.object({ name: z.string(), address: z.string() });
const messageRow = z.object({
  emailId: z.uuid(),
  messageId: z.string(),
  mailboxId: z.uuid().nullable(),
  folderPurpose: z.string().nullable(),
  isOwn: z.boolean(),
  from: address.nullable(),
  to: z.array(address),
  cc: z.array(address),
  replyTo: z.array(address),
  date: z.string().nullable(),
  body: z.string().nullable(),
  read: z.boolean(),
  flagged: z.boolean(),
  attachments: z.array(
    z.object({
      fileItemId: z.uuid().nullable(),
      blobId: z.uuid(),
      filename: z.string(),
      contentType: z.string(),
      byteSize: z.number().int(),
    }),
  ),
});

/**
 * A normalized envelope address list: entries that are objects with a string `address`, in their
 * stored order, `name` defaulting to "". `field` is one of the fixed envelope keys below, never input.
 */
function addressList(field: "to" | "cc" | "replyTo"): string {
  return `COALESCE((SELECT jsonb_agg(jsonb_build_object('name', COALESCE(e.value->>'name', ''), 'address', e.value->>'address') ORDER BY e.ordinality)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.envelope->'${field}') = 'array' THEN d.envelope->'${field}' ELSE '[]'::jsonb END)
      WITH ORDINALITY e(value, ordinality)
    WHERE jsonb_typeof(e.value) = 'object' AND jsonb_typeof(e.value->'address') = 'string'), '[]'::jsonb)`;
}

/**
 * Every live Emails copy of the thread, in any folder or mailbox (Drafts included), one per
 * `message_id`. Among the copies of one message the same one the thread list counts is kept (latest
 * activity, then highest item id). A copy's `folderPurpose` is the special purpose of its folders in
 * the order drafts, sent, inbox, archive, junk, trash, all, none (a Gmail message has several labels),
 * `null` without a folder. Attachments are the copy's `mail_attachments` rows, each paired with the
 * live Files item the Emails `attachments` edge links that has the same blob and file name.
 */
const MESSAGES_SQL = `
WITH schema_ids AS (
  SELECT (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'emails') AS emails,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'folders') AS folders,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'mailboxes') AS mailboxes,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'files') AS files
), email_relation AS (
  SELECT p.key, rd.id, rd.property_id_a = p.id AS email_is_a
  FROM properties p JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.tenant_id = app_tenant_default() AND p.database_id = (SELECT emails FROM schema_ids) AND p.key IN ('folder', 'attachments')
), own_addresses AS (${MAIL_OWN_ADDRESSES_SQL}), copies AS (
  SELECT m.item_id, m.message_id, m.mailbox_item_id, m.envelope, i.properties,
    COALESCE(NULLIF(i.properties->>'date', '')::timestamptz, m.ingested_at) AS message_date,
    COALESCE(NULLIF(i.properties->>'date', '')::timestamptz, m.ingested_at, i.updated_at) AS activity,
    EXISTS (SELECT 1 FROM own_addresses o WHERE o.address = lower(btrim(m.envelope->'from'->>'address', E' \\t\\n\\r'))) AS own,
    (SELECT folder.properties->>'specialPurpose'
       FROM email_relation er JOIN item_relations r ON r.tenant_id = m.tenant_id AND r.relation_definition_id = er.id
         AND (CASE WHEN er.email_is_a THEN r.item_a ELSE r.item_b END) = i.id
       JOIN items folder ON folder.tenant_id = m.tenant_id AND folder.database_id = (SELECT folders FROM schema_ids)
         AND folder.id = CASE WHEN er.email_is_a THEN r.item_b ELSE r.item_a END AND folder.deleted_at IS NULL
       WHERE er.key = 'folder'
       ORDER BY array_position(ARRAY['drafts', 'sent', 'inbox', 'archive', 'junk', 'trash', 'all', 'none'],
         folder.properties->>'specialPurpose') NULLS LAST, folder.id
       LIMIT 1) AS folder_purpose
  FROM mail_message_meta m
  JOIN items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id AND i.database_id = (SELECT emails FROM schema_ids)
  WHERE m.tenant_id = app_tenant_default() AND m.thread_id = $1 AND i.deleted_at IS NULL
), dedup AS (
  SELECT DISTINCT ON (message_id) * FROM copies ORDER BY message_id, activity DESC NULLS LAST, item_id DESC
)
SELECT jsonb_build_object(
  'emailId', d.item_id, 'messageId', d.message_id, 'mailboxId', d.mailbox_item_id,
  'folderPurpose', d.folder_purpose, 'isOwn', d.own,
  'from', CASE WHEN jsonb_typeof(d.envelope->'from'->'address') = 'string'
    THEN jsonb_build_object('name', COALESCE(d.envelope->'from'->>'name', ''), 'address', d.envelope->'from'->>'address') END,
  'to', ${addressList("to")}, 'cc', ${addressList("cc")}, 'replyTo', ${addressList("replyTo")},
  'date', to_char(d.message_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'body', CASE WHEN jsonb_typeof(d.properties->'body') = 'string' THEN d.properties->>'body' END,
  'read', COALESCE(d.properties->'read' = 'true'::jsonb, false),
  'flagged', COALESCE(d.properties->'flagged' = 'true'::jsonb, false),
  'attachments', COALESCE(attachments.value, '[]'::jsonb)
) AS message
FROM dedup d
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('fileItemId', f.id, 'blobId', a.blob_id, 'filename', a.filename,
    'contentType', a.content_type, 'byteSize', a.byte_size) ORDER BY a.filename, a.blob_id, a.n) AS value
  FROM (
    SELECT a.*, row_number() OVER (PARTITION BY a.blob_id, a.filename ORDER BY a.id) AS n
    FROM mail_attachments a WHERE a.tenant_id = app_tenant_default() AND a.message_item_id = d.item_id
  ) a
  LEFT JOIN (
    SELECT file.id, file.properties->'file'->>'blobId' AS blob_id, file.properties->>'name' AS name,
      row_number() OVER (PARTITION BY file.properties->'file'->>'blobId', file.properties->>'name' ORDER BY file.id) AS n
    FROM email_relation er JOIN item_relations r ON r.tenant_id = app_tenant_default() AND r.relation_definition_id = er.id
      AND (CASE WHEN er.email_is_a THEN r.item_a ELSE r.item_b END) = d.item_id
    JOIN items file ON file.tenant_id = app_tenant_default() AND file.database_id = (SELECT files FROM schema_ids)
      AND file.id = CASE WHEN er.email_is_a THEN r.item_b ELSE r.item_a END AND file.deleted_at IS NULL
    WHERE er.key = 'attachments'
  ) f ON f.blob_id = a.blob_id::text AND f.name = a.filename AND f.n = a.n
) attachments ON true
ORDER BY d.message_date ASC NULLS LAST, d.item_id ASC
`;

/**
 * `GET /api/mail/threads/:threadId` (issue #1632): a merged-away id is translated to its target; an
 * unknown id, another tenant's id and a thread with no live message answer the same 404. The header
 * is the list query's row for this thread in its detail-only mode: the list's aggregate rules over
 * every live copy, drafts included (the list itself leaves drafts out), so a draft-only thread is
 * shown too. Header and messages are read in the caller's transaction, so with REPEATABLE READ both
 * come from one snapshot.
 *
 * Emails stores one `body`: the HTML part, else the text part (mail/ingest.ts). `bodyHtml` is that
 * body through `sanitizeMailHtml`, with remote images only when `allowRemoteImages` is set; there is
 * no separate stored text body, so `bodyText` is always `htmlToPlainText` of the same body. Nothing
 * sanitized is stored.
 */
export async function getMailThreadDetail(client: PoolClient, threadId: string, allowRemoteImages: boolean) {
  const targetId = await resolveMergedThreadId(client, threadId);
  if (!targetId) throw new NotFoundError("Thread not found");
  const [header] = await listMailThreads(client, 1, null, {
    box: "inbox",
    folderId: null,
    unread: false,
    mailboxId: null,
    threadId: targetId,
  });
  if (!header) throw new NotFoundError("Thread not found");
  const { rows } = await client.query<{ message: unknown }>(MESSAGES_SQL, [targetId]);
  const messages = rows.map((row) => {
    const { body, ...message } = messageRow.parse(row.message);
    const raw = body ?? "";
    return { ...message, bodyHtml: sanitizeMailHtml(raw, { allowRemoteImages }), bodyText: htmlToPlainText(raw) };
  });
  return {
    threadId: header.threadId,
    subject: header.subject,
    lastMessageAt: header.lastMessageAt,
    lastSender: header.lastSender,
    participants: header.participants,
    messageCount: header.messageCount,
    unread: header.unread,
    flagged: header.flagged,
    mailboxes: header.mailboxes,
    senderPerson: header.senderPerson,
    messages,
  };
}
