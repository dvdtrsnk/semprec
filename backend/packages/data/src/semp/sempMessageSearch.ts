import type { PoolClient } from "pg";
import { z } from "zod";
import { currentTenantScope } from "@semprec/shared";
import { requireManagedTransaction } from "../db/pool.js";
import { buildItemSearchQuery } from "../search/itemSearchQuery.js";

/**
 * How much of a message the search vector covers, in code points counted from the start of the text.
 * Postgres refuses a tsvector whose lexemes and positions take more than 1 MiB ("string is too long
 * for tsvector"), and nothing bounds the length of a message: a pasted log of 900,000 characters
 * made of distinct words is accepted by the send route and exceeds the limit. Without this bound the
 * statement that stores the message would fail with it. A distinct word costs at most about four
 * bytes per input character in each of the two vectors, and about eight in the pathological case of
 * one-letter words, so 50,000 code points stay far below the limit with room for the several lemmas
 * Hunspell can make of one word. The text of a message is stored whole; only the words after this
 * prefix are not searchable.
 */
export const SEMP_MESSAGE_SEARCH_MAX_CODE_POINTS = 50_000;

/**
 * The SQL expression of `semp_messages.search_vector` for the text `textSql`, which is a SQL
 * fragment of type text: one combined vector from the `czech` and `czech_simple` configurations,
 * the same shape as `item_search_index.search_vector`, made of the first
 * `SEMP_MESSAGE_SEARCH_MAX_CODE_POINTS` code points of the text. A NULL text gives a NULL vector,
 * because `left` and the vector functions return NULL for it. Every writer of message text sets the
 * vector with this expression in the statement that writes the text, and the backfill uses it too,
 * so the bound holds for all of them. Callers pass a fixed fragment, such as a parameter placeholder
 * or a column name; no caller input is interpolated, and the bound is a constant of this module.
 */
export function sempMessageSearchVectorSql(textSql: string): string {
  const indexed = `left(${textSql}, ${SEMP_MESSAGE_SEARCH_MAX_CODE_POINTS})`;
  return `to_tsvector('czech', ${indexed}) || to_tsvector('czech_simple', ${indexed})`;
}

/** Largest value of the `int4` that `limit` is bound as. */
const INT4_MAX = 2_147_483_647;

const reindexOptionsSchema = z
  .object({
    limit: z.int().min(1).max(INT4_MAX),
    afterMessageId: z.uuid().optional(),
    onlyMissing: z.boolean(),
  })
  .strict();
export type SempMessageSearchReindexOptions = z.infer<typeof reindexOptionsSchema>;

/**
 * Recomputes the search vector of up to `limit` non-system messages that have text, in `id` order
 * after `afterMessageId`, of the tenant in the caller's scope, and returns the last `id` it processed, or null
 * when no message is left after the cursor. A caller passes the returned id as `afterMessageId`
 * until null comes back. With `onlyMissing`, only messages whose vector is NULL are processed;
 * the rest are left as they are. The vector is computed from the stored text in the statement that
 * writes it, under a row lock, so a concurrent update of the text is not overwritten by a vector of
 * the older text. Runs in the caller's managed transaction; `updated_at` is not touched, because no
 * content changes.
 *
 * An operator runs it with `onlyMissing: true` once after the migration that adds the column, and
 * with `onlyMissing: false` after the Hunspell configuration is activated: the stored vectors keep
 * the lemmas of the configuration that made them until then. Nothing schedules it.
 */
export async function reindexSempMessageSearch(
  client: PoolClient,
  options: SempMessageSearchReindexOptions,
): Promise<string | null> {
  requireManagedTransaction(client);
  const { limit, afterMessageId, onlyMissing } = reindexOptionsSchema.parse(options);
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new Error("Semp message reindexing requires a tenant scope");
  const { rows } = await client.query<{ id: string }>(
    // The vector expression is a fixed SQL fragment; the options are bound parameters.
    `WITH batch AS (
       SELECT id FROM semp_messages
        WHERE tenant_id = $4::uuid AND system_key IS NULL AND text IS NOT NULL
          AND ($1::uuid IS NULL OR id > $1::uuid)
          AND (NOT $2::boolean OR search_vector IS NULL)
        ORDER BY id
        LIMIT $3::int
          FOR UPDATE
     ),
     indexed AS (
       UPDATE semp_messages m SET search_vector = ${sempMessageSearchVectorSql("m.text")}
         FROM batch
        WHERE m.id = batch.id
       RETURNING m.id
     )
     SELECT id FROM indexed ORDER BY id DESC LIMIT 1`,
    [afterMessageId ?? null, onlyMissing, limit, scope.tenantId],
  );
  return rows[0]?.id ?? null;
}

/**
 * The thread-list rule for message text: a subquery of the `(tenant_id, thread_id)` pairs of the
 * threads in which every term of `text` is found in some non-system message, in the same message
 * or in different ones. `firstParameter` is the position of the first bind parameter; the terms are
 * bound from `params` in order, one parameter each, and the text itself is never part of the SQL.
 * Returns null when `text` has no term.
 *
 * The terms are those of `buildItemSearchQuery`, and each is matched by the lemma-or-prefix piece
 * the builder makes for it. A single message cannot carry the AND of the builder's whole query when
 * the words are spread over several messages, so the subquery reads the messages that match any
 * term, a condition the GIN index on `search_vector` can answer, and keeps the threads whose
 * messages cover every term. Messages are read through row-level security, as everywhere.
 */
export function buildSempThreadMessageSearch(
  text: string,
  firstParameter: number,
): { sql: string; params: string[] } | null {
  const { params } = buildItemSearchQuery(text, firstParameter);
  if (params.length === 0) return null;
  // The SQL of the piece for one term depends only on its bind position, never on the term: the
  // builder puts a placeholder where the term goes. A fixed word stands in for the term, so the
  // builder has nothing to normalise and makes exactly one parameter.
  const pieces = params.map((_, index) => buildItemSearchQuery("term", firstParameter + index).sql);
  const anyTerm = pieces.join(" || ");
  const everyTerm = pieces.map((piece) => `bool_or(sm.search_vector @@ ${piece})`).join(" AND ");
  const sql = `SELECT sm.tenant_id, sm.thread_id FROM semp_messages sm
      WHERE sm.system_key IS NULL AND sm.search_vector @@ (${anyTerm})
      GROUP BY sm.tenant_id, sm.thread_id
     HAVING ${everyTerm}`;
  return { sql, params };
}
