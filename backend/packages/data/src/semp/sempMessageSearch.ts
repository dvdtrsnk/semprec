import type { PoolClient } from "pg";
import { z } from "zod";
import { currentTenantScope } from "@semprec/shared";
import { requireManagedTransaction } from "../db/pool.js";
import { buildItemSearchQuery } from "../search/itemSearchQuery.js";

/**
 * Code points of a message the search vector covers. Postgres refuses a tsvector over 1 MiB, and message length
 * is unbounded, so without this a long pasted log would make the storing statement fail. 50,000 leaves ample room
 * even for one-letter words and several Hunspell lemmas per word. The text itself is stored whole.
 */
export const SEMP_MESSAGE_SEARCH_MAX_CODE_POINTS = 50_000;

/**
 * SQL for `semp_messages.search_vector` of `textSql`: one combined `czech` + `czech_simple` vector (the shape of
 * `item_search_index.search_vector`) over the bounded prefix; NULL text gives NULL. Every writer of message text,
 * and the backfill, uses it in the statement writing the text. `textSql` is a fixed fragment, never caller input.
 */
export function sempMessageSearchVectorSql(textSql: string): string {
  const indexed = `left(${textSql}, ${SEMP_MESSAGE_SEARCH_MAX_CODE_POINTS})`;
  return `to_tsvector('czech', ${indexed}) || to_tsvector('czech_simple', ${indexed})`;
}

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
 * Recomputes the vector of up to `limit` non-system messages with text after `afterMessageId` (in `id` order)
 * and returns the last processed id, or null when done. The vector is computed from the stored text under a row
 * lock, so a concurrent text update is not overwritten with a stale vector. `updated_at` is not touched.
 *
 * Operator-run, not scheduled: with `onlyMissing: true` after adding the column, and with `false` after
 * activating Hunspell, since stored vectors keep the lemmas of the configuration that made them.
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
 * Subquery of the `(tenant_id, thread_id)` pairs of threads whose non-system messages together contain every
 * `buildItemSearchQuery` term (lemma or prefix), bound in order from `firstParameter`. Null without terms.
 *
 * One message cannot carry the AND when words are spread over messages, so it reads messages matching any term
 * (GIN-indexable) and keeps threads covering all terms. Messages are read through RLS.
 */
export function buildSempThreadMessageSearch(
  text: string,
  firstParameter: number,
): { sql: string; params: string[] } | null {
  const { params } = buildItemSearchQuery(text, firstParameter);
  if (params.length === 0) return null;
  // The piece's SQL depends only on its bind position, so a fixed word stands in for the term and the builder
  // makes exactly one parameter.
  const pieces = params.map((_, index) => buildItemSearchQuery("term", firstParameter + index).sql);
  const anyTerm = pieces.join(" || ");
  const everyTerm = pieces.map((piece) => `bool_or(sm.search_vector @@ ${piece})`).join(" AND ");
  const sql = `SELECT sm.tenant_id, sm.thread_id FROM semp_messages sm
      WHERE sm.system_key IS NULL AND sm.search_vector @@ (${anyTerm})
      GROUP BY sm.tenant_id, sm.thread_id
     HAVING ${everyTerm}`;
  return { sql, params };
}
