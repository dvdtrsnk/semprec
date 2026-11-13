-- Issue #1907: why a Semp reply failed. `error_code` (added in 0139, written only as 'interrupted' until now)
-- becomes one of the closed agent run error codes of 0104, and `error_params` holds the plain object of ids and
-- counters that go with it: { connectorName?, failedStep?: { key, params }, timeoutMs? }, never user content or
-- exception text.
--
-- Additive and rollback-safe: a nullable column and two constraints that every row already satisfies (an existing
-- row has no code or the code 'interrupted'). A previous release keeps closing messages with no code or with
-- 'interrupted', both of which the check allows. A failed message with a NULL code reads as 'internal'.
-- Step 1 of 2: the constraints are added NOT VALID, so adding them scans nothing. The migration runs in one
-- transaction, so the ACCESS EXCLUSIVE lock of the ALTER TABLE statements below is held until it commits; this
-- file therefore holds no scan, and 0161 validates the constraints under SHARE UPDATE EXCLUSIVE.
ALTER TABLE semp_messages ADD COLUMN error_params jsonb;
ALTER TABLE semp_messages ADD CONSTRAINT semp_messages_error_code_check
  CHECK (error_code IS NULL OR error_code IN ('budgetExceeded', 'modelError', 'cancelled', 'interrupted', 'internal')) NOT VALID;
ALTER TABLE semp_messages ADD CONSTRAINT semp_messages_error_params_check
  CHECK (error_params IS NULL OR jsonb_typeof(error_params) = 'object') NOT VALID;
