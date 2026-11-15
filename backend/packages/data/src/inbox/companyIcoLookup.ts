import type { Queryable } from "../db/pool.js";
import { COMPANIES_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * The id of a live Companies item whose `ico` is `ico`, or `null` (issue gh-1992). `ico` is the eight-digit form of
 * the number; a stored value is compared in the same form (whitespace removed, left-padded with zeros to eight digits),
 * and a stored value that is not one to eight digits matches nothing. The comparison is exact equality: the check digit
 * is not examined and no name is compared. An item in the Trash and an item of an archived Companies database are not
 * live. Several live companies with one number answer the oldest. The read writes nothing and is confined to the
 * caller's tenant by row-level security.
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
