-- Issue #1504: structured metadata of a mail draft that lives only in Semprec (mailbox, thread,
-- reply mode and source message, threading headers, structured recipients, who created and last
-- edited it, and whether it was sent). Provider drafts without a row here stay read-only.
--
-- Additive and rollback-safe: a new table the previous release never reads or writes.
--
-- `email_item_id` is a server-generated item id, so the primary key does not lead with tenant_id
-- (the same as `mail_account_server_settings`). The partial unique index leads with tenant_id, so
-- the same thread id in another tenant never collides and it is no existence oracle across tenants.
CREATE TABLE mail_drafts (
  email_item_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  mailbox_item_id uuid NOT NULL,
  thread_id uuid,
  mode text NOT NULL CHECK (mode IN ('new', 'reply', 'replyAll', 'forward')),
  source_email_item_id uuid,
  in_reply_to text,
  "references" text[] NOT NULL DEFAULT '{}',
  from_address text NOT NULL,
  to_recipients jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(to_recipients) = 'array'),
  cc_recipients jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(cc_recipients) = 'array'),
  bcc_recipients jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(bcc_recipients) = 'array'),
  created_by text NOT NULL CHECK (created_by IN ('user', 'agent')),
  last_edited_by text NOT NULL CHECK (last_edited_by IN ('user', 'agent')),
  agent_run_id uuid,
  conversation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE UNIQUE INDEX mail_drafts_one_unsent_agent_per_thread_uq ON mail_drafts (tenant_id, thread_id)
  WHERE created_by = 'agent' AND sent_at IS NULL AND thread_id IS NOT NULL;
CREATE INDEX mail_drafts_tenant_mailbox_idx ON mail_drafts (tenant_id, mailbox_item_id);
COMMENT ON TABLE mail_drafts IS 'semprec:tenancy=tenant';
ALTER TABLE mail_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mail_drafts AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON mail_drafts AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_drafts TO semprec_side;
