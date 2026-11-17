// The store of `calendar_feed_state` (issue gh-1960): what the subscription sweep
// (`calendarSubscriptionSweep.ts`) keeps per subscription calendar between two runs. The sweep is the only writer of a
// row's contents; `calendarFeedStatePurgeHook` (registered in `domainWriteHooks.ts` and run by `runItemPurgeHooks` in
// the purge transaction, docs/adr/2026-11-10-item-purge-domain-hooks.md) only deletes the row with its calendar item.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

/**
 * The validators of the last feed a consumer took over, as the server sent them (`null` when it sent none), and the
 * hash of the address that feed was requested from (`feedUrlHash`): validators belong to one address, so they are sent
 * only to the address they came from.
 */
export interface CalendarFeedValidators {
  etag: string | null;
  lastModified: string | null;
  feedUrlHash: string;
}

/** The hash `calendar_feed_state.feed_url_hash` holds for a feed address: SHA-256, lower-case hex. */
export function feedUrlHash(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

/**
 * Records a request that ended well (a feed the consumer took over, a 304, or a feed no consumer is registered for):
 * the time, the HTTP `status` and no error code. The validators are written only when `validators` is given; without
 * it the stored ones (and the address they belong to) stay as they are.
 */
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

/**
 * Records a request that failed: the time, the HTTP `status` when the server answered (else `null`) and the short
 * `errorCode`. The stored validators are never touched, and nothing fetched earlier is.
 */
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

/**
 * Deletes the row of `calendarItemId`, in the caller's transaction, and returns how many rows that was. Zero is a
 * legitimate outcome: a calendar that was never requested, or a purged item that is no calendar, has none.
 */
export async function deleteCalendarFeedState(client: PoolClient, calendarItemId: string): Promise<number> {
  const removed = await client.query(
    "DELETE FROM calendar_feed_state WHERE tenant_id = app_tenant_default() AND calendar_item_id = $1",
    [calendarItemId],
  );
  return removed.rowCount ?? 0;
}
