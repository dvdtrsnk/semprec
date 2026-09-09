import type { Pool, PoolClient } from "pg";

export interface PushDeliveryStatus {
  id: string;
  pushSubscriptionId: string;
  delivered: boolean;
  failedPermanently: boolean;
}

/**
 * Establishes the durable fanout list for this notification (issue #151): one `push_deliveries`
 * row per registration id passed in, keyed `(notification_id, push_subscription_id)` — migration
 * 0032's unique index. `ON CONFLICT DO NOTHING` makes this safe to call again on every retry of
 * the `notificationFanout` job: a registration already claimed on an earlier attempt is left
 * untouched, only newly-active registrations (none, in the common case) get a fresh row.
 */
export async function claimPushDeliveryTargets(
  client: Pool | PoolClient,
  notificationId: string,
  pushSubscriptionIds: readonly string[],
): Promise<void> {
  if (pushSubscriptionIds.length === 0) return;
  await client.query(
    `INSERT INTO push_deliveries (notification_id, push_subscription_id)
     SELECT $1, unnest($2::uuid[])
     ON CONFLICT (notification_id, push_subscription_id) DO NOTHING`,
    [notificationId, pushSubscriptionIds],
  );
}

/** Every delivery row claimed so far for this notification, so the fanout job can skip anything already resolved. */
export async function getPushDeliveryStatuses(
  client: Pool | PoolClient,
  notificationId: string,
): Promise<PushDeliveryStatus[]> {
  const { rows } = await client.query(
    `SELECT id, push_subscription_id, delivered_at, failed_permanently_at
     FROM push_deliveries WHERE notification_id = $1`,
    [notificationId],
  );
  return rows.map(
    (row: {
      id: string;
      push_subscription_id: string;
      delivered_at: Date | null;
      failed_permanently_at: Date | null;
    }) => ({
      id: row.id,
      pushSubscriptionId: row.push_subscription_id,
      delivered: row.delivered_at !== null,
      failedPermanently: row.failed_permanently_at !== null,
    }),
  );
}

/** Terminal success — never dispatched again (the fanout job filters it out via `getPushDeliveryStatuses`). */
export async function markPushDeliveryDelivered(client: Pool | PoolClient, id: string): Promise<void> {
  await client.query(
    `UPDATE push_deliveries SET delivered_at = now(), updated_at = now(), last_error = NULL WHERE id = $1`,
    [id],
  );
}

/** Terminal provider rejection (404/410/BadDeviceToken) — paired with `revokePushSubscriptionByProviderInvalidation` by the caller. */
export async function markPushDeliveryFailedPermanently(
  client: Pool | PoolClient,
  id: string,
  error: string,
): Promise<void> {
  await client.query(
    `UPDATE push_deliveries SET failed_permanently_at = now(), updated_at = now(), last_error = $2 WHERE id = $1`,
    [id, error],
  );
}

/** Non-terminal — the row stays pending so the next job retry (graphile-worker) dispatches it again. */
export async function recordPushDeliveryTransientFailure(
  client: Pool | PoolClient,
  id: string,
  error: string,
): Promise<void> {
  await client.query(`UPDATE push_deliveries SET updated_at = now(), last_error = $2 WHERE id = $1`, [id, error]);
}
