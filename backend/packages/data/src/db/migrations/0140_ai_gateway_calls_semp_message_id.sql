-- Existing calls remain unattributed to a Semp message.
ALTER TABLE ai_gateway_calls ADD COLUMN semp_message_id uuid;
ALTER TABLE ai_gateway_calls ADD CONSTRAINT ai_gateway_calls_semp_message_id_tenant_fkey
  FOREIGN KEY (tenant_id, semp_message_id) REFERENCES semp_messages (tenant_id, id) NOT VALID;
ALTER TABLE ai_gateway_calls VALIDATE CONSTRAINT ai_gateway_calls_semp_message_id_tenant_fkey;
CREATE INDEX ai_gateway_calls_tenant_semp_message_idx ON ai_gateway_calls (tenant_id, semp_message_id);
