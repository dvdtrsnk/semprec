CREATE INDEX IF NOT EXISTS mail_message_meta_tenant_thread_idx
  ON mail_message_meta (tenant_id, thread_id);
