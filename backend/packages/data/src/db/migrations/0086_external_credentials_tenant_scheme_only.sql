-- expand-contract-exemption: contract step — the previous release (the strict release confirmed by #1068) writes only `tenant` credentials, and its sweep re-sealed every `master` row.
--
-- Issue #1069, the contract step of the per-tenant credential encryption
-- (docs/adr/2026-10-05-per-tenant-envelope-encryption.md). Since #1060 every credential write seals
-- under the tenant's data key (`scheme = 'tenant'`, bound to tenant_id‖item_id), and #1062's
-- `credentialReencryptSweep` re-sealed the remaining master-key-only rows. This release no longer
-- reads `master` rows, so the constraint below forbids them.
--
-- The constraint is validated as it is added: if any `master` row still exists, this migration, and
-- with it the deploy, fails before the new code starts, so no secret is stranded. The column's
-- `master` default stays in place: an insert that omits `scheme` now fails the check (fail-closed).
ALTER TABLE external_credentials
  ADD CONSTRAINT external_credentials_scheme_tenant_only CHECK (scheme = 'tenant');

-- The retired sweep has no handler any more, so a queued job of it would never be fetched again and
-- would show up as a queue backlog. Complete it through graphile-worker's public `complete_jobs`, as
-- queueFailedJobsPrune.ts does. On a fresh install the graphile_worker schema does not exist yet at
-- migration time, and there is nothing to complete.
DO $$
BEGIN
  IF to_regnamespace('graphile_worker') IS NOT NULL THEN
    PERFORM graphile_worker.complete_jobs(ARRAY(
      SELECT id FROM graphile_worker.jobs
       WHERE task_identifier = 'credentialReencryptSweep' AND locked_at IS NULL
    ));
  END IF;
END $$;
