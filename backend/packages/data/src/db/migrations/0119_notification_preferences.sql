-- Issue #1441: per-user notification preferences: which push categories may interrupt the user, the level
-- of assistant problem pushes, whether problems join the scheduled summary, and which counts the app icon
-- badge shows. A user without a row has the column defaults below; the first change creates the row.
--
-- Additive and rollback-safe: a new table the previous release never reads or writes.
--
-- `user_id` keeps the plain reference and gains the tenant-consistent (tenant_id, id) twin, as
-- 0083_tenant_composite_foreign_keys.sql does for every reference between tenant rows; the table is
-- created empty, so the twin is validated at once. Account purge deletes a tenant's table rows before it
-- deletes the users, so the reference needs no ON DELETE action.
CREATE TABLE notification_preferences (
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  approvals boolean NOT NULL DEFAULT true,
  invites boolean NOT NULL DEFAULT true,
  reminders boolean NOT NULL DEFAULT true,
  problems_level text NOT NULL DEFAULT 'critical' CHECK (problems_level IN ('off', 'critical', 'all')),
  problems_summary boolean NOT NULL DEFAULT true,
  badge_approvals boolean NOT NULL DEFAULT true,
  badge_invites boolean NOT NULL DEFAULT true,
  badge_inbox boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT notification_preferences_user_id_tenant_fkey
    FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
COMMENT ON TABLE notification_preferences IS 'semprec:tenancy=tenant';
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_preferences AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON notification_preferences AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_preferences TO semprec_side;
