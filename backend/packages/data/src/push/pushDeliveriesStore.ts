import type { Pool, PoolClient } from "pg";

export interface PushDeliveryStatus {
  id: string;
  pushSubscriptionId: string;
  delivered: boolean;
  failedPermanently: boolean;
}

/** `ON CONFLICT DO NOTHING` makes this safe on every fanout retry; claimed rows are left untouched. */
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

export async function getPushDeliveryStatuses(
  client: Pool | PoolClient,
  notificationId: string,
): Promise<PushDeliveryStatus[]> {
  const { rows } = await client.query<{
    id: string;
    push_subscription_id: string;
    delivered_at: Date | null;
    failed_permanently_at: Date | null;
  }>(
    `SELECT id, push_subscription_id, delivered_at, failed_permanently_at
     FROM push_deliveries WHERE notification_id = $1`,
    [notificationId],
  );
  return rows.map((row) => ({
    id: row.id,
    pushSubscriptionId: row.push_subscription_id,
    delivered: row.delivered_at !== null,
    failedPermanently: row.failed_permanently_at !== null,
  }));
}

export async function markPushDeliveryDelivered(client: Pool | PoolClient, id: string): Promise<void> {
  await client.query(
    `UPDATE push_deliveries SET delivered_at = now(), updated_at = now(), last_error = NULL WHERE id = $1`,
    [id],
  );
}

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

/** Non-terminal: the row stays pending for the next job retry. */
export async function recordPushDeliveryTransientFailure(
  client: Pool | PoolClient,
  id: string,
  error: string,
): Promise<void> {
  await client.query(`UPDATE push_deliveries SET updated_at = now(), last_error = $2 WHERE id = $1`, [id, error]);
}
