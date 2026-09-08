-- `runPropertyTypeMigrationJob` decided a retype's final `migration_status` from a
-- run-local `anyFailures` flag. That flag cannot survive the two ways the job is
-- legitimately executed more than once for a single retype:
--
--   * graphile-worker retries the task after a crash mid-run;
--   * two runs overlap (the job is explicitly documented as replay-safe).
--
-- A second pass skips every row the first pass already handled — a converted value via
-- `isAlreadyTargetType`, a dropped value because its key is no longer in `properties`.
-- So the second run always ends with `anyFailures === false` and writes 'done' over the
-- first run's 'partial', permanently losing the record that values were discarded.
--
-- The fact "this retype dropped at least one unconvertible value" belongs to the retype,
-- not to whichever run observed it, so it lives here. Boolean rather than a counter
-- because concurrent runs can both drop the same cell, which would inflate a count while
-- the only question ever asked of it is `> 0`.
ALTER TABLE properties
  ADD COLUMN migration_dropped_values boolean NOT NULL DEFAULT false;
