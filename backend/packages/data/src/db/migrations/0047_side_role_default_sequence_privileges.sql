-- 0040 granted `semprec_side` USAGE/SELECT on every sequence that existed when it ran. That grant
-- is a point-in-time snapshot: a later migration adding a `bigserial` column to a side table
-- would need its own sequence grant, which nobody would think to add, and `semprec_side` inserts
-- into that table would fail at runtime with a privilege error instead of at review time.
--
-- Default privileges close that gap for every sequence the migrating role creates from now on.
-- Mirrors grantQueueSchemaPrivileges's ALTER DEFAULT PRIVILEGES for the graphile_worker schema
-- (packages/queue/src/index.ts), applied to the public schema. Additive only: no existing grant
-- changes, so the previous release keeps working against this schema after a rollback.
--
-- This was written as a review fix for #243 and pushed seconds after that pull request (#420)
-- had already merged, so it never reached develop; 0040 is applied and is not edited in place.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO semprec_side;
