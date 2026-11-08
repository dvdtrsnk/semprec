-- Issue #1040: admin-issued account invitations.
--
-- Additive only (a new table that no previous-release code touches), so a rollback keeps working
-- against this schema. Only the token's hash is stored, as for password-reset tokens; the raw token
-- lives in the invite link's URL fragment and is never persisted.
--
-- Deliberately no tenant_id and no row-level security: an invitation is global identity state, like
-- users and sessions. invited_by is nullable with ON DELETE SET NULL, so deleting the inviting
-- admin's account is never blocked by an invitation it issued.
--
-- Grants: semprec_side gets SELECT only; semprec_data gets DML, because creating, listing and
-- revoking invitations is a write through the admin routes.
CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  token_hash text NOT NULL,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX invites_token_hash_key ON invites (token_hash);
CREATE INDEX invites_email_idx ON invites (email);
COMMENT ON TABLE invites IS 'semprec:tenancy=global';
GRANT SELECT ON invites TO semprec_side;
GRANT INSERT, UPDATE, DELETE ON invites TO semprec_data;
