// Store of `calendar_feed_state`, kept per subscription calendar between sweep runs. The sweep is the only writer
// of a row's contents; `calendarFeedStatePurgeHook` only deletes the row with its calendar item.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

/** Validators belong to one address (`feedUrlHash`), so they are sent only to the address they came from. */
export interface CalendarFeedValidators {
  etag: string | null;
  lastModified: string | null;
  feedUrlHash: string;
}

/** SHA-256, lower-case hex. */
export function feedUrlHash(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

/** Without `validators`, the stored validators (and their address) stay as they are. */
export async function recordCalendarFeedFetched(
  client: PoolClient,
  calendarItemId: string,
  status: number,
  validators: CalendarFeedValidators | null,
): Promise<void> {
  await client.query(
    `INSERT INTO calendar_feed_state
       (calendar_item_id, etag, last_modified, feed_url_hash, last_fetched_at, last_status, last_error_code)
     VALUES ($1, $2, $3, $4, now(), $5, NULL)
     ON CONFLICT (tenant_id, calendar_item_id) DO UPDATE
        SET etag = CASE WHEN $6 THEN EXCLUDED.etag ELSE calendar_feed_state.etag END,
            last_modified = CASE WHEN $6 THEN EXCLUDED.last_modified ELSE calendar_feed_state.last_modified END,
            feed_url_hash = CASE WHEN $6 THEN EXCLUDED.feed_url_hash ELSE calendar_feed_state.feed_url_hash END,
            last_fetched_at = now(), last_status = EXCLUDED.last_status, last_error_code = NULL`,
    [
      calendarItemId,
      validators?.etag ?? null,
      validators?.lastModified ?? null,
      validators?.feedUrlHash ?? null,
      status,
      validators !== null,
    ],
  );
}

/** The stored validators are never touched. */
export async function recordCalendarFeedFailure(
  client: PoolClient,
  calendarItemId: string,
  errorCode: string,
  status: number | null,
): Promise<void> {
  await client.query(
    `INSERT INTO calendar_feed_state (calendar_item_id, last_fetched_at, last_status, last_error_code)
     VALUES ($1, now(), $2, $3)
     ON CONFLICT (tenant_id, calendar_item_id) DO UPDATE
        SET last_fetched_at = now(), last_status = EXCLUDED.last_status, last_error_code = EXCLUDED.last_error_code`,
    [calendarItemId, status, errorCode],
  );
}

/** Zero is legitimate: a never-requested calendar, or a purged non-calendar item, has no row. */
export async function deleteCalendarFeedState(client: PoolClient, calendarItemId: string): Promise<number> {
  const removed = await client.query(
    "DELETE FROM calendar_feed_state WHERE tenant_id = app_tenant_default() AND calendar_item_id = $1",
    [calendarItemId],
  );
  return removed.rowCount ?? 0;
}
