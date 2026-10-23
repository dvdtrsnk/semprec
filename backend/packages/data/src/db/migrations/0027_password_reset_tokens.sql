-- Password recovery over SMTP (issue #142). Mirrors `sessions.token_hash` (0025_auth_schema.sql):
-- only a hash of the reset token is ever stored, so a database dump alone can't grant a reset.
-- `consumed_at` makes a token single-use; `expires_at` bounds its lifetime (30 minutes, enforced
-- in application code, not here).
CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE UNIQUE INDEX password_reset_tokens_token_hash_key ON password_reset_tokens (token_hash);
-- Supports "does this user already have a live reset request" lookups, same shape as sessions_user_id_idx.
CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);
