CREATE TABLE semp_message_speech (
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  message_id uuid NOT NULL,
  voice text NOT NULL,
  blob_id uuid NOT NULL,
  audio_seconds double precision NOT NULL CHECK (audio_seconds >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, message_id, voice),
  CONSTRAINT semp_message_speech_message_fkey
    FOREIGN KEY (tenant_id, message_id) REFERENCES semp_messages (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT semp_message_speech_blob_fkey
    FOREIGN KEY (tenant_id, blob_id) REFERENCES blobs (tenant_id, id)
);
CREATE INDEX semp_message_speech_tenant_blob_idx ON semp_message_speech (tenant_id, blob_id);
COMMENT ON TABLE semp_message_speech IS 'semprec:tenancy=tenant';
ALTER TABLE semp_message_speech ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON semp_message_speech AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON semp_message_speech AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON semp_message_speech TO semprec_side;
