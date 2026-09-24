-- Expand: the previous release never names summary, so its INSERTs leave it NULL.
ALTER TABLE notes ADD COLUMN summary text;
