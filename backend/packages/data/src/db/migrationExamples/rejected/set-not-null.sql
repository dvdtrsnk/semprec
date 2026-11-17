-- The previous release's INSERTs do not name legacy_color, so they would now fail.
ALTER TABLE notes ALTER COLUMN legacy_color SET NOT NULL;
