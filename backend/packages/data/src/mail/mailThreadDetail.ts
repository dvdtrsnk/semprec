import type { PoolClient } from "pg";
import { z } from "zod";
import { getValueLinksForItems, type ValueLinkEntry } from "../chokePoint/valueLinkReads.js";
import { NotFoundError } from "../errors.js";
import { sanitizeMailHtml } from "./htmlSanitize.js";
import { resolveMergedThreadId } from "./mailMessageMetaStore.js";
import { readMailAttachmentProjects, type MailAttachmentProjects } from "./mailThreadAttachmentProjects.js";
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

/** What an attachment that has no Files item shows as its project and links. */
const NO_ATTACHMENT_PROJECT: MailAttachmentProjects = { project: null, links: {} };

/** `field` is one of the fixed envelope keys below, never input. */
function addressList(field: "to" | "cc" | "replyTo"): string {
  return `COALESCE((SELECT jsonb_agg(jsonb_build_object('name', COALESCE(e.value->>'name', ''), 'address', e.value->>'address') ORDER BY e.ordinality)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.envelope->'${field}') = 'array' THEN d.envelope->'${field}' ELSE '[]'::jsonb END)
      WITH ORDINALITY e(value, ordinality)
    WHERE jsonb_typeof(e.value) = 'object' AND jsonb_typeof(e.value->'address') = 'string'), '[]'::jsonb)`;
}

/**
 * Every live Emails copy of the thread (Drafts included), one per `message_id`, keeping the copy the
 * thread list counts (latest activity, then highest item id). `folderPurpose` picks one purpose in the
 * order drafts, sent, inbox, archive, junk, trash, all, none (a Gmail message has several labels).
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

/** A project or person of a task: live with its name, or in the trash as the marker alone. */
const namedItem = z.discriminatedUnion("state", [
  z.object({ id: z.uuid(), state: z.literal("active"), name: z.string() }),
  z.object({ id: z.uuid(), state: z.literal("trashed") }),
]);
const taskRow = z.object({
  id: z.uuid(),
  name: z.string(),
  date: z.string().nullable(),
  status: z.string(),
  project: namedItem.nullable(),
  people: z.array(namedItem),
});

const TASK_LINK_KEYS = ["project", "people"] as const;

/**
 * Tasks linked from the thread's Threads item, with project and people. Order: `notDone` first, then
 * by `date` (undated last), creation time and id. A task always has a status, so there is no branch
 * for a missing one. One statement whatever the number of tasks.
 */
const THREAD_TASKS_SQL = `
WITH schema_ids AS (
  SELECT (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'threads') AS threads,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'tasks') AS tasks,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'projects') AS projects,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'people') AS people
), thread_tasks AS (
  SELECT rd.id, rd.property_id_a = p.id AS thread_is_a
  FROM properties p JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.tenant_id = app_tenant_default() AND p.database_id = (SELECT threads FROM schema_ids) AND p.key = 'tasks'
), task_relation AS (
  SELECT p.key, rd.id, rd.property_id_a = p.id AS task_is_a
  FROM properties p JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.tenant_id = app_tenant_default() AND p.database_id = (SELECT tasks FROM schema_ids) AND p.key IN ('project', 'people')
), linked AS (
  SELECT task.id, task.properties, task.created_at
  FROM mail_threads t
  JOIN thread_tasks tt ON true
  JOIN item_relations r ON r.tenant_id = t.tenant_id AND r.relation_definition_id = tt.id
    AND (CASE WHEN tt.thread_is_a THEN r.item_a ELSE r.item_b END) = t.item_id
  JOIN items task ON task.tenant_id = t.tenant_id AND task.database_id = (SELECT tasks FROM schema_ids)
    AND task.id = CASE WHEN tt.thread_is_a THEN r.item_b ELSE r.item_a END AND task.deleted_at IS NULL
  WHERE t.tenant_id = app_tenant_default() AND t.id = $1
)
SELECT jsonb_build_object(
  'id', l.id,
  'name', COALESCE(l.properties->>'name', ''),
  'date', CASE WHEN jsonb_typeof(l.properties->'date') = 'string' THEN l.properties->>'date' END,
  'status', l.properties->>'status',
  'project', project.value,
  'people', COALESCE(people.value, '[]'::jsonb)
) AS task
FROM linked l
LEFT JOIN LATERAL (
  SELECT CASE WHEN i.deleted_at IS NULL
    THEN jsonb_build_object('id', i.id, 'state', 'active', 'name', COALESCE(i.properties->>'name', ''))
    ELSE jsonb_build_object('id', i.id, 'state', 'trashed') END AS value
  FROM task_relation tr JOIN item_relations r ON r.tenant_id = app_tenant_default() AND r.relation_definition_id = tr.id
    AND (CASE WHEN tr.task_is_a THEN r.item_a ELSE r.item_b END) = l.id
  JOIN items i ON i.tenant_id = app_tenant_default() AND i.database_id = (SELECT projects FROM schema_ids)
    AND i.id = CASE WHEN tr.task_is_a THEN r.item_b ELSE r.item_a END
  WHERE tr.key = 'project'
  ORDER BY i.id LIMIT 1
) project ON true
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
    CASE WHEN i.deleted_at IS NULL
      THEN jsonb_build_object('id', i.id, 'state', 'active', 'name', COALESCE(i.properties->>'name', ''))
      ELSE jsonb_build_object('id', i.id, 'state', 'trashed') END
    ORDER BY i.deleted_at IS NOT NULL, CASE WHEN i.deleted_at IS NULL THEN COALESCE(i.properties->>'name', '') END, i.id
  ) AS value
  FROM task_relation tr JOIN item_relations r ON r.tenant_id = app_tenant_default() AND r.relation_definition_id = tr.id
    AND (CASE WHEN tr.task_is_a THEN r.item_a ELSE r.item_b END) = l.id
  JOIN items i ON i.tenant_id = app_tenant_default() AND i.database_id = (SELECT people FROM schema_ids)
    AND i.id = CASE WHEN tr.task_is_a THEN r.item_b ELSE r.item_a END
  WHERE tr.key = 'people'
) people ON true
ORDER BY (l.properties->>'status' = 'notDone') DESC, NULLIF(l.properties->>'date', '') ASC NULLS LAST,
  l.created_at ASC, l.id ASC
`;

/** Tasks and their projects/people in one statement, the links in one batched read. */
async function listThreadTasks(client: PoolClient, threadId: string) {
  const { rows } = await client.query<{ task: unknown }>(THREAD_TASKS_SQL, [threadId]);
  const tasks = rows.map((row) => taskRow.parse(row.task));
  const linksByTask = await getValueLinksForItems(
    client,
    tasks.map((task) => task.id),
  );
  return tasks.map((task) => {
    const all = linksByTask.get(task.id);
    const links: Partial<Record<(typeof TASK_LINK_KEYS)[number], ValueLinkEntry>> = {};
    for (const key of TASK_LINK_KEYS) {
      if (all && Object.hasOwn(all, key)) links[key] = all[key];
    }
    return { ...task, links };
  });
}

/**
 * `GET /api/mail/threads/:threadId`: a merged-away id is translated to its target; an unknown id,
 * another tenant's id and a thread with no live message answer the same 404. The header uses the list
 * query's detail-only mode (drafts included), so a draft-only thread is shown too. Everything is read
 * in the caller's transaction, so with REPEATABLE READ it comes from one snapshot.
 *
 * Emails stores one `body` (HTML part, else text part). `bodyHtml` is that body sanitized, with remote
 * images only when `allowRemoteImages` is set; `bodyText` is `htmlToPlainText` of the same body.
 * Nothing sanitized is stored.
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
  const parsed = rows.map((row) => messageRow.parse(row.message));
  const attachmentProjects = await readMailAttachmentProjects(
    client,
    parsed.flatMap((message) =>
      message.attachments.flatMap((file) => (file.fileItemId === null ? [] : [file.fileItemId])),
    ),
  );
  const messages = parsed.map(({ body, ...message }) => {
    const raw = body ?? "";
    return {
      ...message,
      attachments: message.attachments.map((file) => ({
        ...file,
        ...((file.fileItemId === null ? undefined : attachmentProjects.get(file.fileItemId)) ?? NO_ATTACHMENT_PROJECT),
      })),
      bodyHtml: sanitizeMailHtml(raw, { allowRemoteImages }),
      bodyText: htmlToPlainText(raw),
    };
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
    project: header.project,
    company: header.company,
    links: header.links,
    messages,
    tasks: await listThreadTasks(client, targetId),
  };
}
