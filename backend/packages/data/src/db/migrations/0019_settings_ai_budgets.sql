-- Retrofits dailyBudgetUsd/monthlyBudgetUsd onto the System settings singleton for installs
-- already provisioned before this migration. Fresh installs get these two properties
-- directly from seedSystem.ts's own insert, so this is a no-op there (settings_db_id is
-- NULL until that seed has run). Idempotent: safe to re-run on every deploy.
DO $$
DECLARE
  settings_db_id uuid;
BEGIN
  SELECT id INTO settings_db_id FROM databases WHERE owner_module_id = 'systemSettings' AND system = true;
  IF settings_db_id IS NULL THEN
    RETURN;
  END IF;

  -- Same unlock/write/relock sequence seedSystem.ts uses: a system DB's schema may only be
  -- changed by a code-level migration with direct DB access, never through the choke point.
  UPDATE databases SET schema_locked = false WHERE id = settings_db_id;

  INSERT INTO properties (database_id, key, name, type, locked, owner)
  VALUES (settings_db_id, 'dailyBudgetUsd', 'Daily AI budget (USD)', 'number', true, 'user')
  ON CONFLICT (database_id, key) DO NOTHING;

  INSERT INTO properties (database_id, key, name, type, locked, owner)
  VALUES (settings_db_id, 'monthlyBudgetUsd', 'Monthly AI budget (USD)', 'number', true, 'user')
  ON CONFLICT (database_id, key) DO NOTHING;

  UPDATE items
  SET properties = properties || jsonb_build_object('dailyBudgetUsd', 50, 'monthlyBudgetUsd', NULL::numeric)
  WHERE database_id = settings_db_id AND NOT (properties ? 'dailyBudgetUsd');

  UPDATE databases SET schema_locked = true WHERE id = settings_db_id;
END $$;
