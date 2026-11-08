-- Push registrations (issue #150): registrations for external push delivery whose lifecycle is
-- bound to the authenticated device session that created them (nullable `session_id` covers a
-- session that has since been deleted independently, e.g. a future admin purge — the row is not
-- FK-cascaded away, just orphaned of its session link).
--
-- `channel` picks which provider-specific fields apply: `web_push` uses `endpoint`/`p256dh`/
-- `auth_secret` (the Web Push protocol's subscription triple); `apns` uses `device_token`/
-- `apns_environment`. The two CHECKs below enforce that exactly the right fields are populated
-- for the row's channel, and that `platform` (reusing `sessions.platform`'s three values) is
-- consistent with `channel` — `web_push` only ever comes from a `web` session, `apns` only from
-- `ios`/`macos`.
--
-- Uniqueness is scoped to *active* (non-revoked) rows only: `revoked_at` naturally accumulates
-- history (a device can register, get revoked by logout, and register again later), and a
-- partial unique index is what lets a later registration for the same endpoint/device token
-- succeed once the earlier row has been revoked, without a plain unique constraint rejecting it.
CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  session_id uuid REFERENCES sessions(id),
  channel text NOT NULL CHECK (channel IN ('web_push', 'apns')),
  platform text NOT NULL CHECK (platform IN ('web', 'ios', 'macos')),
  endpoint text,
  p256dh text,
  auth_secret text,
  device_token text,
  apns_environment text CHECK (apns_environment IN ('sandbox', 'production')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT push_subscriptions_channel_fields_chk CHECK (
    (channel = 'web_push'
      AND endpoint IS NOT NULL AND p256dh IS NOT NULL AND auth_secret IS NOT NULL
      AND device_token IS NULL AND apns_environment IS NULL)
    OR
    (channel = 'apns'
      AND device_token IS NOT NULL AND apns_environment IS NOT NULL
      AND endpoint IS NULL AND p256dh IS NULL AND auth_secret IS NULL)
  ),
  CONSTRAINT push_subscriptions_channel_platform_chk CHECK (
    (channel = 'web_push' AND platform = 'web')
    OR (channel = 'apns' AND platform IN ('ios', 'macos'))
  )
);

CREATE UNIQUE INDEX push_subscriptions_active_endpoint_idx
  ON push_subscriptions (endpoint)
  WHERE revoked_at IS NULL AND endpoint IS NOT NULL;

CREATE UNIQUE INDEX push_subscriptions_active_device_token_idx
  ON push_subscriptions (device_token)
  WHERE revoked_at IS NULL AND device_token IS NOT NULL;

CREATE INDEX push_subscriptions_user_id_idx ON push_subscriptions (user_id);

-- Backs the logout/remote-revocation cascade: "revoke every registration tied to this session".
CREATE INDEX push_subscriptions_session_id_idx ON push_subscriptions (session_id) WHERE session_id IS NOT NULL;
