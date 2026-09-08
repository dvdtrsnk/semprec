-- Auth v1 (issue #139): promotes the `0001_core_schema.sql` placeholder `users` row into the
-- real login model, and adds session and login-attempt tracking. `users` has no application
-- writer yet (auth login/session middleware ships in #140) and no seed ever inserts a row into
-- it, so there is no existing data that a NOT NULL column without a default could violate —
-- the escape hatch in the db-migrations skill applies: this issue's Task is exactly "create the
-- authentication schema", so the new user columns land as their final, complete shape rather
-- than going through a nullable-then-backfill expand step for data that doesn't exist.
ALTER TABLE users
  ADD COLUMN email text NOT NULL,
  ADD COLUMN password_hash text NOT NULL,
  ADD COLUMN locale text NOT NULL DEFAULT 'cs';

CREATE UNIQUE INDEX users_email_key ON users (email);

-- Multiple sessions per user (one per device/browser) are expected, so `user_id` is a plain
-- indexed FK, not unique. `token_hash` is what a request looks up by, so it alone is the
-- unique key `sessions_token_hash_key` backs.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('web', 'ios', 'macos')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
-- Supports "is this token still a live session": the middleware's steady-state query filters
-- on exactly these three columns together.
CREATE INDEX sessions_active_lookup_idx ON sessions (token_hash, expires_at, revoked_at);

-- No FK to `users`: a failed login for an email that doesn't exist is still an attempt worth
-- recording, for both throttling and audit.
CREATE TABLE login_attempts (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  ip inet NOT NULL,
  succeeded boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
-- Backs "recent failures for this email+IP" throttling lookups (`attempted_at DESC` so a
-- LIMIT/range scan for the recent window doesn't have to sort).
CREATE INDEX login_attempts_email_ip_idx ON login_attempts (email, ip, attempted_at DESC);
