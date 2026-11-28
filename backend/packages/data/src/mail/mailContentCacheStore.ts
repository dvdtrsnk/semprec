import type { PoolClient } from "pg";
import { requireSingleRow, type Queryable } from "../db/pool.js";

/** How long a body fetched on demand is served before the provider is asked again. */
export const MAIL_CONTENT_CACHE_DAYS = 7;

/** A fresh cache row: the body parts as the provider returned them, unsanitized. */
export interface MailContentCacheRow {
  bodyHtml: string | null;
  bodyText: string | null;
  fetchedAt: Date;
  expiresAt: Date;
}

interface CacheDbRow {
  body_html: string | null;
  body_text: string | null;
  fetched_at: Date;
  expires_at: Date;
}

function mapRow(row: CacheDbRow): MailContentCacheRow {
  return { bodyHtml: row.body_html, bodyText: row.body_text, fetchedAt: row.fetched_at, expiresAt: row.expires_at };
}

/** The message's cache row while it has not expired; an expired row reads as none. */
export async function readFreshMailContentCache(
  client: Queryable,
  itemId: string,
): Promise<MailContentCacheRow | null> {
  const { rows } = await client.query<CacheDbRow>(
    `SELECT body_html, body_text, fetched_at, expires_at FROM mail_message_content_cache
      WHERE tenant_id = app_tenant_default() AND item_id = $1 AND expires_at > now()`,
    [itemId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * The one writer of `mail_message_content_cache`: stores a body just fetched from the provider, replacing an earlier
 * row of the message, valid for `MAIL_CONTENT_CACHE_DAYS`. The Emails item is locked `FOR KEY SHARE` first, so a purge
 * cannot remove it before the commit; `null` when it is gone or in the trash, and nothing is written.
 */
export async function writeMailContentCache(
  client: PoolClient,
  input: { itemId: string; bodyHtml: string | null; bodyText: string | null },
): Promise<MailContentCacheRow | null> {
  const live = await client.query<{ id: string }>(
    "SELECT id FROM items WHERE tenant_id = app_tenant_default() AND id = $1 AND deleted_at IS NULL FOR KEY SHARE",
    [input.itemId],
  );
  if (live.rowCount !== 1) return null;
  const { rows } = await client.query<CacheDbRow>(
    `INSERT INTO mail_message_content_cache (item_id, body_html, body_text, fetched_at, expires_at)
     VALUES ($1, $2, $3, now(), now() + make_interval(days => $4))
     ON CONFLICT (tenant_id, item_id) DO UPDATE SET
       body_html = EXCLUDED.body_html, body_text = EXCLUDED.body_text,
       fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at
     RETURNING body_html, body_text, fetched_at, expires_at`,
    [input.itemId, input.bodyHtml, input.bodyText, MAIL_CONTENT_CACHE_DAYS],
  );
  return mapRow(requireSingleRow(rows, "mail_message_content_cache row"));
}

/** Deletes the current tenant's expired rows; the count of rows deleted. */
export async function deleteExpiredMailContentCache(client: Queryable): Promise<number> {
  const result = await client.query(
    "DELETE FROM mail_message_content_cache WHERE tenant_id = app_tenant_default() AND expires_at <= now()",
  );
  return result.rowCount ?? 0;
}
