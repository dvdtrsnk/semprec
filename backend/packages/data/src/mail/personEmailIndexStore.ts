import type { PoolClient } from "pg";
import { z } from "zod";
import type { Queryable } from "../db/pool.js";
import { touchMailThreads } from "./mailThreadChanges.js";

export function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** RLS confines reads to the tenant; within one tenant an address never belongs to two people. */
export async function lookupPersonIdByEmail(client: Queryable, address: string): Promise<string | null> {
  const { rows } = await client.query<{ item_id: string }>(`SELECT item_id FROM person_email_index WHERE email = $1`, [
    normalizeEmailAddress(address),
  ]);
  return rows[0]?.item_id ?? null;
}

export interface ReindexPersonEmailsResult {
  /** Addresses already mapped to a different Person: the first writer keeps them. */
  conflicts: string[];
}

/**
 * Releases addresses the Person no longer claims and claims new ones not owned by someone else. The
 * tenant-leading primary key `(tenant_id, email)` enforces uniqueness; the claim's targetless
 * `ON CONFLICT DO NOTHING` lets two concurrent claims leave the first writer's row without rejecting.
 */
export async function reindexPersonEmails(
  client: PoolClient,
  personItemId: string,
  addresses: string[],
): Promise<ReindexPersonEmailsResult> {
  const { conflicts } = await reindexPersonEmailsWithClaims(client, personItemId, addresses);
  return { conflicts };
}

/** Stamps the thread list rows of the messages from every address it released or claimed (their sender person). */
export async function reindexPersonEmailsWithClaims(
  client: PoolClient,
  personItemId: string,
  addresses: string[],
): Promise<ReindexPersonEmailsResult & { claimed: string[] }> {
  const normalized = [...new Set(addresses.map(normalizeEmailAddress).filter((a) => a.length > 0))];

  const { rows: existing } = await client.query<{ email: string; item_id: string }>(
    `SELECT email, item_id FROM person_email_index WHERE email = ANY($1::text[])`,
    [normalized],
  );
  const ownedByOther = new Set(existing.filter((row) => row.item_id !== personItemId).map((row) => row.email));
  const toClaim = normalized.filter((email) => !ownedByOther.has(email));

  const released = await client.query<{ email: string }>(
    `DELETE FROM person_email_index WHERE item_id = $1 AND email != ALL($2::text[]) RETURNING email`,
    [personItemId, normalized],
  );

  const claimed: string[] = [];
  if (toClaim.length > 0) {
    const { rows } = await client.query<{ email: string }>(
      `INSERT INTO person_email_index (email, item_id) SELECT unnest($1::text[]), $2 ON CONFLICT DO NOTHING RETURNING email`,
      [toClaim, personItemId],
    );
    claimed.push(...rows.map((row) => row.email));
  }

  const changed = [...(released.rowCount === 0 ? [] : released.rows.map((row) => row.email)), ...claimed];
  if (changed.length > 0) {
    const { rows } = await client.query<{ thread_id: unknown }>(
      `SELECT DISTINCT thread_id FROM mail_message_meta
       WHERE tenant_id = app_tenant_default() AND thread_id IS NOT NULL
         AND lower(btrim(envelope->'from'->>'address', E' \\t\\n\\r')) = ANY($1::text[])`,
      [changed],
    );
    touchMailThreads(
      client,
      rows.map((row) => z.uuid().parse(row.thread_id)),
    );
  }
  return { conflicts: [...ownedByOther], claimed };
}

export interface MailContact {
  personId: string;
  name: string;
  email: string;
  relationship: string | null;
}

/**
 * `query` is folded with `unaccent` before `\`, `%` and `_` are escaped, because folding itself can
 * produce those characters (e.g. `%` from a fullwidth percent sign). A text that folds to nothing
 * returns no contacts.
 */
export async function searchMailContacts(
  client: Queryable,
  query: string,
  exclude: string[],
  limit: number,
): Promise<MailContact[]> {
  const { rows } = await client.query<MailContact>(
    String.raw`
    WITH needle AS MATERIALIZED (
      SELECT '%' || replace(replace(replace(folded.text, '\', '\\'), '%', '\%'), '_', '\_') || '%' AS pattern
      FROM (SELECT unaccent($1::text) AS text) folded
      WHERE folded.text <> ''
    ), own_addresses AS (
      SELECT lower(btrim(a.address, E' \t\n\r')) AS email
      FROM items m JOIN databases d ON d.id = m.database_id AND d.owner_module_id = 'mailboxes'
      CROSS JOIN LATERAL regexp_split_to_table(CASE WHEN jsonb_typeof(m.properties->'addresses') = 'string'
        THEN m.properties->>'addresses' ELSE '' END, E'[,\n\r]+') a(address)
      WHERE m.deleted_at IS NULL
    ), contacts AS (
      SELECT DISTINCT p.id AS "personId", COALESCE(p.properties->>'name', '') AS name,
        lower(btrim(a.address, E' \t\n\r')) AS email,
        CASE WHEN jsonb_typeof(p.properties->'relationship') = 'string' THEN p.properties->>'relationship' ELSE NULL END AS relationship
      FROM items p JOIN databases d ON d.id = p.database_id AND d.owner_module_id = 'people'
      CROSS JOIN needle
      CROSS JOIN LATERAL regexp_split_to_table(CASE WHEN jsonb_typeof(p.properties->'emails') = 'string'
        THEN p.properties->>'emails' ELSE '' END, E'[,\n\r]+') a(address)
      WHERE p.deleted_at IS NULL
        AND (unaccent(COALESCE(p.properties->>'name', '')) ILIKE needle.pattern ESCAPE '\'
          OR unaccent(btrim(a.address, E' \t\n\r')) ILIKE needle.pattern ESCAPE '\')
    )
    SELECT "personId", name, email, relationship FROM contacts c
    WHERE email <> '' AND email <> ALL($2::text[])
      AND NOT EXISTS (SELECT 1 FROM own_addresses o WHERE o.email = c.email)
    ORDER BY name, email, "personId" LIMIT $3`,
    [query, [...new Set(exclude.map(normalizeEmailAddress))], limit],
  );
  return rows;
}
