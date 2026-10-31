-- Issue #1473: the IMAP and SMTP server settings of a mailbox (host, port, security mode, username).
-- The password stays in `external_credentials`; it is not part of this row.
--
-- Additive and rollback-safe: a new table the previous release never reads or writes.
--
-- The host rules (a DNS name, never an IP literal or a local name) are checked in code by
-- `mail/mailServerSettingsStore.ts`; the database enforces the ports, the security modes and that a
-- host, its port and its security are all set or all null. `mailbox_item_id` is a server-generated
-- item id, so the primary key does not lead with tenant_id (the same as `mail_account_sync_state`).
CREATE TABLE mail_account_server_settings (
  mailbox_item_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  imap_host text,
  imap_port integer CHECK (imap_port IN (993, 143, 465, 587)),
  imap_security text CHECK (imap_security IN ('tls', 'starttls')),
  smtp_host text,
  smtp_port integer CHECK (smtp_port IN (993, 143, 465, 587)),
  smtp_security text CHECK (smtp_security IN ('tls', 'starttls')),
  username text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_account_server_settings_imap_all_or_none CHECK (
    (imap_host IS NULL AND imap_port IS NULL AND imap_security IS NULL)
    OR (imap_host IS NOT NULL AND imap_port IS NOT NULL AND imap_security IS NOT NULL)
  ),
  CONSTRAINT mail_account_server_settings_smtp_all_or_none CHECK (
    (smtp_host IS NULL AND smtp_port IS NULL AND smtp_security IS NULL)
    OR (smtp_host IS NOT NULL AND smtp_port IS NOT NULL AND smtp_security IS NOT NULL)
  )
);
CREATE INDEX mail_account_server_settings_tenant_idx ON mail_account_server_settings (tenant_id);
COMMENT ON TABLE mail_account_server_settings IS 'semprec:tenancy=tenant';
ALTER TABLE mail_account_server_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mail_account_server_settings AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON mail_account_server_settings AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_account_server_settings TO semprec_side;
