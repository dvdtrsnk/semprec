import type { Queryable } from "../db/pool.js";

export function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Resolves a normalized address to the Person that owns it. Reads are confined to the
 * caller's tenant by row-level security, so the same address can belong to different
 * Persons in different tenants; within one tenant an address never belongs to two people.
 */
export async function lookupPersonIdByEmail(client: Queryable, address: string): Promise<string | null> {
  const { rows } = await client.query<{ item_id: string }>(`SELECT item_id FROM person_email_index WHERE email = $1`, [
    normalizeEmailAddress(address),
  ]);
  return rows[0]?.item_id ?? null;
}

export interface ReindexPersonEmailsResult {
  /** Addresses this person's `emails` property lists but that `person_email_index` already maps to a *different* Person — left untouched (first writer keeps the address), not silently reassigned. */
  conflicts: string[];
}

/**
 * Full reindex for one Person from their current `People.emails` value: releases every
 * address this Person no longer claims (frees it for someone else), claims every new one
 * that isn't already owned by a different Person, and reports the ones it couldn't claim.
 * "One address never belongs to two people" holds within a tenant (row-level security
 * confines the reads and the release to the caller's tenant). It is enforced by the
 * tenant-leading primary key `(tenant_id, email)`, which makes it a real fact rather than a
 * race-prone read-then-write. The claim uses
 * `ON CONFLICT DO NOTHING` with no target so every unique index arbitrates: two concurrent
 * claims of one address leave the first writer's row and neither rejects.
 */
export async function reindexPersonEmails(
  client: Queryable,
  personItemId: string,
  addresses: string[],
): Promise<ReindexPersonEmailsResult> {
  const { conflicts } = await reindexPersonEmailsWithClaims(client, personItemId, addresses);
  return { conflicts };
}

export async function reindexPersonEmailsWithClaims(
  client: Queryable,
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

  await client.query(`DELETE FROM person_email_index WHERE item_id = $1 AND email != ALL($2::text[])`, [
    personItemId,
    normalized,
  ]);

  const claimed: string[] = [];
  if (toClaim.length > 0) {
    const { rows } = await client.query<{ email: string }>(
      `INSERT INTO person_email_index (email, item_id) SELECT unnest($1::text[]), $2 ON CONFLICT DO NOTHING RETURNING email`,
      [toClaim, personItemId],
    );
    claimed.push(...rows.map((row) => row.email));
  }

  return { conflicts: [...ownedByOther], claimed };
}

export interface MailContact {
  personId: string;
  name: string;
  email: string;
  relationship: string | null;
}

/** Escapes LIKE metacharacters before surrounding a literal substring with wildcards. */
export function escapeContactSearchPattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, "\\$&")}%`;
}

/** People-only suggestions; every item/database read is confined by the caller's tenant scope. */
export async function searchMailContacts(
  client: Queryable,
  query: string,
  exclude: string[],
  limit: number,
): Promise<MailContact[]> {
  const { rows } = await client.query<MailContact>(
    String.raw`
    WITH own_addresses AS (
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
      CROSS JOIN LATERAL regexp_split_to_table(CASE WHEN jsonb_typeof(p.properties->'emails') = 'string'
        THEN p.properties->>'emails' ELSE '' END, E'[,\n\r]+') a(address)
      WHERE p.deleted_at IS NULL
        AND (unaccent(COALESCE(p.properties->>'name', '')) ILIKE unaccent($1) ESCAPE '\'
          OR unaccent(btrim(a.address, E' \t\n\r')) ILIKE unaccent($1) ESCAPE '\')
    )
    SELECT "personId", name, email, relationship FROM contacts c
    WHERE email <> '' AND email <> ALL($2::text[])
      AND NOT EXISTS (SELECT 1 FROM own_addresses o WHERE o.email = c.email)
    ORDER BY name, email, "personId" LIMIT $3`,
    [escapeContactSearchPattern(query), [...new Set(exclude.map(normalizeEmailAddress))], limit],
  );
  return rows;
}
