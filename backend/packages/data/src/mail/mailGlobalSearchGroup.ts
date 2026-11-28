import type { PoolClient } from "pg";
import type { SearchMailResult } from "@alldots/shared";
import { listUnreadableDatabaseIds } from "../agentGrants/agentDatabaseAccess.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { buildItemSearchQuery } from "../search/itemSearchQuery.js";
import type { ThreadSearchGroup, ThreadSearchPage } from "../search/searchGroupRegistry.js";
import { buildSearchSnippetSql } from "../search/searchSnippet.js";
import { htmlToPlainText } from "./mailPlainText.js";
import {
  hasInvalidMailSearchDate,
  MAIL_SEARCH_MESSAGES_CTE,
  mailThreadCopyCtes,
  parseMailThreadListCursor,
} from "./mailThreadListQuery.js";
import { matchesSearch } from "./mailThreadPredicates.js";
import { parseMailSearchQuery, type ParsedMailSearchQuery } from "./search.js";

// The `mail` group of global search: one entry per matching thread. Matching is the thread list's `matchesSearch`, so
// the text and operators mean what they mean in `GET /api/mail/threads?q=`.

const emptyPage = (): ThreadSearchPage => ({ total: 0, items: [], nextCursor: null });

/** The contract of `SearchOutputSchema`. */
const SNIPPET_MAX_CHARS = 160;

/** Bodies are unbounded; only this much of each is read to build an excerpt. */
const SNIPPET_SOURCE_MAX_CHARS = 200_000;

/**
 * Bounds how many messages per thread (newest first) are read as excerpt candidates. Only a word found in markup but
 * not in the plain text (`style`, `href`) fails the second test, so the first candidate wins in practice.
 */
const SNIPPET_CANDIDATES_PER_THREAD = 5;

/** The thread list's `lastMessageAt` and cursor format: UTC with microseconds. */
const INSTANT_SQL = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

interface EmailsDatabaseDbRow {
  id: string;
  database_key: string;
}

interface CountDbRow {
  total: number;
}

interface ThreadDbRow {
  thread_id: string;
  item_id: string;
  subject: string;
  last_message_at: string;
  sender_name: string;
  sender_address: string;
  person_id: string | null;
  person_database_id: string | null;
  preview_text: string | null;
}

interface SnippetSourceDbRow {
  thread_id: string;
  body: string | null;
}

interface SnippetDbRow {
  ordinal: number;
  thread_id: string;
  snippet: string | null;
}

/**
 * `has:` with a value other than `attachment` is removed and is no condition; `matchesSearch` of such a query would
 * match every message.
 */
function hasNoCondition(search: ParsedMailSearchQuery): boolean {
  return (
    search.freeText === "" &&
    search.from === undefined &&
    search.hasAttachment === undefined &&
    search.before === undefined &&
    search.after === undefined &&
    search.read === undefined &&
    search.flagged === undefined
  );
}

/** Splits by code points, so a result never ends in half a surrogate pair. */
function toSnippet(text: string | null): string | null {
  const collapsed = (text ?? "").replace(/\s+/g, " ").trim();
  if (collapsed === "") return null;
  return Array.from(collapsed).slice(0, SNIPPET_MAX_CHARS).join("");
}

/**
 * `matched` is one row per matching thread: its last message (newest live copy, drafts left out as the list does).
 * A thread qualifies when it has a message outside Junk and Trash and any live message satisfies the search. `$1`,
 * the copy CTEs' thread filter, is always null here.
 */
function matchedThreadsSql(searchSql: string): string {
  return `WITH ${mailThreadCopyCtes(1)}, ${MAIL_SEARCH_MESSAGES_CTE}, latest AS (
  SELECT DISTINCT ON (c.thread_id) c.thread_id, c.item_id, c.subject, c.envelope, c.preview_text, c.activity
  FROM copies c ORDER BY c.thread_id, c.activity DESC NULLS LAST, c.item_id DESC
), matched AS (
  SELECT l.* FROM latest l
  WHERE EXISTS (SELECT 1 FROM copies c WHERE c.thread_id = l.thread_id AND c.has_non_junk)
    AND ${searchSql}
)`;
}

/**
 * The Emails database unless archived or unreadable to the actor, and the databases the actor may not read (the
 * sender part must not link into them). A person has none unreadable.
 */
async function readableEmailsDatabase(
  client: PoolClient,
  agentProjectItemId: string | undefined,
): Promise<{ emails: EmailsDatabaseDbRow; unreadable: ReadonlySet<string> } | null> {
  const { rows } = await client.query<EmailsDatabaseDbRow>(
    `SELECT d.id, COALESCE(d.key, d.owner_module_id) AS database_key
     FROM databases d WHERE d.owner_module_id = $1 AND d.system AND d.archived_at IS NULL`,
    [EMAILS_MODULE_ID],
  );
  const emails = rows[0];
  if (emails === undefined) return null;
  if (agentProjectItemId === undefined) return { emails, unreadable: new Set() };
  const unreadable = await listUnreadableDatabaseIds(client, agentProjectItemId);
  return unreadable.has(emails.id) ? null : { emails, unreadable };
}

/**
 * The excerpt of each thread, from the newest live message whose body itself contains the words; a match only via
 * subject, sender or attachment is no source. Candidates are bodies holding the words as stored, converted to plain
 * text and checked again. A thread without such a message has no entry.
 */
async function readMatchingFragments(
  client: PoolClient,
  emailsDatabaseId: string,
  threadIds: readonly string[],
  freeText: string,
): Promise<Map<string, string>> {
  const tsquery = buildItemSearchQuery(freeText, 5);
  if (tsquery.params.length === 0) return new Map();
  const { rows: sources } = await client.query<SnippetSourceDbRow>(
    `SELECT ranked.thread_id, ranked.body FROM (
       SELECT c.thread_id, c.body,
         row_number() OVER (PARTITION BY c.thread_id ORDER BY c.at DESC NULLS LAST, c.item_id DESC) AS candidate_rank
       FROM (
         SELECT m.thread_id, m.item_id, left(i.properties->>'body', $3) AS body,
           COALESCE(NULLIF(i.properties->>'date', '')::timestamptz, m.ingested_at, i.updated_at) AS at
         FROM mail_message_meta m
         JOIN items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id AND i.database_id = $2::uuid AND i.deleted_at IS NULL
         JOIN item_search_index s ON s.tenant_id = m.tenant_id AND s.item_id = m.item_id AND s.database_id = $2::uuid
         WHERE m.tenant_id = app_tenant_default() AND m.thread_id = ANY($1::uuid[]) AND s.search_vector @@ ${tsquery.sql}
       ) c
       WHERE c.body IS NOT NULL AND (to_tsvector('czech', c.body) || to_tsvector('czech_simple', c.body)) @@ ${tsquery.sql}
     ) ranked
     WHERE ranked.candidate_rank <= $4
     ORDER BY ranked.thread_id, ranked.candidate_rank`,
    [[...threadIds], emailsDatabaseId, SNIPPET_SOURCE_MAX_CHARS, SNIPPET_CANDIDATES_PER_THREAD, ...tsquery.params],
  );
  const texts = sources.flatMap((row) =>
    row.body === null ? [] : [{ id: row.thread_id, text: htmlToPlainText(row.body) }],
  );
  if (texts.length === 0) return new Map();
  const excerptQuery = buildItemSearchQuery(freeText, 3);
  const { rows } = await client.query<SnippetDbRow>(
    `SELECT t.ordinal::int AS ordinal, t.thread_id, ${buildSearchSnippetSql(excerptQuery, 3)} AS snippet
     FROM unnest($1::uuid[], $2::text[]) WITH ORDINALITY AS t(thread_id, body, ordinal)
     ORDER BY t.ordinal`,
    [texts.map((entry) => entry.id), texts.map((entry) => entry.text), ...excerptQuery.params],
  );
  const fragments = new Map<string, string>();
  for (const row of rows) {
    if (fragments.has(row.thread_id)) continue;
    const snippet = toSnippet(row.snippet);
    if (snippet !== null) fragments.set(row.thread_id, snippet);
  }
  return fragments;
}

/** One page of matching threads in the thread list's order, with the real `total`. Read-only. */
async function searchMailThreads(
  client: PoolClient,
  emails: EmailsDatabaseDbRow,
  unreadableDatabaseIds: ReadonlySet<string>,
  search: ParsedMailSearchQuery,
  limit: number,
  cursor: { at: string; id: string } | undefined,
): Promise<ThreadSearchPage> {
  const counting = matchesSearch(search, 2);
  const { rows: counted } = await client.query<CountDbRow>(
    `${matchedThreadsSql(counting.sql)} SELECT count(*)::int AS total FROM matched`,
    [null, ...counting.params],
  );
  const total = counted[0]?.total ?? 0;
  if (total === 0) return emptyPage();

  const paging = matchesSearch(search, 5);
  const { rows } = await client.query<ThreadDbRow>(
    `${matchedThreadsSql(paging.sql)}
     SELECT m.thread_id, m.item_id, ts.subject, to_char(m.activity AT TIME ZONE 'UTC', ${INSTANT_SQL}) AS last_message_at,
       COALESCE(m.envelope->'from'->>'name', '') AS sender_name, COALESCE(m.envelope->'from'->>'address', '') AS sender_address,
       person.id AS person_id, person.database_id AS person_database_id, m.preview_text
     FROM matched m
     JOIN thread_subject ts ON ts.thread_id = m.thread_id
     LEFT JOIN person_email_index pei ON pei.tenant_id = app_tenant_default()
       AND pei.email = lower(btrim(m.envelope->'from'->>'address', E' \\t\\n\\r'))
     LEFT JOIN items person ON person.tenant_id = app_tenant_default() AND person.id = pei.item_id AND person.deleted_at IS NULL
       AND person.database_id = (SELECT people FROM schema_ids)
     WHERE $2::timestamptz IS NULL OR (m.activity, m.thread_id) < ($2::timestamptz, $3::uuid)
     ORDER BY m.activity DESC NULLS LAST, m.thread_id DESC
     LIMIT $4`,
    [null, cursor?.at ?? null, cursor?.id ?? null, limit + 1, ...paging.params],
  );
  const page = rows.slice(0, limit);
  const fragments = await readMatchingFragments(
    client,
    emails.id,
    page.map((row) => row.thread_id),
    search.freeText,
  );
  const items = page.map((row): SearchMailResult => {
    const senderName = row.sender_name === "" ? row.sender_address : row.sender_name;
    return {
      threadId: row.thread_id,
      itemId: row.item_id,
      databaseId: emails.id,
      databaseKey: emails.database_key,
      title: row.subject,
      subtitleParts: [
        ...(senderName === ""
          ? []
          : [
              {
                kind: "sender" as const,
                value: senderName,
                ...(row.person_id === null ||
                (row.person_database_id !== null && unreadableDatabaseIds.has(row.person_database_id))
                  ? {}
                  : { itemId: row.person_id }),
              },
            ]),
        { kind: "date" as const, value: row.last_message_at },
      ],
      snippet: fragments.get(row.thread_id) ?? toSnippet(row.preview_text),
    };
  });
  const lastListed = rows.length > limit ? page[page.length - 1] : undefined;
  return {
    total,
    items,
    nextCursor:
      lastListed === undefined
        ? null
        : Buffer.from(JSON.stringify({ at: lastListed.last_message_at, id: lastListed.thread_id })).toString(
            "base64url",
          ),
  };
}

/**
 * The text is parsed as the thread list parses `q`. A query with no condition, and a `before:`/`after:` that is not
 * an ISO date, match nothing here where the thread list answers 400: a search over every group must not fail for one
 * group's operator. Agent runs get the group only when their project may read Emails; an archived Emails database
 * gives an empty group.
 *
 * An entry is one thread, represented by its last message. `snippet` falls back to the last message's preview. The
 * sender links to its People item only when the actor may read People.
 */
export const mailGlobalSearchGroup: ThreadSearchGroup = {
  type: "mail",
  prepare(cursor) {
    const parsedCursor = cursor === undefined ? undefined : parseMailThreadListCursor(cursor);
    return async (client, request) => {
      const search = parseMailSearchQuery(request.q, true);
      if (search.contradictory === true || hasNoCondition(search) || hasInvalidMailSearchDate(search)) {
        return emptyPage();
      }
      const readable = await readableEmailsDatabase(client, request.agentProjectItemId);
      if (readable === null) return emptyPage();
      return searchMailThreads(client, readable.emails, readable.unreadable, search, request.limit, parsedCursor);
    };
  },
};
