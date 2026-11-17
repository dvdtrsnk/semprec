import type { Queryable } from "../db/pool.js";
import { COMPANIES_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * `ico` is the eight-digit form; stored values are normalized the same way (whitespace removed, zero-padded) and a
 * stored value that is not 1-8 digits matches nothing. No check digit or name comparison. Trashed items and archived
 * databases are excluded; duplicates answer the oldest. Tenant-confined by RLS.
 */
export async function lookupLiveCompanyIdByIco(client: Queryable, ico: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT i.id
     FROM items i
     JOIN databases d ON d.id = i.database_id
     WHERE d.owner_module_id = $1 AND d.archived_at IS NULL AND i.deleted_at IS NULL
       AND jsonb_typeof(i.properties->'ico') = 'string'
       AND regexp_replace(i.properties->>'ico', '\\s', '', 'g') ~ '^[0-9]{1,8}$'
       AND lpad(regexp_replace(i.properties->>'ico', '\\s', '', 'g'), 8, '0') = $2
     ORDER BY i.created_at, i.id
     LIMIT 1`,
    [COMPANIES_MODULE_ID, ico],
  );
  return rows[0]?.id ?? null;
}
