import type { PoolClient } from "pg";
import type { SearchThreadResult } from "@semprec/shared";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { getCalendarClock } from "../calendarTime.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import {
  loadSempThreadTitleResolver,
  parseSempThreadListCursor,
  SEMP_THREAD_KINDS,
  type SempThreadListCursor,
} from "../semp/sempThreadsListStore.js";
import type { ThreadSearchGroup } from "./searchGroupRegistry.js";

// The `chat` global-search group: Semp threads by title or preview. Threads have no `item_search_index` row; the
// query is applied to each thread's two short texts on the fly, which is cheap because a user has few threads.

/** As the thread list shows by default; tick threads are hidden there, so search hides them too. */
const SEARCHED_KINDS: readonly string[] = ["chat", "item"];

/** The thread list's preview window, in code points. */
const PREVIEW_CODE_POINTS = 140;

/**
 * An item thread's title is unbounded Inbox text, and Postgres refuses a tsvector above 1 MiB, which would fail the
 * whole search.
 */
const TITLE_SEARCH_MAX_CODE_POINTS = 1000;

/** Null unless a JSON string; the same rule as the thread list. */
const SUBJECT_TEXT_SQL = `CASE WHEN jsonb_typeof(subject.properties -> 'text') = 'string'
                 THEN subject.properties ->> 'text' END`;

/** The `users.locale` column default, for a tenant without a bound user. */
const FALLBACK_LOCALE = "cs";

/** `buildQuery(n)` numbers the parameters from `$n`. */
export type ThreadSearchQueryBuilder = (firstParameter: number) => { sql: string; params: string[] };

export interface SempThreadSearchInput {
  buildQuery: ThreadSearchQueryBuilder;
  limit: number;
  /** Already parsed by `parseSempThreadListCursor`. */
  cursor?: SempThreadListCursor;
}

export interface SempThreadSearchPage {
  total: number;
  items: SearchThreadResult[];
  nextCursor: string | null;
}

interface ThreadMatchDbRow {
  id: string;
  kind: string;
  title: string | null;
  subject_text: string | null;
  last_activity_at: Date;
  activity_cursor: string;
}

interface CountDbRow {
  total: number;
}

function vectorMatches(textSql: string, tsquerySql: string): string {
  return `(to_tsvector('czech', coalesce(${textSql}, '')) || to_tsvector('czech_simple', coalesce(${textSql}, ''))) @@ ${tsquerySql}`;
}

/**
 * `$1` is the searched kinds, `$2` the Inbox database id (an item thread reads its subject). Only tenant tables are
 * read, so only the caller's tenant is seen.
 */
function matchingThreadsSql(tsquerySql: string): string {
  return `FROM semp_threads t
     LEFT JOIN items subject ON subject.tenant_id = t.tenant_id AND subject.database_id = $2::uuid
            AND subject.id = t.subject_inbox_item_id AND subject.deleted_at IS NULL
     LEFT JOIN LATERAL (
       SELECT left(m.text, ${PREVIEW_CODE_POINTS}) AS text
         FROM semp_messages m
        WHERE m.tenant_id = t.tenant_id AND m.thread_id = t.id
          AND (m.text IS NOT NULL OR m.system_key IS NOT NULL)
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
     ) last_message ON true
     CROSS JOIN LATERAL (
       SELECT left(CASE t.kind WHEN 'chat' THEN t.title ELSE ${SUBJECT_TEXT_SQL} END, ${TITLE_SEARCH_MAX_CODE_POINTS}) AS text
     ) searched_title
     WHERE t.kind = ANY($1::text[])
       AND (${vectorMatches("searched_title.text", tsquerySql)} OR ${vectorMatches("last_message.text", tsquerySql)})`;
}

/**
 * One page of matching chat and Inbox item threads, newest activity first, with the real `total`, in the caller's
 * transaction. The caller ensures a searchable word and parses the cursor (so a malformed token is refused even when
 * this group is not searched). Titles resolve as in the thread list; `snippet` is `null`.
 */
export async function searchSempThreads(
  client: PoolClient,
  input: SempThreadSearchInput,
): Promise<SempThreadSearchPage> {
  const cursor = input.cursor ?? null;
  const inbox = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
  const inboxId = inbox?.id ?? null;
  const countQuery = input.buildQuery(3);
  const { rows: counted } = await client.query<CountDbRow>(
    `SELECT count(*)::int AS total ${matchingThreadsSql(countQuery.sql)}`,
    [[...SEARCHED_KINDS], inboxId, ...countQuery.params],
  );
  const total = counted[0]?.total ?? 0;
  if (total === 0) return { total, items: [], nextCursor: null };

  const pageQuery = input.buildQuery(6);
  const { rows } = await client.query<ThreadMatchDbRow>(
    `SELECT t.id, t.kind, t.title, ${SUBJECT_TEXT_SQL} AS subject_text, t.last_activity_at,
            to_char(t.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activity_cursor
     ${matchingThreadsSql(pageQuery.sql)}
       AND ($3::timestamptz IS NULL OR (t.last_activity_at, t.id) < ($3::timestamptz, $4::uuid))
     ORDER BY t.last_activity_at DESC, t.id DESC
     LIMIT $5`,
    [
      [...SEARCHED_KINDS],
      inboxId,
      cursor?.lastActivityAt ?? null,
      cursor?.id ?? null,
      input.limit + 1,
      ...pageQuery.params,
    ],
  );
  const page = rows.slice(0, input.limit);
  if (page.length === 0) return { total, items: [], nextCursor: null };

  const resolveTitle = await loadSempThreadTitleResolver((await getTenantUserLocale(client)) ?? FALLBACK_LOCALE);
  const clock = await getCalendarClock(client);
  const items = page.map((row): SearchThreadResult => {
    const activity = clock.instantToWallClock(row.last_activity_at);
    return {
      threadId: row.id,
      title:
        resolveTitle({
          kind: assertKnownValue(SEMP_THREAD_KINDS, row.kind, "thread kind"),
          title: row.title,
          heartbeatName: null,
          subjectText: row.subject_text,
        }) ?? "",
      subtitleParts: [
        { kind: "date", value: activity.date },
        { kind: "time", value: activity.time },
      ],
      snippet: null,
    };
  });
  const lastListed = rows.length > input.limit ? page[page.length - 1] : undefined;
  return {
    total,
    items,
    nextCursor:
      lastListed === undefined
        ? null
        : Buffer.from(`${lastListed.activity_cursor}|${lastListed.id}`).toString("base64url"),
  };
}

/**
 * Searches for a person only: Semp conversations belong to the user and are part of no database an agent or MCP
 * client is granted, so any other actor gets an empty page and nothing is read.
 */
export const sempThreadSearchGroup: ThreadSearchGroup = {
  type: "chat",
  prepare(cursor) {
    const parsed = cursor === undefined ? undefined : parseSempThreadListCursor(cursor);
    return async (client, request) =>
      request.humanActor
        ? searchSempThreads(client, { buildQuery: request.buildQuery, limit: request.limit, cursor: parsed })
        : { total: 0, items: [], nextCursor: null };
  },
};
