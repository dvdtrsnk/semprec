-- Issue #1483: one-time OAuth states for connecting a Gmail or Outlook mailbox. A row ties the browser
-- round trip to the user who started it; the start and complete routes that use it come with #1686.
--
-- Additive and rollback-safe: a new table the previous release never reads or writes.
--
-- Only the SHA-256 hash of the `state` sent to the provider is stored. The PKCE code verifier is sealed
-- under the tenant data key with associated data binding it to the tenant and this row's id. A null
-- `mailbox_item_id` means a new account; a set one means reauthorizing that mailbox;
-- it has no foreign key (like `mail_drafts`), and the expiry sweep removes a state left for a deleted mailbox.
CREATE TABLE mail_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  mailbox_item_id uuid,
  state_hash text NOT NULL,
  code_verifier_ciphertext bytea NOT NULL,
  code_verifier_nonce bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  used_at timestamptz,
  CONSTRAINT mail_oauth_states_user_id_tenant_fkey
    FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
-- Leads with tenant_id, so a state hash in another tenant never collides and is no existence oracle.
CREATE UNIQUE INDEX mail_oauth_states_state_hash_uq ON mail_oauth_states (tenant_id, state_hash);
CREATE INDEX mail_oauth_states_tenant_expires_idx ON mail_oauth_states (tenant_id, expires_at);
CREATE INDEX mail_oauth_states_user_idx ON mail_oauth_states (user_id);
COMMENT ON TABLE mail_oauth_states IS 'semprec:tenancy=tenant';
ALTER TABLE mail_oauth_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mail_oauth_states AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON mail_oauth_states AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_oauth_states TO semprec_side;
