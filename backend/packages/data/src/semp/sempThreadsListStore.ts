import type { PoolClient } from "pg";
import { stripMarkdown } from "@semprec/block-model";
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { ValidationError } from "../errors.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { assertDescriptionShape, type ApprovalDescription } from "../mcp/approvalRequestsStore.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";

/** The stored values of `semp_threads.kind`. */
export const SEMP_THREAD_KINDS = ["chat", "item", "tick"] as const;
export type SempThreadKind = (typeof SEMP_THREAD_KINDS)[number];

/** Catalog key of the item thread title template (`seed/i18n`); `{itemName}` is the Inbox item's text. */
const ITEM_TITLE_KEY = "semp.thread.itemTitle";

/** Visible length of a text preview, in Unicode code points. */
const PREVIEW_CODE_POINTS = 140;

/**
 * How much of the last message the list query reads to build a preview, in code points. More than
 * the preview shows, because Markdown syntax is removed before the cut.
 */
const PREVIEW_SOURCE_CODE_POINTS = 1000;

/** What a title is resolved from: the stored kind and title plus the two values read live. */
export interface SempThreadTitleParts {
  kind: SempThreadKind;
  /** The stored `semp_threads.title`; only a chat thread has one. */
  title: string | null;
  /** The current `project_heartbeats.name` of a tick thread's heartbeat. */
  heartbeatName: string | null;
  /** The current `text` of an item thread's Inbox item; null when the item is in the trash or gone. */
  subjectText: string | null;
}

/**
 * The title rule of Semp threads for `locale`, as the thread list applies it. It is one function so
 * that another read that names a thread can resolve the same title; the approval source of issue
 * #1766 calls it. A chat thread has its stored title (null until one is generated), a
 * tick thread its heartbeat's current name, and an item thread the `semp.thread.itemTitle` template
 * filled with the Inbox item's current text. An item thread whose Inbox item has no text, or is
 * gone, has no title. Nothing is stored: a caller passes the values it read in the same request.
 * The text is user content, so it is inserted through a replacer function and a `$` in it is not
 * read as a replacement pattern.
 */
export async function loadSempThreadTitleResolver(
  locale: string,
): Promise<(thread: SempThreadTitleParts) => string | null> {
  const catalogs = await loadModuleCatalogs(new URL("../seed/systemDatabasesModuleManifest.js", import.meta.url).href);
  const template = resolveCatalogLabel(null, catalogs[toManifestLocale(locale)], catalogs.en, ITEM_TITLE_KEY);
  return (thread) => {
    if (thread.kind === "chat") return thread.title;
    if (thread.kind === "tick") return thread.heartbeatName;
    const itemName = thread.subjectText;
    if (itemName === null || itemName.trim() === "") return null;
    return template.replaceAll("{itemName}", () => itemName);
  };
}

/** The Inbox subject of an item thread. */
export interface SempThreadSubject {
  inboxItemId: string;
  /** The proposal card named when the thread was created; null when none was named. */
  proposalId: string | null;
  /** False when the Inbox item is in the trash or gone. */
  exists: boolean;
}

/**
 * The `subject` object of an item thread: the two ids the thread stores and `exists`, which the
 * caller reads live in the same request. Exported so that the thread detail can return the same
 * shape; the detail response does not call it yet.
 */
export function mapSempThreadSubject(
  stored: { inboxItemId: string; proposalId: string | null },
  exists: boolean,
): SempThreadSubject {
  return { inboxItemId: stored.inboxItemId, proposalId: stored.proposalId, exists };
}

/** Where a page of the list continues: the last row's `last_activity_at` with microseconds, and its id. */
export interface SempThreadListCursor {
  lastActivityAt: string;
  id: string;
}

const CURSOR_SHAPE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function encodeCursor(cursor: SempThreadListCursor): string {
  return Buffer.from(`${cursor.lastActivityAt}|${cursor.id}`).toString("base64url");
}

/**
 * Decodes a `nextCursor` of `listSempThreads`. A value of another shape is a `ValidationError` on
 * `cursor`, and so is an instant that is no calendar time or lies in year zero: Postgres would
 * refuse both as a `timestamptz`.
 */
export function parseSempThreadListCursor(value: string): SempThreadListCursor {
  const match = /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ? CURSOR_SHAPE.exec(Buffer.from(value, "base64url").toString("utf8"))
    : null;
  const lastActivityAt = match?.[1];
  const id = match?.[2];
  if (
    lastActivityAt === undefined ||
    id === undefined ||
    lastActivityAt.startsWith("0000-") ||
    !Number.isFinite(Date.parse(lastActivityAt)) ||
    new Date(lastActivityAt).toISOString() !== `${lastActivityAt.slice(0, 23)}Z`
  ) {
    throw new ValidationError("Invalid 'cursor'", { field: "cursor" });
  }
  return { lastActivityAt, id };
}

/** A system message as a preview: its i18n key and parameters instead of text. */
export interface SempThreadSystemPreview {
  key: string;
  params: unknown;
}

/** The newest pending approval request raised by a run of the thread. */
export interface SempThreadPendingApproval {
  /** The localisable description snapshotted on the request; null for a request stored without one. */
  description: ApprovalDescription | null;
  /** What raised the request: a generic operation of this system, or a call of an outside MCP tool. */
  sourceKind: "genericOperation" | "mcpInvoke";
}

/** The heartbeat of a tick thread. `projectName` is null when the project item has no name, is in the trash or is gone. */
export interface SempThreadListHeartbeat {
  id: string;
  name: string;
  projectItemId: string;
  projectName: string | null;
}

export interface SempThreadListRow {
  id: string;
  kind: SempThreadKind;
  title: string | null;
  /** Null when no message of the thread has text or a system key yet. */
  preview: string | SempThreadSystemPreview | null;
  lastActivityAt: string;
  hasPendingApproval: boolean;
  pendingApproval: SempThreadPendingApproval | null;
  heartbeat: SempThreadListHeartbeat | null;
  subject: SempThreadSubject | null;
}

export interface ListSempThreadsInput {
  /** The stored kinds to return. */
  kinds: readonly SempThreadKind[];
  /** Only the thread of this Inbox item, when set. */
  subjectInboxItemId: string | null;
  /**
   * Only threads that contain this text, without regard to case or diacritics, in the value their
   * title is resolved from or in the first 140 code points of the stored text of the previewed
   * message (see `listSempThreads`). Null is no filter, and so is a text of which removing the
   * diacritics leaves nothing.
   */
  search: string | null;
  cursor: SempThreadListCursor | null;
  limit: number;
  /** The caller's `users.locale`, for the item thread title template. */
  locale: string;
}

interface ThreadListDbRow {
  id: string;
  kind: string;
  title: string | null;
  subject_inbox_item_id: string | null;
  subject_proposal_id: string | null;
  last_activity_at: Date;
  activity_cursor: string;
  heartbeat_id: string | null;
  heartbeat_name: string | null;
  heartbeat_project_item_id: string | null;
  subject_exists: boolean;
  subject_text: string | null;
  preview_text: string | null;
  preview_cut: boolean | null;
  preview_system_key: string | null;
  preview_system_params: unknown;
  approval_id: string | null;
  approval_description: unknown;
  approval_generic_operation: boolean | null;
}

/**
 * The current `text` of the joined Inbox item `subject`, null unless it is a JSON string. A fixed
 * SQL fragment; no caller input is interpolated.
 */
const SUBJECT_TEXT_SQL = `CASE WHEN jsonb_typeof(subject.properties -> 'text') = 'string'
                 THEN subject.properties ->> 'text' END`;

/**
 * The preview of a thread's last message that has something to show. A system message gives its
 * key and parameters. Text is reduced to plain text and cut to 140 code points, with an ellipsis
 * when the message goes on.
 */
function previewOf(row: ThreadListDbRow): string | SempThreadSystemPreview | null {
  if (row.preview_system_key !== null) return { key: row.preview_system_key, params: row.preview_system_params };
  if (row.preview_text === null) return null;
  const plain = stripMarkdown(row.preview_text, Number.MAX_SAFE_INTEGER);
  const codePoints = Array.from(plain);
  if (codePoints.length <= PREVIEW_CODE_POINTS && row.preview_cut !== true) return plain;
  return `${codePoints.slice(0, PREVIEW_CODE_POINTS).join("")}…`;
}

function heartbeatOf(row: ThreadListDbRow, projectNames: Map<string, string | null>): SempThreadListHeartbeat | null {
  // The three columns come from one joined `project_heartbeats` row, so they are null together.
  if (row.heartbeat_id === null || row.heartbeat_name === null || row.heartbeat_project_item_id === null) return null;
  return {
    id: row.heartbeat_id,
    name: row.heartbeat_name,
    projectItemId: row.heartbeat_project_item_id,
    projectName: projectNames.get(row.heartbeat_project_item_id) ?? null,
  };
}

/**
 * One page of the tenant's Semp threads, newest activity first (`last_activity_at DESC, id DESC`),
 * with `nextCursor` set while more rows follow. Runs in the caller's tenant scope; every table it
 * reads is a tenant table under row-level security. Title, heartbeat, project name and
 * `subject.exists` are read at request time and no thread row is written.
 *
 * The preview is the last message that has text or a system key, so an assistant reply that is
 * still queued or running, or that failed, does not blank the row. `hasPendingApproval` and
 * `pendingApproval` describe the newest pending approval request of a run whose `thread_id` is
 * the thread; a delegated run carries its parent's thread id.
 *
 * `search` (issue #1737) keeps the threads that contain it in either of two values, compared as
 * substrings through `unaccent` and `ILIKE`, before the page is cut. The first is what the title is
 * resolved from: the stored title of a chat, the current heartbeat name of a tick thread, the
 * current Inbox item text of an item thread. The second is the first 140 code points of the stored
 * text of the message the preview shows; the key and parameters of a system message are not
 * searched. That text still has its Markdown syntax, which the shown preview has not: syntax and
 * link targets inside the window can match, and a word the preview shows near its end can lie
 * beyond the window and then does not.
 *
 * The search text is a bound parameter and the pattern is built from it in the query: the text is
 * folded with `unaccent` first, and a backslash, `%` and `_` in the folded text are escaped after
 * that, so each matches only itself. The order matters because folding itself produces these three
 * characters, for example `%` from a fullwidth percent sign. A text of which folding leaves
 * nothing, such as a lone combining mark, is no filter, as a blank one is.
 */
export async function listSempThreads(
  client: PoolClient,
  input: ListSempThreadsInput,
): Promise<{ rows: SempThreadListRow[]; nextCursor: string | null }> {
  const inbox = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
  const { rows } = await client.query<ThreadListDbRow>(
    `WITH pending AS (
       SELECT DISTINCT ON (r.thread_id) r.tenant_id, r.thread_id, a.id, a.description,
              a.payload ? 'operationName' AS generic_operation
         FROM approval_requests a
         JOIN agent_runs r ON r.tenant_id = a.tenant_id AND r.id = a.agent_run_id
        WHERE a.status = 'pending' AND r.thread_id IS NOT NULL
        ORDER BY r.thread_id, a.requested_at DESC, a.id DESC
     ),
     needle AS MATERIALIZED (
       SELECT CASE WHEN folded.text <> ''
                   THEN '%' || replace(replace(replace(folded.text, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'
              END AS pattern
         FROM (SELECT unaccent($8::text) AS text) folded
     )
     SELECT t.id, t.kind, t.title, t.subject_inbox_item_id, t.subject_proposal_id, t.last_activity_at,
            to_char(t.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activity_cursor,
            h.id AS heartbeat_id, h.name AS heartbeat_name, h.project_item_id AS heartbeat_project_item_id,
            subject.id IS NOT NULL AS subject_exists,
            ${SUBJECT_TEXT_SQL} AS subject_text,
            last_message.text AS preview_text, last_message.cut AS preview_cut,
            last_message.system_key AS preview_system_key, last_message.system_params AS preview_system_params,
            pending.id AS approval_id, pending.description AS approval_description,
            pending.generic_operation AS approval_generic_operation
       FROM semp_threads t
       CROSS JOIN needle
       LEFT JOIN project_heartbeats h ON h.tenant_id = t.tenant_id AND h.id = t.heartbeat_id
       LEFT JOIN items subject ON subject.tenant_id = t.tenant_id AND subject.database_id = $6::uuid
              AND subject.id = t.subject_inbox_item_id AND subject.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT left(m.text, $7::int) AS text, char_length(m.text) > $7::int AS cut, m.system_key, m.system_params
           FROM semp_messages m
          WHERE m.tenant_id = t.tenant_id AND m.thread_id = t.id
            AND (m.text IS NOT NULL OR m.system_key IS NOT NULL)
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
       ) last_message ON true
       LEFT JOIN pending ON pending.tenant_id = t.tenant_id AND pending.thread_id = t.id
      WHERE t.kind = ANY($1::text[])
        AND ($2::uuid IS NULL OR t.subject_inbox_item_id = $2::uuid)
        AND ($3::timestamptz IS NULL OR (t.last_activity_at, t.id) < ($3::timestamptz, $4::uuid))
        AND (needle.pattern IS NULL
             OR unaccent(CASE t.kind WHEN 'chat' THEN t.title WHEN 'tick' THEN h.name
                         ELSE ${SUBJECT_TEXT_SQL} END) ILIKE needle.pattern ESCAPE '\\'
             OR unaccent(left(last_message.text, $9::int)) ILIKE needle.pattern ESCAPE '\\')
      ORDER BY t.last_activity_at DESC, t.id DESC
      LIMIT $5`,
    [
      [...input.kinds],
      input.subjectInboxItemId,
      input.cursor?.lastActivityAt ?? null,
      input.cursor?.id ?? null,
      input.limit + 1,
      inbox?.id ?? null,
      PREVIEW_SOURCE_CODE_POINTS,
      input.search,
      PREVIEW_CODE_POINTS,
    ],
  );
  const page = rows.slice(0, input.limit);
  const projectItemIds = [...new Set(page.flatMap((row) => row.heartbeat_project_item_id ?? []))];
  const projects = await getItemsByIds(client, projectItemIds);
  const projectNames = new Map(
    projects.map((item) => [item.id, typeof item.properties.name === "string" ? item.properties.name : null]),
  );
  const resolveTitle = await loadSempThreadTitleResolver(input.locale);
  const last = page.at(-1);
  return {
    rows: page.map((row) => {
      const kind = assertKnownValue(SEMP_THREAD_KINDS, row.kind, "thread kind");
      return {
        id: row.id,
        kind,
        title: resolveTitle({
          kind,
          title: row.title,
          heartbeatName: row.heartbeat_name,
          subjectText: row.subject_text,
        }),
        preview: previewOf(row),
        lastActivityAt: row.last_activity_at.toISOString(),
        hasPendingApproval: row.approval_id !== null,
        pendingApproval:
          row.approval_id === null
            ? null
            : {
                description: assertDescriptionShape(row.approval_description),
                sourceKind: row.approval_generic_operation === true ? "genericOperation" : "mcpInvoke",
              },
        heartbeat: heartbeatOf(row, projectNames),
        subject:
          row.subject_inbox_item_id === null
            ? null
            : mapSempThreadSubject(
                { inboxItemId: row.subject_inbox_item_id, proposalId: row.subject_proposal_id },
                row.subject_exists,
              ),
      };
    }),
    nextCursor:
      rows.length > input.limit && last ? encodeCursor({ lastActivityAt: last.activity_cursor, id: last.id }) : null,
  };
}
