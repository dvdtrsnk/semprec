import type { Queryable } from "../db/pool.js";

/**
 * Lets the backoff of the account's last failed pass run out, as the wait before the sweep queues it again would: both
 * times of the failure move back, so the account is due while the delay they record, which the next failure grows,
 * stays the same. A state no production write produces, since none moves the clock.
 */
export async function elapseMailSyncBackoff(client: Queryable, mailboxItemId: string): Promise<void> {
  await client.query(
    `UPDATE mail_account_sync_state
        SET last_activity_at = last_activity_at - (next_expected_activity_at - now()) - interval '1 second',
            next_expected_activity_at = now() - interval '1 second'
      WHERE item_id = $1 AND failing_since IS NOT NULL AND next_expected_activity_at > now()`,
    [mailboxItemId],
  );
}
