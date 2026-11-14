-- Issue gh-1894: the first response of an Inbox card action per Idempotency-Key, kept for 24 hours so that the
-- offline replay of a queued action answers what the first call answered and applies nothing a second time. The
-- store is inbox/idempotentResponsesStore.ts; `idempotency_keys` keeps mapping a key to the item a create made and
-- is not touched.
--
-- Additive and rollback-safe: a new table the previous release never reads or writes. A rollback leaves the rows
-- in place, they expire on their own time and the previous release ignores them.
--
-- A row belongs to one user of one tenant: the primary key (tenant_id, user_id, key, route) leads with tenant_id, so
-- a key sent by another user, on another route or in another tenant is a different row. route is the route template,
-- for example 'PATCH /api/proposals/:id/values'; request_hash is the hash of the request the first response answered,
-- so a key reused for another request is recognised. status and body are the stored response. user_id names a user
-- of the tenant and carries no foreign key: the rows are transient and a removed user's rows only wait for their
-- expiry. Rows are deleted by the store when they have expired (see expires_at, indexed for that sweep).
--
-- Role grants are those of `tenant_exports`: full DML to `semprec_side`, which `semprec_data` inherits through its
-- membership.
CREATE TABLE idempotent_responses (
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  user_id uuid NOT NULL,
  key text NOT NULL,
  route text NOT NULL,
  request_hash text NOT NULL,
  status integer NOT NULL,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, user_id, key, route)
);
COMMENT ON TABLE idempotent_responses IS 'semprec:tenancy=tenant';
ALTER TABLE idempotent_responses ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotent_responses AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON idempotent_responses AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotent_responses TO semprec_side;
CREATE INDEX idempotent_responses_expires_at_idx ON idempotent_responses (expires_at);
