ALTER TABLE mail_threads ADD COLUMN IF NOT EXISTS item_id uuid;
ALTER TABLE mail_threads ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS mail_threads_tenant_item_id_idx
  ON mail_threads (tenant_id, item_id) WHERE item_id IS NOT NULL;
