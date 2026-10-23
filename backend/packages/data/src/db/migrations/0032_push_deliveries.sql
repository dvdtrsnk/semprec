-- Push delivery fanout (issue #151): the durable per-(notification, registration) dedup key
-- the issue's Task requires — "a deterministic per-notification/per-registration delivery key
-- so retries cannot send the same pair twice". One row is claimed per active registration the
-- first time the `notificationFanout` job runs for a notification (see
-- `notifications/notificationFanoutJob.ts`); a retried job run only ever dispatches a row that
-- is still neither `delivered_at` nor `failed_permanently_at`, so a redelivered/retried queue job
-- can never send the same pair twice, while a still-pending row is retried until it resolves.
CREATE TABLE push_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notifications(id),
  push_subscription_id uuid NOT NULL REFERENCES push_subscriptions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  failed_permanently_at timestamptz,
  last_error text
);

-- The dedup key itself: at most one delivery row per (notification, registration) pair, ever.
CREATE UNIQUE INDEX push_deliveries_pair_idx ON push_deliveries (notification_id, push_subscription_id);

-- Backs the fanout job's "which of this notification's claimed deliveries are still pending" scan.
CREATE INDEX push_deliveries_notification_id_idx ON push_deliveries (notification_id);
