import type { Queryable } from "../db/pool.js";

export function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

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
 * `email PRIMARY KEY` on `person_email_index` is what makes "owned by a different Person" a
 * real, enforced fact here rather than a race-prone read-then-write.
 */
export async function reindexPersonEmails(client: Queryable, personItemId: string, addresses: string[]): Promise<ReindexPersonEmailsResult> {
  const normalized = [...new Set(addresses.map(normalizeEmailAddress).filter((a) => a.length > 0))];

  const { rows: existing } = await client.query<{ email: string; item_id: string }>(
    `SELECT email, item_id FROM person_email_index WHERE email = ANY($1::text[])`,
    [normalized],
  );
  const ownedByOther = new Set(existing.filter((row) => row.item_id !== personItemId).map((row) => row.email));
  const toClaim = normalized.filter((email) => !ownedByOther.has(email));

  await client.query(`DELETE FROM person_email_index WHERE item_id = $1 AND email != ALL($2::text[])`, [personItemId, normalized]);

  if (toClaim.length > 0) {
    await client.query(
      `INSERT INTO person_email_index (email, item_id) SELECT unnest($1::text[]), $2 ON CONFLICT (email) DO NOTHING`,
      [toClaim, personItemId],
    );
  }

  return { conflicts: [...ownedByOther] };
}
