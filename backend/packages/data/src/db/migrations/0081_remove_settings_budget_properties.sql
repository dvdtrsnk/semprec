-- Contract step (expand/contract, docs/adr/2026-09-10-expand-contract-forward-only-migrations.md):
-- removes the dailyBudgetUsd/monthlyBudgetUsd properties and item keys that seedSystem.ts and
-- 0019_settings_ai_budgets.sql put on every tenant's System settings database. Nothing reads them
-- any more: #1035 moved budget enforcement to the admin-owned tenant_ai_budgets table and #1048
-- moved the usage report's caps there, so the release one back does not read them either
-- (release checkpoint #1058).
--
-- Runs across all tenants: the migrating role bypasses row-level security. A settings database
-- with neither property nor key is skipped, so re-running changes nothing, and on a fresh
-- install no settings database exists yet at migration time, so this is a no-op there.
DO $$
DECLARE
  settings_db_id uuid;
BEGIN
  FOR settings_db_id IN
    SELECT d.id
      FROM databases d
     WHERE d.owner_module_id = 'systemSettings'
       AND d.system
       AND (
         EXISTS (
           SELECT 1 FROM properties p
            WHERE p.database_id = d.id AND p.key IN ('dailyBudgetUsd', 'monthlyBudgetUsd')
         )
         OR EXISTS (
           SELECT 1 FROM items i
            WHERE i.database_id = d.id AND (i.properties ? 'dailyBudgetUsd' OR i.properties ? 'monthlyBudgetUsd')
         )
       )
  LOOP
    -- Same unlock/write/relock sequence 0019 uses: a system database's schema may only be
    -- changed by a code-level migration with direct database access, never through the choke point.
    UPDATE databases SET schema_locked = false WHERE id = settings_db_id;

    DELETE FROM properties WHERE database_id = settings_db_id AND key IN ('dailyBudgetUsd', 'monthlyBudgetUsd');

    UPDATE items
       SET properties = properties - 'dailyBudgetUsd' - 'monthlyBudgetUsd'
     WHERE database_id = settings_db_id
       AND (properties ? 'dailyBudgetUsd' OR properties ? 'monthlyBudgetUsd');

    UPDATE databases SET schema_locked = true WHERE id = settings_db_id;
  END LOOP;
END $$;
