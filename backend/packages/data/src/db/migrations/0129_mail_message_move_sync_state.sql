-- Durable move intent and the identity of its currently owned provider step.
CREATE TABLE mail_message_move_sync_state (
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  message_item_id uuid NOT NULL,
  mailbox_item_id uuid NOT NULL,
  desired_purpose text NOT NULL CHECK (desired_purpose IN ('archive', 'trash', 'inbox', 'sent')),
  source_evidence jsonb NOT NULL CHECK (jsonb_typeof(source_evidence) = 'object' AND octet_length(source_evidence::text) <= 4096),
  current_purpose text CHECK (current_purpose IN ('archive', 'trash', 'inbox', 'sent')),
  desired_revision bigint NOT NULL DEFAULT 1 CHECK (desired_revision > 0),
  operation_token uuid,
  captured_revision bigint CHECK (captured_revision > 0),
  captured_purpose text CHECK (captured_purpose IN ('archive', 'trash', 'inbox', 'sent')),
  operation_phase text CHECK (operation_phase IN ('in_flight', 'between_steps', 'uncertain')),
  operation_step text CHECK (operation_step IN ('move', 'copy', 'mark_deleted', 'expunge', 'untrash', 'modify_labels', 'trash')),
  operation_evidence jsonb CHECK (operation_evidence IS NULL OR
    (jsonb_typeof(operation_evidence) = 'object' AND octet_length(operation_evidence::text) <= 8192)),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  failure_reason text CHECK (failure_reason IN ('messageMissing', 'providerRejected', 'unsupportedCapability')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, message_item_id),
  UNIQUE (tenant_id, operation_token),
  CHECK ((operation_token IS NULL AND captured_revision IS NULL AND captured_purpose IS NULL AND operation_phase IS NULL AND operation_step IS NULL AND operation_evidence IS NULL)
    OR (operation_token IS NOT NULL AND captured_revision IS NOT NULL AND captured_purpose IS NOT NULL AND operation_phase IS NOT NULL AND operation_step IS NOT NULL AND operation_evidence IS NOT NULL))
);
CREATE INDEX mail_message_move_sync_pending_idx ON mail_message_move_sync_state (tenant_id, mailbox_item_id, status);
COMMENT ON TABLE mail_message_move_sync_state IS 'semprec:tenancy=tenant';
ALTER TABLE mail_message_move_sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mail_message_move_sync_state AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON mail_message_move_sync_state AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_message_move_sync_state TO semprec_side;
