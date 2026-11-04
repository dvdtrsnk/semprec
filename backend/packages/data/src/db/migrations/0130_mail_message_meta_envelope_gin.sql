-- Support containment lookups when a newly claimed person address is linked
-- to historical messages. Existing tenant rows are unchanged.
CREATE INDEX mail_message_meta_envelope_gin_idx
  ON mail_message_meta USING gin (envelope jsonb_path_ops);
