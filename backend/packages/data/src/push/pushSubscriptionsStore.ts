import type { Pool, PoolClient } from "pg";
import { assertKnownValue } from "../dbRowValidation.js";
import { SESSION_PLATFORMS } from "../auth/types.js";
import { APNS_ENVIRONMENTS, PUSH_CHANNELS, type PushSubscriptionRow } from "./types.js";

function mapRow(row: {
  id: string;
  user_id: string;
  session_id: string | null;
  channel: string;
  platform: string;
  endpoint: string | null;
  p256dh: string | null;
  auth_secret: string | null;
  device_token: string | null;
  apns_environment: string | null;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
}): PushSubscriptionRow {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    channel: assertKnownValue(PUSH_CHANNELS, row.channel, "channel"),
    platform: assertKnownValue(SESSION_PLATFORMS, row.platform, "platform"),
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    authSecret: row.auth_secret,
    deviceToken: row.device_token,
    apnsEnvironment:
      row.apns_environment === null
        ? null
        : assertKnownValue(APNS_ENVIRONMENTS, row.apns_environment, "apns_environment"),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

const SELECT_COLUMNS =
  "id, user_id, session_id, channel, platform, endpoint, p256dh, auth_secret, device_token, apns_environment, created_at, updated_at, revoked_at";

export interface UpsertWebPushSubscriptionInput {
  userId: string;
  sessionId: string | null;
  endpoint: string;
  p256dh: string;
  authSecret: string;
}

/**
 * Registers (or reactivates) a `web_push` subscription. `ON CONFLICT` targets exactly the
 * partial unique index from migration 0031: it only fires when an *active* row already shares
 * this `endpoint`, in which case that row is refreshed in place (new owning user/session,
 * refreshed keys). If the only existing row for this endpoint is revoked, the partial index has
 * no entry for it, so this is a plain insert of a fresh active row — the reactivation the issue's
 * Task describes, without ever violating active uniqueness.
 */
export async function upsertWebPushSubscription(
  client: Pool | PoolClient,
  input: UpsertWebPushSubscriptionInput,
): Promise<PushSubscriptionRow> {
  const { rows } = await client.query(
    `INSERT INTO push_subscriptions (user_id, session_id, channel, platform, endpoint, p256dh, auth_secret)
     VALUES ($1, $2, 'web_push', 'web', $3, $4, $5)
     ON CONFLICT (endpoint) WHERE revoked_at IS NULL AND endpoint IS NOT NULL
     DO UPDATE SET user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id,
                   p256dh = EXCLUDED.p256dh, auth_secret = EXCLUDED.auth_secret, updated_at = now()
     RETURNING ${SELECT_COLUMNS}`,
    [input.userId, input.sessionId, input.endpoint, input.p256dh, input.authSecret],
  );
  return mapRow(rows[0]);
}

export interface UpsertApnsSubscriptionInput {
  userId: string;
  sessionId: string | null;
  platform: "ios" | "macos";
  deviceToken: string;
  apnsEnvironment: "sandbox" | "production";
}

/** Same reactivation contract as `upsertWebPushSubscription`, keyed on `device_token` instead of `endpoint`. */
export async function upsertApnsSubscription(
  client: Pool | PoolClient,
  input: UpsertApnsSubscriptionInput,
): Promise<PushSubscriptionRow> {
  const { rows } = await client.query(
    `INSERT INTO push_subscriptions (user_id, session_id, channel, platform, device_token, apns_environment)
     VALUES ($1, $2, 'apns', $3, $4, $5)
     ON CONFLICT (device_token) WHERE revoked_at IS NULL AND device_token IS NOT NULL
     DO UPDATE SET user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id,
                   platform = EXCLUDED.platform, apns_environment = EXCLUDED.apns_environment, updated_at = now()
     RETURNING ${SELECT_COLUMNS}`,
    [input.userId, input.sessionId, input.platform, input.deviceToken, input.apnsEnvironment],
  );
  return mapRow(rows[0]);
}

/**
 * Explicit revocation (issue #150's authenticated revocation endpoint), scoped to `userId` so a
 * caller can't revoke a registration id it doesn't own by guessing it — same pattern as
 * `revokeSessionForUser`. Returns whether a row was actually revoked.
 */
export async function revokePushSubscriptionForUser(
  client: Pool | PoolClient,
  id: string,
  userId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE push_subscriptions SET revoked_at = now(), updated_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [id, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * The session cascade the issue's Task requires: run in the same transaction as manual logout
 * or remote session revocation so a registration never outlives the session that created it.
 * A no-op when the session has no live registrations, which is the common case.
 */
export async function revokePushSubscriptionsForSession(client: Pool | PoolClient, sessionId: string): Promise<void> {
  await client.query(
    `UPDATE push_subscriptions SET revoked_at = now(), updated_at = now()
     WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
}

export type ProviderInvalidationInput =
  { channel: "web_push"; endpoint: string } | { channel: "apns"; deviceToken: string };

/**
 * The one repository operation for provider invalidation the issue's Task asks for: a web push
 * send answered with 404/410, or an APNs send answered with 410/`BadDeviceToken`, means the
 * provider itself says this registration is dead — #151's delivery path calls this with exactly
 * the registration it tried to use, never a caller-supplied search. Returns whether a row was
 * actually revoked (it may already have been, e.g. a concurrent duplicate send).
 */
export async function revokePushSubscriptionByProviderInvalidation(
  client: Pool | PoolClient,
  input: ProviderInvalidationInput,
): Promise<boolean> {
  const result =
    input.channel === "web_push"
      ? await client.query(
          `UPDATE push_subscriptions SET revoked_at = now(), updated_at = now()
           WHERE channel = 'web_push' AND endpoint = $1 AND revoked_at IS NULL`,
          [input.endpoint],
        )
      : await client.query(
          `UPDATE push_subscriptions SET revoked_at = now(), updated_at = now()
           WHERE channel = 'apns' AND device_token = $1 AND revoked_at IS NULL`,
          [input.deviceToken],
        );
  return (result.rowCount ?? 0) > 0;
}

export async function listPushSubscriptionsForUser(
  client: Pool | PoolClient,
  userId: string,
): Promise<PushSubscriptionRow[]> {
  const { rows } = await client.query(
    `SELECT ${SELECT_COLUMNS} FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(mapRow);
}
