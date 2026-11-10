-- Issue #1367: durable Semp conversation threads and their messages.
--
-- Additive and rollback-safe: two new tables the previous release never reads or writes. Nothing
-- reads or writes them yet.
--
-- `semp_threads` has no user_id column: the owning user is derived through getTenantUserId.
-- `subject_inbox_item_id` carries no foreign key because `items` is partitioned; the proposal id
-- stays NULL until the capture has a proposal card.
CREATE TABLE semp_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('chat', 'item', 'tick')),
  title text,
  title_source text NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto', 'user')),
  subject_inbox_item_id uuid,
  subject_proposal_id uuid,
  heartbeat_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT semp_threads_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT semp_threads_heartbeat_fkey
    FOREIGN KEY (tenant_id, heartbeat_id) REFERENCES project_heartbeats (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT semp_threads_kind_columns_check CHECK (
    (kind = 'chat' AND subject_inbox_item_id IS NULL AND subject_proposal_id IS NULL AND heartbeat_id IS NULL)
    OR (kind = 'item' AND subject_inbox_item_id IS NOT NULL AND heartbeat_id IS NULL)
    OR (kind = 'tick' AND heartbeat_id IS NOT NULL AND subject_inbox_item_id IS NULL AND subject_proposal_id IS NULL)
  ),
  CONSTRAINT semp_threads_title_chat_check CHECK (title IS NULL OR kind = 'chat')
);
CREATE UNIQUE INDEX semp_threads_tick_heartbeat_uq ON semp_threads (tenant_id, heartbeat_id) WHERE kind = 'tick';
CREATE UNIQUE INDEX semp_threads_item_subject_uq ON semp_threads (tenant_id, subject_inbox_item_id) WHERE kind = 'item';
CREATE INDEX semp_threads_tenant_activity_idx ON semp_threads (tenant_id, last_activity_at DESC, id DESC);
COMMENT ON TABLE semp_threads IS 'semprec:tenancy=tenant';
ALTER TABLE semp_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON semp_threads AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON semp_threads AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON semp_threads TO semprec_side;

-- `system_key` is an i18n key, never user-facing text. `context` is stored opaquely (shape: #1369).
-- `event_from_id` / `event_to_id` are the agent_run_events range of the turn, read together with
-- `agent_run_id`.
CREATE TABLE semp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  thread_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  text text,
  system_key text,
  system_params jsonb,
  context jsonb NOT NULL DEFAULT '[]',
  reply_to_message_id uuid,
  agent_run_id uuid,
  event_from_id bigint,
  event_to_id bigint,
  status text CHECK (status IN ('queued', 'running', 'done', 'error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT semp_messages_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT semp_messages_thread_fkey
    FOREIGN KEY (tenant_id, thread_id) REFERENCES semp_threads (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT semp_messages_reply_to_fkey
    FOREIGN KEY (tenant_id, reply_to_message_id) REFERENCES semp_messages (tenant_id, id),
  CONSTRAINT semp_messages_agent_run_fkey
    FOREIGN KEY (tenant_id, agent_run_id) REFERENCES agent_runs (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT semp_messages_system_columns_check CHECK (
    role = 'system' OR (system_key IS NULL AND system_params IS NULL)
  )
);
CREATE INDEX semp_messages_thread_created_idx ON semp_messages (tenant_id, thread_id, created_at DESC, id DESC);
COMMENT ON TABLE semp_messages IS 'semprec:tenancy=tenant';
ALTER TABLE semp_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON semp_messages AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON semp_messages AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON semp_messages TO semprec_side;
