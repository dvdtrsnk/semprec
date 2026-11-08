-- Issue #1004: per-tenant AI budget caps, owned by the operator's admin instead of living as two
-- user-owned properties of the System settings item.
--
-- Additive only (a new table nothing reads yet; the gateway keeps reading the settings item), so
-- the previous release keeps working against this schema after a rollback.
--
-- A tenant without a row may not spend at all; within a row a NULL cap means that window has no
-- per-tenant cap. This is operator configuration keyed by tenant, so the table is global: no
-- tenant_id default and no row-level security.
--
-- Grants: semprec_side (the gateway's role) gets SELECT only, so the gateway can never raise its
-- own caps. semprec_data (semprec-api) gets SELECT, INSERT, UPDATE; its admin cap route is the only
-- writer. Nobody gets DELETE: a row disappears only with its tenant, through the cascade.
--
-- Safe to execute a second time: IF NOT EXISTS, and the seed skips a tenant that already has a row.
CREATE TABLE IF NOT EXISTS tenant_ai_budgets (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  daily_cap_usd numeric CHECK (daily_cap_usd >= 0),
  monthly_cap_usd numeric CHECK (monthly_cap_usd >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);
COMMENT ON TABLE tenant_ai_budgets IS 'semprec:tenancy=global';
GRANT SELECT ON tenant_ai_budgets TO semprec_side;
GRANT SELECT, INSERT, UPDATE ON tenant_ai_budgets TO semprec_data;

-- Seed one row per existing tenant from its System settings item, mapping the values exactly as
-- systemSettings.ts's toAiBudgets does: an absent key is 50 (daily) / NULL (monthly), JSON null is
-- NULL, a number is kept (a negative cap refuses every call today, so it clamps to 0). A tenant
-- with no settings item yet (migrations run before the seed on a fresh install) gets the defaults.
-- updated_by stays NULL, which marks a row no admin has written.
DO $$
DECLARE
  tenant RECORD;
  props jsonb;
  keys CONSTANT text[] := ARRAY['dailyBudgetUsd', 'monthlyBudgetUsd'];
  caps numeric[];
  raw jsonb;
  cap numeric;
BEGIN
  FOR tenant IN
    SELECT t.id FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM tenant_ai_budgets b WHERE b.tenant_id = t.id)
  LOOP
    SELECT i.properties INTO props
      FROM databases d
      JOIN items i ON i.database_id = d.id
     WHERE d.owner_module_id = 'systemSettings' AND d.system AND d.tenant_id = tenant.id
     LIMIT 1;

    caps := ARRAY[NULL, NULL]::numeric[];
    FOR n IN 1..2 LOOP
      raw := props -> keys[n];
      IF raw IS NULL THEN
        cap := CASE WHEN n = 1 THEN 50 ELSE NULL END;
      ELSIF jsonb_typeof(raw) = 'null' THEN
        cap := NULL;
      ELSIF jsonb_typeof(raw) = 'number' THEN
        cap := GREATEST((raw #>> '{}')::numeric, 0);
      ELSE
        RAISE EXCEPTION 'tenant_ai_budgets seed: system settings property % must be a number or null, found %',
          keys[n], jsonb_typeof(raw);
      END IF;
      caps[n] := cap;
    END LOOP;

    INSERT INTO tenant_ai_budgets (tenant_id, daily_cap_usd, monthly_cap_usd)
    VALUES (tenant.id, caps[1], caps[2])
    ON CONFLICT (tenant_id) DO NOTHING;
  END LOOP;
END $$;
