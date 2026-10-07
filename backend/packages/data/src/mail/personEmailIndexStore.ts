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
 * tenant-leading unique index `person_email_index_tenant_email_uq`, not by the global primary
 * key, which makes it a real fact rather than a race-prone read-then-write. The claim uses
 * `ON CONFLICT DO NOTHING` with no target so every unique index arbitrates: two concurrent
 * claims of one address leave the first writer's row and neither rejects.
 */
export async function reindexPersonEmails(
  client: Queryable,
  personItemId: string,
  addresses: string[],
): Promise<ReindexPersonEmailsResult> {
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

  if (toClaim.length > 0) {
    await client.query(
      `INSERT INTO person_email_index (email, item_id) SELECT unnest($1::text[]), $2 ON CONFLICT DO NOTHING`,
      [toClaim, personItemId],
    );
  }

  return { conflicts: [...ownedByOther] };
}
