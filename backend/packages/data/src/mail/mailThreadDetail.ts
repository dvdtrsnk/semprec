import type { PoolClient } from "pg";
import { z } from "zod";
import { getValueLinksForItems, type ValueLinkEntry } from "../chokePoint/valueLinkReads.js";
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
 * A project or a person of a task: live with its name, or in the trash as the marker alone (issue sp-9cf1be65;
 * the `state` of `SempRefResolution`).
 */
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

/** The Tasks properties whose link state the detail reports (issue gh-1692). */
const TASK_LINK_KEYS = ["project", "people"] as const;

/**
 * The not-deleted Tasks items that have a `Threads.tasks` edge from the Threads item of mail thread `$1`,
 * each with its project (through `Tasks.project`) and its people (through `Tasks.people`). A project or a
 * person is `{ id, state: 'active', name }`, or `{ id, state: 'trashed' }` with no name when it is in the
 * trash; live people come first by name and then id, people in the trash after them by id. Tasks with
 * status `notDone` come first and every other task after them; inside each of the two groups tasks go by
 * `date` ascending with undated ones last, then by creation time and id. A task always has a status
 * (docs/adr/2026-11-13-a-task-always-has-a-status.md), so the order has no branch for a missing one. One
 * statement whatever the number of tasks.
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

/**
 * The tasks made from mail thread `threadId` (issue gh-1692): exactly the tasks `THREAD_TASKS_SQL`
 * selects, in its order, with each task's `project` and `people` as `THREAD_TASKS_SQL` builds them (a
 * project or a person in the trash is listed as `{ id, state: 'trashed' }`). `links` carries the task's value-link entries (the shape of issue #1403) for
 * `project` and `people` only, and only for a property that has a value-link row. The tasks with their
 * projects and people are one statement and the links one batched read (`getValueLinksForItems`), so
 * the number of statements does not grow with the number of tasks.
 */
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
 * `GET /api/mail/threads/:threadId` (issue #1632): a merged-away id is translated to its target; an
 * unknown id, another tenant's id and a thread with no live message answer the same 404. The header
 * is the list query's row for this thread in its detail-only mode: the list's aggregate rules over
 * every live copy, drafts included (the list itself leaves drafts out), so a draft-only thread is
 * shown too, with the same `project` and `company` (`{ id, name }` or `null`, also `null` for one in the
 * Trash) and `links` (issue gh-1897). `tasks` are the tasks linked to the thread (`listThreadTasks`, issue gh-1692), each with a
 * string `status` and its project and people marked `state: 'active'` or `state: 'trashed'` (issue
 * sp-9cf1be65); a trashed task is not listed. Header,
 * messages and tasks are read in the caller's transaction, so with REPEATABLE READ all come from one
 * snapshot.
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
    project: header.project,
    company: header.company,
    links: header.links,
    messages,
    tasks: await listThreadTasks(client, targetId),
  };
}
