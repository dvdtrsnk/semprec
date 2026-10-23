-- Relaxing a constraint only accepts more rows than the previous release ever writes.
ALTER TABLE notes ALTER COLUMN title DROP NOT NULL;
