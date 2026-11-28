import type { PoolClient } from "pg";
import { stripMarkdown } from "@alldots/block-model";
import { loadModuleCatalogs, resolveCatalogLabel } from "@alldots/module-registry";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { ValidationError } from "../errors.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { assertDescriptionShape, type ApprovalDescription } from "../mcp/approvalRequestsStore.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { buildSempThreadMessageSearch } from "./sempMessageSearch.js";

export const SEMP_THREAD_KINDS = ["chat", "item", "tick"] as const;
export type SempThreadKind = (typeof SEMP_THREAD_KINDS)[number];

/** Item thread title template key; `{itemName}` is the Inbox item's text. */
const ITEM_TITLE_KEY = "semp.thread.itemTitle";

const PREVIEW_CODE_POINTS = 140;

/** Code points read for a preview: more than shown, because Markdown syntax is removed before the cut. */
const PREVIEW_SOURCE_CODE_POINTS = 1000;

/** First bind parameter after the nine fixed ones. */
const FIRST_SEARCH_PARAMETER = 10;

export interface SempThreadTitleParts {
  kind: SempThreadKind;
  title: string | null;
  heartbeatName: string | null;
  /** Null when the item is trashed or gone. */
  subjectText: string | null;
}

/**
 * The Semp thread title rule for `locale`, shared by every read that names a thread. Chat: the stored title
 * (null until generated). Tick: the heartbeat's current name. Item: the `semp.thread.itemTitle` template with the
 * Inbox item's current text, or no title without one. Nothing is stored. The text is user content, so it is
 * inserted through a replacer function and `$` is not a replacement pattern.
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

export interface SempThreadSubject {
  inboxItemId: string;
  /** Null when no proposal card was named at creation. */
  proposalId: string | null;
  /** False when the Inbox item is in the trash or gone. */
  exists: boolean;
}

/** `exists` is read live by the caller in the same request. */
export function mapSempThreadSubject(
  stored: { inboxItemId: string; proposalId: string | null },
  exists: boolean,
): SempThreadSubject {
  return { inboxItemId: stored.inboxItemId, proposalId: stored.proposalId, exists };
}

/** The last row's `last_activity_at` with microseconds, and its id. */
export interface SempThreadListCursor {
  lastActivityAt: string;
  id: string;
}

const CURSOR_SHAPE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function encodeCursor(cursor: SempThreadListCursor): string {
  return Buffer.from(`${cursor.lastActivityAt}|${cursor.id}`).toString("base64url");
}

/** Malformed cursors and instants Postgres refuses as `timestamptz` (invalid, year zero) are a `ValidationError`. */
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

export interface SempThreadSystemPreview {
  key: string;
  params: unknown;
}

const PENDING_APPROVAL_SOURCE_KINDS = ["genericOperation", "mcpInvoke", "moduleTool"] as const;

export interface SempThreadPendingApproval {
  description: ApprovalDescription | null;
  /** A generic operation, an outside MCP tool call, or a module agent tool. */
  sourceKind: (typeof PENDING_APPROVAL_SOURCE_KINDS)[number];
}

/** `projectName` is null when the project item is unnamed, trashed or gone. */
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
  /** Null when no message has text or a system key yet. */
  preview: string | SempThreadSystemPreview | null;
  lastActivityAt: string;
  hasPendingApproval: boolean;
  pendingApproval: SempThreadPendingApproval | null;
  heartbeat: SempThreadListHeartbeat | null;
  subject: SempThreadSubject | null;
}

export interface ListSempThreadsInput {
  kinds: readonly SempThreadKind[];
  subjectInboxItemId: string | null;
  /**
   * Case- and diacritic-insensitive text filter (see `listSempThreads`). Null, or a text that folding leaves empty,
   * is no filter.
   */
  search: string | null;
  cursor: SempThreadListCursor | null;
  limit: number;
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
  approval_source_kind: string | null;
}

/** Null unless the Inbox item's `text` is a JSON string. */
const SUBJECT_TEXT_SQL = `CASE WHEN jsonb_typeof(subject.properties -> 'text') = 'string'
                 THEN subject.properties ->> 'text' END`;

/** System messages give key and params; text is reduced to plain text and cut with an ellipsis. */
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
 * One page of the tenant's Semp threads, newest activity first (`last_activity_at DESC, id DESC`). Runs in the
 * caller's tenant scope under RLS; titles, heartbeats and `subject.exists` are read live and no row is written.
 *
 * The preview is the last message with text or a system key, so a queued, running or failed reply does not
 * blank the row. The pending approval is the newest one of a run with this `thread_id`; a delegated run carries
 * its parent's thread id.
 *
 * `search` matches, before the page is cut, when any of three rules does:
 * - substring (`unaccent` + `ILIKE`) of what the title is resolved from;
 * - substring of the first 140 code points of the previewed message's stored text. That text still has its
 *   Markdown, so syntax can match and words the preview shows near its end may fall outside the window;
 * - every word (as `buildItemSearchQuery` splits it) found by lemma or prefix in the search vector of some
 *   non-system message, across one or several messages.
 *
 * The pattern is built in SQL from the bound text: folded with `unaccent` first, then `\`, `%` and `_` escaped,
 * in that order because folding can produce them (e.g. a fullwidth percent sign).
 */
export async function listSempThreads(
  client: PoolClient,
  input: ListSempThreadsInput,
): Promise<{ rows: SempThreadListRow[]; nextCursor: string | null }> {
  const inbox = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
  const messageSearch =
    input.search === null ? null : buildSempThreadMessageSearch(input.search, FIRST_SEARCH_PARAMETER);
  const { rows } = await client.query<ThreadListDbRow>(
    `WITH pending AS (
       SELECT DISTINCT ON (r.thread_id) r.tenant_id, r.thread_id, a.id, a.description,
              CASE WHEN a.payload ? 'operationName' THEN 'genericOperation'
                   WHEN a.payload ? 'moduleToolName' OR a.payload ? 'draftHash' THEN 'moduleTool'
                   ELSE 'mcpInvoke' END AS source_kind
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
            pending.source_kind AS approval_source_kind
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
             OR unaccent(left(last_message.text, $9::int)) ILIKE needle.pattern ESCAPE '\\'
             ${messageSearch === null ? "" : `OR (t.tenant_id, t.id) IN (${messageSearch.sql})`})
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
      ...(messageSearch?.params ?? []),
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
          row.approval_source_kind === null
            ? null
            : {
                description: assertDescriptionShape(row.approval_description),
                sourceKind: assertKnownValue(
                  PENDING_APPROVAL_SOURCE_KINDS,
                  row.approval_source_kind,
                  "pending approval source kind",
                ),
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
